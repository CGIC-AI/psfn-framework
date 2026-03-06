import { randomUUID } from 'node:crypto';
import type {
  LLMContext,
  SessionRestartBehavior,
  SubstrateConfig,
  TurnRecord,
} from '../types.js';
import type { LLMProvider } from '../agent/contracts.js';
import type {
  SessionStore,
  SessionActivitySummary,
  LegacyChatImportRequest,
  LegacyChatImportResult,
  LegacyChatImportRange,
} from './store.js';
import type { UserContinuityStore } from './continuity.js';
import type { SessionEntry } from './types.js';
import type { SessionSearchHit } from './search-index.js';
import type { EventBus } from '../event-bus.js';
import { classifyChannel, type ChannelMeta } from '../trust/policy.js';
import {
  COMPACTION_SUMMARY_PROMPT_KEY,
  getDefaultPromptText,
  type PromptRegistryStore,
} from '../identity/prompt-registry.js';
import {
  markCompactionSummaryAsUntrustedRecord,
  wrapCompactionSummaryAsUntrustedContext,
} from '../identity/prompt-composer.js';
import {
  resolveAdaptiveContextBudgetProfile,
  resolveSessionHistoryBudget,
  type ContextBudgetTurnCharacteristics,
} from '../context-budget.js';
import {
  DEFAULT_CONTINUITY_CONTEXT_LIMIT,
  trimRecentEntriesToTokenBudget,
  type SessionMessageRecordOptions,
} from './manager-primitives.js';
import {
  bootstrapImportedHistory,
  type ImportedHistoryBootstrapChunk,
  type ImportedHistoryBootstrapResult,
} from './manager/import-bootstrap.js';
import {
  mirrorMessageToActiveSessions,
} from './manager/mirroring.js';
import {
  buildSessionContext,
} from './manager/context-builder.js';
import { buildSessionMetadataWithTurn } from './turn-provenance.js';
import type {
  PreCompactionExtractionContext,
  PreCompactionExtractionHandler,
} from './manager/contracts.js';
import type { TurnSessionContextSnapshot } from '../turns/snapshot.js';
import {
  buildSnapshotVersionPointer,
  cloneSessionEntry,
} from '../turns/snapshot.js';
import { getMergedContinuity } from './manager/context-support.js';
import {
  buildToolObservationMetadata,
  normalizeToolObservation,
  type ToolObservationInput,
} from './tool-observation.js';
import type { ContextManifestMemorySeed } from './context-manifest.js';

export type {
  ImportedHistoryBootstrapChunk,
  ImportedHistoryBootstrapResult,
  PreCompactionExtractionContext,
  PreCompactionExtractionHandler,
};

const INTERNAL_REFLECTION_CHANNEL_PREFIX = 'internal:reflection:';

function shouldPersistSessionChannel(channelId: string): boolean {
  return !channelId.startsWith(INTERNAL_REFLECTION_CHANNEL_PREFIX);
}

function createCompactionBoundaryStore(store: SessionStore): SessionStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'insertCompaction') {
        return (channelId: string, summary: string, coveredUpTo: number): void => {
          target.insertCompaction(
            channelId,
            markCompactionSummaryAsUntrustedRecord(summary),
            coveredUpTo,
          );
        };
      }

      if (property === 'getCompactionSummaries') {
        return (channelId: string) => (
          target.getCompactionSummaries(channelId).map(summary => ({
            ...summary,
            summary: wrapCompactionSummaryAsUntrustedContext(summary.summary),
          }))
        );
      }

      const value = Reflect.get(target, property, receiver);
      if (typeof value === 'function') {
        return value.bind(target);
      }
      return value;
    },
  }) as SessionStore;
}

export interface LegacyChatImportRunRequest extends LegacyChatImportRequest {
  canonicalContactId?: string;
  bootstrap?: boolean;
  bootstrapMaxChunkTokens?: number;
}

export interface LegacyChatImportRunResult {
  importResult: LegacyChatImportResult;
  bootstrapResult: ImportedHistoryBootstrapResult | null;
}

export interface StartupSessionMetadata {
  sessionId: string;
  channelType?: string;
  timestamp: number;
}

export class SessionManager {
  private store: SessionStore;
  private compactionBoundaryStore: SessionStore;
  private config: SubstrateConfig;
  private eventBus: EventBus | null;
  private promptRegistry: PromptRegistryStore | null;
  private preCompactionExtractionHandler: PreCompactionExtractionHandler | null;
  private activeContextSessionId: string | null = null;
  continuityStore: UserContinuityStore | null = null;
  /** Character name from identity card (e.g. 'Companion'). Used for display labels in context. */
  characterName: string | undefined;

