import { randomUUID } from 'node:crypto';
import type { LLMContext, SubstrateConfig } from '../types.js';
import type { SessionRestartBehavior } from '../types.js';
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
import type { PromptRegistryStore } from '../identity/prompt-registry.js';
import { resolveSessionHistoryBudget } from '../context-budget.js';
import {
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
import type {
  PreCompactionExtractionContext,
  PreCompactionExtractionHandler,
} from './manager/contracts.js';

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
  private config: SubstrateConfig;
  private eventBus: EventBus | null;
  private promptRegistry: PromptRegistryStore | null;
  private preCompactionExtractionHandler: PreCompactionExtractionHandler | null;
  private activeContextSessionId: string | null = null;
  continuityStore: UserContinuityStore | null = null;
  /** Character name from identity card (e.g. 'PSFN'). Used for display labels in context. */
  characterName: string | undefined;

  constructor(
    store: SessionStore,
    config: SubstrateConfig,
    eventBus?: EventBus,
    promptRegistry?: PromptRegistryStore | null,
  ) {
    this.store = store;
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
  ): void {
    const resolvedChannelId = this.resolveSessionChannelId(channelId);
    if (!shouldPersistSessionChannel(resolvedChannelId)) return;
    const meta = isDirectMessage != null ? { isDirectMessage } : undefined;
    const channelVisibility = classifyChannel(resolvedChannelId, meta);
    const timestamp = Date.now();
    this.store.append({
      channelId: resolvedChannelId,
      role: 'user',
      content,
      authorId,
      authorName,
      timestamp,
      channelVisibility,
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
  }

  recordAssistantMessage(
    channelId: string,
    content: string,
    forUserId?: string,
    isDirectMessage?: boolean,
    continuityUserId?: string,
    options: SessionMessageRecordOptions = {},
  ): void {
    const resolvedChannelId = this.resolveSessionChannelId(channelId);
    if (!shouldPersistSessionChannel(resolvedChannelId)) return;
    const meta = isDirectMessage != null ? { isDirectMessage } : undefined;
    const channelVisibility = classifyChannel(resolvedChannelId, meta);
    const timestamp = Date.now();
    this.store.append({
      channelId: resolvedChannelId,
      role: 'assistant',
      content,
      timestamp,
      channelVisibility,
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
      store: this.store,
      config: this.config,
      eventBus: this.eventBus,
      promptRegistry: this.promptRegistry,
      preCompactionExtractionHandler: this.preCompactionExtractionHandler,
      continuityStore: this.continuityStore,
      characterName: this.characterName,
    });
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