  constructor(
    store: SessionStore,
    config: SubstrateConfig,
    eventBus?: EventBus,
    promptRegistry?: PromptRegistryStore | null,
  ) {
    this.store = store;
    this.compactionBoundaryStore = createCompactionBoundaryStore(store);
    this.config = config;
    this.eventBus = eventBus ?? null;
    this.promptRegistry = promptRegistry ?? null;
    this.preCompactionExtractionHandler = null;
  }

  private shouldOverrideSessionContext(channelId: string): boolean {
    return channelId.startsWith('api:') || channelId.startsWith('terminal:');
  }

  resolveSessionChannelId(channelId: string): string {
    if (!this.activeContextSessionId) return channelId;
    if (!this.shouldOverrideSessionContext(channelId)) return channelId;
    return this.activeContextSessionId;
  }

  setActiveContextSession(sessionId: string | null): void {
    const normalized = sessionId?.trim();
    this.activeContextSessionId = normalized ? normalized : null;
  }

  getActiveContextSession(): string | null {
    return this.activeContextSessionId;
  }

  listRecentSessions(limit?: number): SessionActivitySummary[] {
    if (limit === undefined) {
      return this.store.listSessionsByRecentActivity();
    }
    return this.store.listSessionsByRecentActivity(limit);
  }

  getSessionActivity(sessionId: string): SessionActivitySummary | null {
    return this.store.getSessionActivity(sessionId);
  }

  recordUserMessage(
    channelId: string,
    content: string,
    authorId: string,
    authorName: string,
    isDirectMessage?: boolean,
    continuityUserId?: string,
    options: SessionMessageRecordOptions = {},
  ): number | null {
    const resolvedChannelId = this.resolveSessionChannelId(channelId);
    if (!shouldPersistSessionChannel(resolvedChannelId)) return null;
    const meta = isDirectMessage != null ? { isDirectMessage } : undefined;
    const channelVisibility = classifyChannel(resolvedChannelId, meta);
    const timestamp = Date.now();
    const metadata = options.turnId
      ? buildSessionMetadataWithTurn(undefined, {
        turnId: options.turnId,
        requestId: options.requestId ?? options.sourceMessageId ?? options.turnId,
        sourceMessageId: options.sourceMessageId,
        role: 'user',
      })
      : undefined;
    const entryId = this.store.append({
      channelId: resolvedChannelId,
      role: 'user',
      content,
      authorId,
      authorName,
      timestamp,
      channelVisibility,
      ...(metadata ? { metadata } : {}),
    });

    const continuityKey = continuityUserId ?? authorId;
    if (this.continuityStore && continuityKey) {
      this.continuityStore.append(continuityKey, {
        channelId: resolvedChannelId,
        role: 'user',
        content,
        authorId,
        authorName,
        timestamp,
        originChannelId: resolvedChannelId,
        channelVisibility,
        ...(metadata ? { metadata } : {}),
      });
    }

    this.mirrorMessageToActiveSessions({
      continuityKey,
      sourceChannelId: resolvedChannelId,
      sourceVisibility: channelVisibility,
      sourceRole: 'user',
      sourceAuthorName: authorName,
      content,
      trustLevel: options.trustLevel ?? 'regular',
      timestamp,
      mirrorEnabled: options.mirror !== false,
    });
    return entryId;
  }

  recordAssistantMessage(
    channelId: string,
    content: string,
    forUserId?: string,
    isDirectMessage?: boolean,
    continuityUserId?: string,
    options: SessionMessageRecordOptions = {},
  ): number | null {
    const resolvedChannelId = this.resolveSessionChannelId(channelId);
    if (!shouldPersistSessionChannel(resolvedChannelId)) return null;
    const meta = isDirectMessage != null ? { isDirectMessage } : undefined;
    const channelVisibility = classifyChannel(resolvedChannelId, meta);
    const timestamp = Date.now();
    const metadata = options.turnId
      ? buildSessionMetadataWithTurn(undefined, {
        turnId: options.turnId,
        requestId: options.requestId ?? options.sourceMessageId ?? options.turnId,
        sourceMessageId: options.sourceMessageId,
        role: 'assistant',
      })
      : undefined;
    const entryId = this.store.append({
      channelId: resolvedChannelId,
      role: 'assistant',
      content,
      timestamp,
      channelVisibility,
      ...(metadata ? { metadata } : {}),
    });

    const continuityKey = continuityUserId ?? forUserId;
    if (this.continuityStore && continuityKey) {
      this.continuityStore.append(continuityKey, {
        channelId: resolvedChannelId,
        role: 'assistant',
        content,
        timestamp,
        originChannelId: resolvedChannelId,
        channelVisibility,
        ...(metadata ? { metadata } : {}),
      });
    }

    this.mirrorMessageToActiveSessions({
      continuityKey,
      sourceChannelId: resolvedChannelId,
      sourceVisibility: channelVisibility,
      sourceRole: 'assistant',
      content,
      trustLevel: options.trustLevel ?? 'regular',
      timestamp,
      mirrorEnabled: options.mirror !== false,
    });
    return entryId;
  }

  recordToolObservation(
    channelId: string,
    observation: ToolObservationInput,
    isDirectMessage?: boolean,
    options: SessionMessageRecordOptions = {},
  ): number | null {
    const resolvedChannelId = this.resolveSessionChannelId(channelId);
    if (!shouldPersistSessionChannel(resolvedChannelId)) return null;
    const meta = isDirectMessage != null ? { isDirectMessage } : undefined;
    const channelVisibility = classifyChannel(resolvedChannelId, meta);
    const timestamp = Date.now();
    const turnMetadata = options.turnId
      ? buildSessionMetadataWithTurn(undefined, {
        turnId: options.turnId,
        requestId: options.requestId ?? options.sourceMessageId ?? options.turnId,
        sourceMessageId: options.sourceMessageId,
        role: 'tool',
      })
      : undefined;
    const normalizedObservation = normalizeToolObservation(observation);
    const metadata = buildToolObservationMetadata(
      turnMetadata,
      normalizedObservation.metadata,
    );

    return this.store.append({
      channelId: resolvedChannelId,
      role: 'tool',
      content: normalizedObservation.content,
      authorId: `tool:${normalizedObservation.metadata.toolName}`,
      authorName: normalizedObservation.metadata.toolName,
      timestamp,
      channelVisibility,
      metadata,
    });
  }

  recordTurn(record: TurnRecord): void {
    this.store.appendTurnRecord(record);
  }

  private mirrorMessageToActiveSessions(params: {
    continuityKey?: string;
    sourceChannelId: string;
    sourceVisibility: import('../trust/types.js').ChannelVisibility;
    sourceRole: 'user' | 'assistant';
    sourceAuthorName?: string;
    content: string;
    trustLevel: import('../trust/types.js').TrustLevel;
    timestamp: number;
    mirrorEnabled: boolean;
  }): void {
    mirrorMessageToActiveSessions({
      config: this.config,
      store: this.store,
      continuityStore: this.continuityStore,
      characterName: this.characterName,
      ...params,
    });
  }

  async buildContext(
    channelId: string,
    systemPrompt: string,
    memoriesBlock: string,
    llmProvider?: LLMProvider,
    userId?: string,
    channelMeta?: ChannelMeta,
    continuityFallbackUserIds: string[] = [],
    turnSnapshot?: TurnSessionContextSnapshot,
    memoryManifestSeed?: ContextManifestMemorySeed,
    turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics,
  ): Promise<LLMContext> {
    const resolvedChannelId = this.resolveSessionChannelId(channelId);
    return buildSessionContext({
      channelId: resolvedChannelId,
      systemPrompt,
      memoriesBlock,
      llmProvider,
      userId,
      channelMeta,
      continuityFallbackUserIds,
      store: this.compactionBoundaryStore,
      config: this.config,
      eventBus: this.eventBus,
      promptRegistry: this.promptRegistry,
      preCompactionExtractionHandler: this.preCompactionExtractionHandler,
      continuityStore: this.continuityStore,
      characterName: this.characterName,
      turnSnapshot,
      memoryManifestSeed,
      turnBudgetCharacteristics,
    });
  }

  captureTurnContextSnapshot(
    channelId: string,
    userId?: string,
    channelMeta?: ChannelMeta,
    continuityFallbackUserIds: string[] = [],
    turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics,
  ): TurnSessionContextSnapshot {
    const resolvedChannelId = this.resolveSessionChannelId(channelId);
    const adaptiveProfile = resolveAdaptiveContextBudgetProfile(
      this.config,
      turnBudgetCharacteristics,
    );
    const historyBudget = resolveSessionHistoryBudget(this.config, {
      adaptiveProfile,
    });
    let recent = this.compactionBoundaryStore.getRecent(resolvedChannelId, historyBudget.estimatedCount);
    if (historyBudget.mode === 'budget') {
      recent = trimRecentEntriesToTokenBudget(recent, historyBudget.tokenBudget);
    }

    const continuityEntries = userId && this.continuityStore
      ? getMergedContinuity({
        continuityStore: this.continuityStore,
        canonicalUserId: userId,
        limit: this.config.continuityMessageLimit ?? DEFAULT_CONTINUITY_CONTEXT_LIMIT,
        fallbackUserIds: continuityFallbackUserIds,
        channelId: resolvedChannelId,
        channelMeta,
      })
      : [];
    const compactionSummaryTexts = this.compactionBoundaryStore
      .getCompactionSummaries(resolvedChannelId)
      .map(summary => summary.summary);
    const compactionPromptText = this.promptRegistry?.getPrompt(COMPACTION_SUMMARY_PROMPT_KEY)
      ?? getDefaultPromptText(COMPACTION_SUMMARY_PROMPT_KEY);

    return {
      channelId: resolvedChannelId,
      recentEntries: recent.map(cloneSessionEntry),
      compactionSummaryTexts: [...compactionSummaryTexts],
      continuityEntries: continuityEntries.map(cloneSessionEntry),
      compactionPromptText,
      versionPointer: buildSnapshotVersionPointer([
        resolvedChannelId,
        recent.at(-1)?.id,
        recent.at(-1)?.timestamp,
        compactionSummaryTexts.join('\n'),
        continuityEntries.at(-1)?.id,
        continuityEntries.at(-1)?.timestamp,
        compactionPromptText,
      ]),
    };
  }

  /** Append a system note to a session. Visible in subsequent context builds. */
  appendSystemNote(channelId: string, note: string): void {
    const resolvedChannelId = this.resolveSessionChannelId(channelId);
    if (!shouldPersistSessionChannel(resolvedChannelId)) return;
    this.store.append({
      channelId: resolvedChannelId,
      role: 'system',
      content: note,
      authorId: 'system',
      authorName: 'System',
      timestamp: Date.now(),
    });
  }

  setPreCompactionExtractionHandler(handler: PreCompactionExtractionHandler | null): void {
    this.preCompactionExtractionHandler = handler;
  }

  async importLegacyChatFromFile(request: LegacyChatImportRunRequest): Promise<LegacyChatImportRunResult> {
    const importResult = this.store.importLegacyChatFromFile(request);
    const shouldBootstrap = request.bootstrap !== false;
    if (!shouldBootstrap || importResult.manifest.importedRecordCount === 0) {
      return {
        importResult,
        bootstrapResult: null,
      };
    }

    const bootstrapResult = await this.bootstrapImportedHistory({
      channelId: request.channelId,
      entryRanges: importResult.manifest.entryRanges,
      canonicalContactId: request.canonicalContactId,
      maxChunkTokens: request.bootstrapMaxChunkTokens,
    });

    return {
      importResult,
      bootstrapResult,
    };
  }

  async bootstrapImportedHistory(params: {
    channelId: string;
    entryRanges: LegacyChatImportRange[];
    canonicalContactId?: string;
    maxChunkTokens?: number;
  }): Promise<ImportedHistoryBootstrapResult> {
    return bootstrapImportedHistory({
      store: this.store,
      channelId: params.channelId,
      entryRanges: params.entryRanges,
      canonicalContactId: params.canonicalContactId,
      maxChunkTokens: params.maxChunkTokens,
      preCompactionExtractionHandler: this.preCompactionExtractionHandler,
    });
  }

  getRecentMessages(channelId: string, limit?: number): SessionEntry[] {
    const resolvedChannelId = this.resolveSessionChannelId(channelId);
    if (limit !== undefined) {
      return this.store.getRecent(resolvedChannelId, limit);
    }

    const historyBudget = resolveSessionHistoryBudget(this.config);
    const recent = this.store.getRecent(resolvedChannelId, historyBudget.estimatedCount);
    if (historyBudget.mode === 'hard_limit') {
      return recent;
    }
    return trimRecentEntriesToTokenBudget(recent, historyBudget.tokenBudget);
  }

  getMessageCount(channelId: string): number {
    const resolvedChannelId = this.resolveSessionChannelId(channelId);
    return this.store.count(resolvedChannelId);
  }

  searchTranscripts(query: string, limit?: number): SessionSearchHit[] {
    return this.store.searchByKeywords(query, limit);
  }

  resolveStartupSessionMetadata(
    behavior: SessionRestartBehavior = 'reuse_latest_session',
  ): StartupSessionMetadata | null {
    if (behavior === 'new_session') {
      const timestamp = Date.now();
      return {
        sessionId: `api:restart-${timestamp.toString(36)}-${randomUUID().slice(0, 8)}`,
        channelType: 'api',
        timestamp,
      };
    }

    const latest = this.store.getLatestSessionByTimestamp();
    if (!latest || this.store.count(latest.sessionId) <= 0) return null;
    return {
      sessionId: latest.sessionId,
      channelType: latest.channelType,
      timestamp: latest.timestamp,
    };
  }
}
