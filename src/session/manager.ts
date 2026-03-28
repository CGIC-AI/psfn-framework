import { randomUUID } from 'node:crypto';
import type {
  LLMContext,
  SessionRestartBehavior,
  SubstrateConfig,
  TurnRecord,
} from '../types.js';
import type { MemoryScopeQuery } from '../memory/types.js';
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
import type { EventBus } from '../shared/event-bus.js';
import type { InternalRoleEnvelopeLedger } from '../internal-role-envelopes/types.js';
import { classifyChannel, type ChannelMeta } from '../trust/policy.js';
import { countTokens } from '../llm/tokens.js';
import { createComponentLogger } from '../logger.js';
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
  collectRecentEntriesWithinTokenBudget,
  DEFAULT_CONTINUITY_CONTEXT_LIMIT,
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
  DEFAULT_OBSERVATION_MASKING_WINDOW,
  applyObservationMasking,
} from './manager/context-builder.js';
import {
  buildSessionMetadataWithTurn,
  buildSessionMetadataWithRoleEnvelopePreview,
  resolveSessionEntryRoleEnvelopePreview,
} from './turn-provenance.js';
import type {
  PreCompactionExtractionContext,
  PreCompactionExtractionHandler,
} from './manager/contracts.js';
import { runAutoCompaction } from './manager/compaction-service.js';
import type { TurnSessionContextSnapshot } from '../turns/snapshot.js';
import {
  buildSnapshotVersionPointer,
  cloneSessionEntry,
} from '../turns/snapshot.js';
import {
  countIntentionAppraisalArtifacts,
  getMergedContinuity,
} from './manager/context-support.js';
import {
  buildToolObservationMetadata,
  normalizeToolObservation,
  type ToolObservationInput,
} from './tool-observation.js';
import type { ContextManifestMemorySeed } from './context-manifest.js';
import {
  applyFocusCompactionRanges,
  FocusKnowledgeStore,
  buildFocusMemoryScopeQuery,
  normalizeFocusEvidence,
  type FocusEvidenceRecord,
  type FocusKnowledgeBlock,
  type FocusProjectContextSummary,
} from './focus-knowledge.js';
import {
  resolveCompressionFailureLogPath,
  resolveCompressionGuidelinePath,
  resolveConfiguredCompanionDataDir,
  resolveFocusKnowledgePath,
} from '../persistence/layout.js';
import {
  CompressionFailureLogStore,
  CompressionGuidelineRuntime,
  CompressionGuidelineStore,
  type CompressionGuidelineUpdateResult,
} from './compression-guideline.js';
import { resolveRoleEnvelopeRef } from '../internal-role-envelopes/projections.js';

export type {
  ImportedHistoryBootstrapChunk,
  ImportedHistoryBootstrapResult,
  PreCompactionExtractionContext,
  PreCompactionExtractionHandler,
};

const INTERNAL_REFLECTION_CHANNEL_PREFIX = 'internal:reflection:';
const log = createComponentLogger('SessionManager');

function shouldPersistSessionChannel(channelId: string): boolean {
  return !channelId.startsWith(INTERNAL_REFLECTION_CHANNEL_PREFIX);
}

function createCompactionBoundaryStore(store: SessionStore): SessionStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'getRecent') {
        return (channelId: string, limit: number): SessionEntry[] => {
          const normalizedLimit = Math.max(0, Math.floor(limit));
          if (normalizedLimit <= 0) return [];
          const compactions = target.getCompactionSummaries(channelId);
          const coveredUpTo = compactions.reduce(
            (maxCoveredUpTo, summary) => Math.max(maxCoveredUpTo, summary.coveredUpTo),
            0,
          );
          if (coveredUpTo <= 0) {
            return target.getRecent(channelId, normalizedLimit);
          }
          const entries = target.getEntriesInRange(
            channelId,
            coveredUpTo + 1,
            Number.MAX_SAFE_INTEGER,
          );
          if (entries.length <= normalizedLimit) {
            return entries;
          }
          return entries.slice(-normalizedLimit);
        };
      }

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

export interface SessionCoreMemoryProvider {
  formatForContext(): string;
}

export interface AutoCompactionBetweenTurnsParams {
  channelId: string;
  systemPrompt: string;
  memoriesBlock: string;
  llmProvider: LLMProvider;
  userId?: string;
  channelMeta?: ChannelMeta;
  compactionPromptText?: string;
  turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics;
}

interface ActiveFocusSession {
  focusId: string;
  channelId: string;
  scope: string;
  startedAt: number;
  startEntryId: number;
  evidence: FocusEvidenceRecord[];
}

export interface FocusSessionSnapshot {
  focusId: string;
  channelId: string;
  scope: string;
  startedAt: number;
  startEntryId: number;
  evidenceCount: number;
  existingProjectContext: FocusProjectContextSummary | null;
}

export interface FocusSessionContextSnapshot {
  session: FocusSessionSnapshot;
  rangeStartId: number;
  rangeEndId: number;
  entries: SessionEntry[];
  evidence: FocusEvidenceRecord[];
}

export interface FocusSessionCompletionResult {
  focusId: string;
  channelId: string;
  scope: string;
  rangeStartId: number | null;
  rangeEndId: number | null;
  knowledgeBlock: FocusKnowledgeBlock;
  projectContext: FocusProjectContextSummary;
}

const MAX_ACTIVE_FOCUS_EVIDENCE_ITEMS = 64;
export class SessionManager {
  private store: SessionStore;
  private compactionBoundaryStore: SessionStore;
  private config: SubstrateConfig;
  private eventBus: EventBus | null;
  private promptRegistry: PromptRegistryStore | null;
  private focusKnowledgeStore: FocusKnowledgeStore;
  private compressionGuidelineRuntime: CompressionGuidelineRuntime;
  private preCompactionExtractionHandler: PreCompactionExtractionHandler | null;
  private coreMemoryProvider: SessionCoreMemoryProvider | null;
  private internalRoleEnvelopeLedger: InternalRoleEnvelopeLedger | null;
  private activeContextSessionId: string | null = null;
  private activeFocusSessions: Map<string, ActiveFocusSession> = new Map();
  private pendingAutoCompactions = new Map<string, Promise<void>>();
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
    const companionDataDir = resolveConfiguredCompanionDataDir(config);
    this.focusKnowledgeStore = new FocusKnowledgeStore(resolveFocusKnowledgePath(companionDataDir));
    this.compressionGuidelineRuntime = new CompressionGuidelineRuntime(
      new CompressionGuidelineStore(resolveCompressionGuidelinePath(companionDataDir)),
      new CompressionFailureLogStore(resolveCompressionFailureLogPath(companionDataDir)),
    );
    this.preCompactionExtractionHandler = null;
    this.coreMemoryProvider = null;
    this.internalRoleEnvelopeLedger = null;
  }

  private resolveCompactionPromptText(basePrompt: string): string {
    return this.compressionGuidelineRuntime.buildCompactionPrompt(basePrompt);
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

  async awaitPendingAutoCompaction(channelId: string): Promise<void> {
    const resolvedChannelId = this.resolveSessionChannelId(channelId);
    const pending = this.pendingAutoCompactions.get(resolvedChannelId);
    if (!pending) return;
    await pending;
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

  private toFocusSessionSnapshot(session: ActiveFocusSession): FocusSessionSnapshot {
    return {
      focusId: session.focusId,
      channelId: session.channelId,
      scope: session.scope,
      startedAt: session.startedAt,
      startEntryId: session.startEntryId,
      evidenceCount: session.evidence.length,
      existingProjectContext: this.focusKnowledgeStore.getProjectContextSummary(
        session.channelId,
        session.scope,
      ),
    };
  }

  private resolveFocusChannelId(channelId: string): string {
    const normalized = channelId.trim();
    if (!normalized) {
      throw new Error('focus session requires a non-empty channelId');
    }
    return this.resolveSessionChannelId(normalized);
  }

  private normalizeFocusScope(scope: string): string {
    const normalized = scope.replace(/\s+/g, ' ').trim();
    if (!normalized) {
      throw new Error('focus scope must be non-empty');
    }
    return normalized;
  }

  private getFocusKnowledgeTexts(channelId: string): string[] {
    return this.focusKnowledgeStore
      .listProjectContextsByChannel(channelId)
      .map((summary) => {
        const projectContextSuffix = summary.knowledgeBlockCount > 1
          ? ` (project context with ${summary.knowledgeBlockCount} distilled blocks, ${summary.totalEvidenceCount} evidence items)`
          : '';
        return `[${summary.scope}] ${summary.latestKnowledge}${projectContextSuffix}`;
      });
  }

  getProjectContextSummary(channelId: string, scope: string): FocusProjectContextSummary | null {
    const resolvedChannelId = this.resolveFocusChannelId(channelId);
    return this.focusKnowledgeStore.getProjectContextSummary(resolvedChannelId, scope);
  }

  getActiveFocusMemoryScopeQuery(channelId: string): MemoryScopeQuery | null {
    const active = this.getActiveFocusSession(channelId);
    if (!active) return null;
    return buildFocusMemoryScopeQuery(active.scope);
  }

  private getFocusCompactionRanges(channelId: string) {
    return this.focusKnowledgeStore.getCompactionRanges(channelId);
  }

  startFocusSession(channelId: string, scope: string): FocusSessionSnapshot {
    const resolvedChannelId = this.resolveFocusChannelId(channelId);
    if (this.activeFocusSessions.has(resolvedChannelId)) {
      throw new Error(`focus session already active for channel "${resolvedChannelId}"`);
    }

    const normalizedScope = this.normalizeFocusScope(scope);
    const now = Date.now();
    const startEntryId = this.store.getLastEntry(resolvedChannelId)?.id ?? 0;
    const session: ActiveFocusSession = {
      focusId: `focus-${now.toString(36)}-${randomUUID().slice(0, 8)}`,
      channelId: resolvedChannelId,
      scope: normalizedScope,
      startedAt: now,
      startEntryId,
      evidence: [],
    };
    this.activeFocusSessions.set(resolvedChannelId, session);
    return this.toFocusSessionSnapshot(session);
  }

  getActiveFocusSession(channelId: string): FocusSessionSnapshot | null {
    const resolvedChannelId = this.resolveFocusChannelId(channelId);
    const active = this.activeFocusSessions.get(resolvedChannelId);
    return active ? this.toFocusSessionSnapshot(active) : null;
  }

  recordFocusEvidence(channelId: string, evidence: ReadonlyArray<unknown>): number {
    const resolvedChannelId = this.resolveFocusChannelId(channelId);
    const active = this.activeFocusSessions.get(resolvedChannelId);
    if (!active || evidence.length === 0) {
      return 0;
    }

    const remainingSlots = Math.max(0, MAX_ACTIVE_FOCUS_EVIDENCE_ITEMS - active.evidence.length);
    if (remainingSlots === 0) {
      return 0;
    }

    const normalized = evidence
      .map((item) => normalizeFocusEvidence(item))
      .filter((item): item is FocusEvidenceRecord => item !== null)
      .slice(0, remainingSlots);
    if (normalized.length === 0) {
      return 0;
    }

    active.evidence.push(...normalized);
    return normalized.length;
  }

  getFocusSessionContext(channelId: string): FocusSessionContextSnapshot | null {
    const resolvedChannelId = this.resolveFocusChannelId(channelId);
    const active = this.activeFocusSessions.get(resolvedChannelId);
    if (!active) return null;

    const rangeStartId = active.startEntryId + 1;
    const rangeEndId = this.store.getLastEntry(resolvedChannelId)?.id ?? active.startEntryId;
    const entries = rangeEndId >= rangeStartId
      ? this.store.getEntriesInRange(resolvedChannelId, rangeStartId, rangeEndId)
      : [];

    return {
      session: this.toFocusSessionSnapshot(active),
      rangeStartId,
      rangeEndId,
      entries,
      evidence: [...active.evidence],
    };
  }

  completeFocusSession(channelId: string, knowledge: string): FocusSessionCompletionResult {
    const resolvedChannelId = this.resolveFocusChannelId(channelId);
    const active = this.activeFocusSessions.get(resolvedChannelId);
    if (!active) {
      throw new Error(`no active focus session for channel "${resolvedChannelId}"`);
    }

    const normalizedKnowledge = knowledge.replace(/\s+/g, ' ').trim();
    if (!normalizedKnowledge) {
      throw new Error('focus knowledge summary must be non-empty');
    }

    const context = this.getFocusSessionContext(resolvedChannelId);
    if (!context) {
      throw new Error(`no active focus session for channel "${resolvedChannelId}"`);
    }

    const rangeIsValid = context.rangeEndId >= context.rangeStartId;
    const knowledgeBlock = this.focusKnowledgeStore.append({
      channelId: resolvedChannelId,
      focusId: active.focusId,
      scope: active.scope,
      knowledge: normalizedKnowledge,
      startedAt: active.startedAt,
      completedAt: Date.now(),
      ...(rangeIsValid
        ? {
          rangeStartId: context.rangeStartId,
          rangeEndId: context.rangeEndId,
        }
        : {}),
      evidenceCount: active.evidence.length,
      evidence: active.evidence,
    });

    const projectContext = this.focusKnowledgeStore.getProjectContextSummary(
      resolvedChannelId,
      active.scope,
    );
    if (!projectContext) {
      throw new Error(`project context summary missing for focus scope "${active.scope}"`);
    }

    this.activeFocusSessions.delete(resolvedChannelId);
    return {
      focusId: active.focusId,
      channelId: resolvedChannelId,
      scope: active.scope,
      rangeStartId: rangeIsValid ? context.rangeStartId : null,
      rangeEndId: rangeIsValid ? context.rangeEndId : null,
      knowledgeBlock,
      projectContext,
    };
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
    const meta = options.channelMeta ?? (isDirectMessage != null ? { isDirectMessage } : undefined);
    const channelVisibility = classifyChannel(resolvedChannelId, meta);
    const timestamp = Date.now();
    const turnMetadata = options.turnId
      ? buildSessionMetadataWithTurn(options.metadata, {
        turnId: options.turnId,
        requestId: options.requestId ?? options.sourceMessageId ?? options.turnId,
        sourceMessageId: options.sourceMessageId,
        role: 'user',
      })
      : options.metadata;
    const metadata = options.roleEnvelopePreview
      ? buildSessionMetadataWithRoleEnvelopePreview(turnMetadata, options.roleEnvelopePreview)
      : turnMetadata;
    const continuityKey = continuityUserId ?? authorId;

    if (!shouldPersistSessionChannel(resolvedChannelId)) {
      if (
        this.continuityStore
        && continuityKey
        && resolvedChannelId.startsWith(INTERNAL_REFLECTION_CHANNEL_PREFIX)
      ) {
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
      return null;
    }

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
    const meta = options.channelMeta ?? (isDirectMessage != null ? { isDirectMessage } : undefined);
    const channelVisibility = classifyChannel(resolvedChannelId, meta);
    const timestamp = Date.now();
    const turnMetadata = options.turnId
      ? buildSessionMetadataWithTurn(options.metadata, {
        turnId: options.turnId,
        requestId: options.requestId ?? options.sourceMessageId ?? options.turnId,
        sourceMessageId: options.sourceMessageId,
        role: 'assistant',
      })
      : options.metadata;
    const metadata = options.roleEnvelopePreview
      ? buildSessionMetadataWithRoleEnvelopePreview(turnMetadata, options.roleEnvelopePreview)
      : turnMetadata;
    const continuityKey = continuityUserId ?? forUserId;

    if (!shouldPersistSessionChannel(resolvedChannelId)) {
      if (
        this.continuityStore
        && continuityKey
        && resolvedChannelId.startsWith(INTERNAL_REFLECTION_CHANNEL_PREFIX)
      ) {
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
      return null;
    }

    const entryId = this.store.append({
      channelId: resolvedChannelId,
      role: 'assistant',
      content,
      timestamp,
      channelVisibility,
      ...(metadata ? { metadata } : {}),
    });

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

  recordSystemMessage(
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
    const meta = options.channelMeta ?? (isDirectMessage != null ? { isDirectMessage } : undefined);
    const channelVisibility = classifyChannel(resolvedChannelId, meta);
    const timestamp = Date.now();
    const turnMetadata = options.turnId
      ? buildSessionMetadataWithTurn(options.metadata, {
        turnId: options.turnId,
        requestId: options.requestId ?? options.sourceMessageId ?? options.turnId,
        sourceMessageId: options.sourceMessageId,
        role: 'system',
      })
      : options.metadata;
    const metadata = options.roleEnvelopePreview
      ? buildSessionMetadataWithRoleEnvelopePreview(turnMetadata, options.roleEnvelopePreview)
      : turnMetadata;
    const entryId = this.store.append({
      channelId: resolvedChannelId,
      role: 'system',
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
        role: 'system',
        content,
        authorId,
        authorName,
        timestamp,
        originChannelId: resolvedChannelId,
        channelVisibility,
        ...(metadata ? { metadata } : {}),
      });
    }

    return entryId;
  }

  scheduleAutoCompactionBetweenTurns(params: AutoCompactionBetweenTurnsParams): Promise<void> {
    const resolvedChannelId = this.resolveSessionChannelId(params.channelId);
    if (!shouldPersistSessionChannel(resolvedChannelId)) {
      return Promise.resolve();
    }

    const previous = this.pendingAutoCompactions.get(resolvedChannelId) ?? Promise.resolve();
    const next = previous
      .catch((error) => {
        log.error('Auto-compaction queue continuation failed', {
          channelId: resolvedChannelId,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .then(async () => {
        const adaptiveProfile = resolveAdaptiveContextBudgetProfile(
          this.config,
          params.turnBudgetCharacteristics,
        );
        const historyBudget = resolveSessionHistoryBudget(this.config, {
          ...(params.turnBudgetCharacteristics ? { turn: params.turnBudgetCharacteristics } : {}),
          adaptiveProfile,
        });
        let recent = collectRecentEntriesWithinTokenBudget({
          store: this.compactionBoundaryStore,
          channelId: resolvedChannelId,
          estimatedCount: historyBudget.estimatedCount,
          tokenBudget: historyBudget.tokenBudget,
        }).entries;
        recent = applyFocusCompactionRanges(
          recent,
          this.getFocusCompactionRanges(resolvedChannelId),
        ).entries;
        recent = applyObservationMasking(
          recent,
          this.config.observationMaskingWindow ?? DEFAULT_OBSERVATION_MASKING_WINDOW,
        ).entries;
        const coreMemoryBlock = this.coreMemoryProvider?.formatForContext().trim() ?? '';
        const baseCompactionPrompt = this.promptRegistry?.getPrompt(COMPACTION_SUMMARY_PROMPT_KEY)
          ?? getDefaultPromptText(COMPACTION_SUMMARY_PROMPT_KEY);
        const systemTokens = countTokens(params.systemPrompt)
          + countTokens(coreMemoryBlock)
          + countTokens(params.memoriesBlock);
        await runAutoCompaction({
          channelId: resolvedChannelId,
          recent,
          channelVisibility: classifyChannel(resolvedChannelId, params.channelMeta),
          systemTokens,
          compactionPromptText: params.compactionPromptText
            ?? this.resolveCompactionPromptText(baseCompactionPrompt),
          llmProvider: params.llmProvider,
          store: this.compactionBoundaryStore,
          config: this.config,
          eventBus: this.eventBus,
          promptRegistry: this.promptRegistry,
          preCompactionExtractionHandler: this.preCompactionExtractionHandler,
          onCompactionComplete: ({ channelId, originalContext, compressedContext, capturedAt }) => {
            this.compressionGuidelineRuntime.recordCompactionTrajectory({
              channelId,
              originalContext,
              compressedContext,
              capturedAt,
            });
          },
          userId: params.userId,
        });
      })
      .finally(() => {
        if (this.pendingAutoCompactions.get(resolvedChannelId) === next) {
          this.pendingAutoCompactions.delete(resolvedChannelId);
        }
      });

    this.pendingAutoCompactions.set(resolvedChannelId, next);
    return next;
  }

  recordToolObservation(
    channelId: string,
    observation: ToolObservationInput,
    isDirectMessage?: boolean,
    options: SessionMessageRecordOptions = {},
  ): number | null {
    const resolvedChannelId = this.resolveSessionChannelId(channelId);
    if (!shouldPersistSessionChannel(resolvedChannelId)) return null;
    const meta = options.channelMeta ?? (isDirectMessage != null ? { isDirectMessage } : undefined);
    const channelVisibility = classifyChannel(resolvedChannelId, meta);
    const timestamp = Date.now();
    const turnMetadata = options.turnId
      ? buildSessionMetadataWithTurn(options.metadata, {
        turnId: options.turnId,
        requestId: options.requestId ?? options.sourceMessageId ?? options.turnId,
        sourceMessageId: options.sourceMessageId,
        role: 'tool',
      })
      : options.metadata;
    const envelopeMetadata = options.roleEnvelopePreview
      ? buildSessionMetadataWithRoleEnvelopePreview(turnMetadata, options.roleEnvelopePreview)
      : turnMetadata;
    const normalizedObservation = normalizeToolObservation(observation);
    const metadata = buildToolObservationMetadata(
      envelopeMetadata,
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

  getRoleEnvelopeRefsForEntries(channelId: string, sessionEntryIds: readonly number[]): string[] {
    const resolvedChannelId = this.resolveSessionChannelId(channelId);
    const refs: string[] = [];
    const seenEntryIds = new Set<number>();
    const seenRefs = new Set<string>();

    for (const rawEntryId of sessionEntryIds) {
      if (!Number.isFinite(rawEntryId)) continue;
      const entryId = Math.floor(rawEntryId);
      if (entryId <= 0 || seenEntryIds.has(entryId)) continue;
      seenEntryIds.add(entryId);

      const entries = this.store.getEntriesInRange(resolvedChannelId, entryId, entryId);
      if (entries.length === 0) continue;
      const [entry] = entries;

      const preview = resolveSessionEntryRoleEnvelopePreview(entry);
      if (!preview) continue;

      const ref = resolveRoleEnvelopeRef(preview);
      if (seenRefs.has(ref)) continue;
      seenRefs.add(ref);
      refs.push(ref);
    }

    return refs;
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
    await this.awaitPendingAutoCompaction(resolvedChannelId);
    const coreMemoryBlock = this.coreMemoryProvider
      ? this.coreMemoryProvider.formatForContext()
      : '';
    const baseCompactionPrompt = this.promptRegistry?.getPrompt(COMPACTION_SUMMARY_PROMPT_KEY)
      ?? getDefaultPromptText(COMPACTION_SUMMARY_PROMPT_KEY);
    const compactionPromptText = turnSnapshot?.compactionPromptText
      ?? this.resolveCompactionPromptText(baseCompactionPrompt);
    const focusKnowledgeTexts = turnSnapshot?.focusKnowledgeTexts
      ?? this.getFocusKnowledgeTexts(resolvedChannelId);
    const focusCompactionRanges = turnSnapshot
      ? []
      : this.getFocusCompactionRanges(resolvedChannelId);
    return buildSessionContext({
      channelId: resolvedChannelId,
      systemPrompt,
      coreMemoryBlock,
      memoriesBlock,
      compactionPromptText,
      llmProvider,
      userId,
      channelMeta,
      continuityFallbackUserIds,
      store: this.compactionBoundaryStore,
      config: this.config,
      eventBus: this.eventBus,
      promptRegistry: this.promptRegistry,
      preCompactionExtractionHandler: this.preCompactionExtractionHandler,
      onCompactionComplete: ({ channelId: compactedChannelId, originalContext, compressedContext, capturedAt }) => {
        this.compressionGuidelineRuntime.recordCompactionTrajectory({
          channelId: compactedChannelId,
          originalContext,
          compressedContext,
          capturedAt,
        });
      },
      continuityStore: this.continuityStore,
      characterName: this.characterName,
      turnSnapshot,
      focusKnowledgeTexts,
      focusCompactionRanges,
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
      ...(turnBudgetCharacteristics ? { turn: turnBudgetCharacteristics } : {}),
      adaptiveProfile,
    });
    let recent = collectRecentEntriesWithinTokenBudget({
      store: this.compactionBoundaryStore,
      channelId: resolvedChannelId,
      estimatedCount: historyBudget.estimatedCount,
      tokenBudget: historyBudget.tokenBudget,
    }).entries;
    const focusCompaction = applyFocusCompactionRanges(
      recent,
      this.getFocusCompactionRanges(resolvedChannelId),
    );
    recent = focusCompaction.entries;
    const intentionAppraisalArtifactCount = countIntentionAppraisalArtifacts(recent);
    const focusKnowledgeTexts = this.getFocusKnowledgeTexts(resolvedChannelId);

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
    const baseCompactionPrompt = this.promptRegistry?.getPrompt(COMPACTION_SUMMARY_PROMPT_KEY)
      ?? getDefaultPromptText(COMPACTION_SUMMARY_PROMPT_KEY);
    const compactionPromptText = this.resolveCompactionPromptText(baseCompactionPrompt);

    return {
      channelId: resolvedChannelId,
      recentEntries: recent.map(cloneSessionEntry),
      compactionSummaryTexts: [...compactionSummaryTexts],
      focusKnowledgeTexts: [...focusKnowledgeTexts],
      continuityEntries: continuityEntries.map(cloneSessionEntry),
      intentionAppraisalArtifactCount,
      compactionPromptText,
      versionPointer: buildSnapshotVersionPointer([
        resolvedChannelId,
        recent.at(-1)?.id,
        recent.at(-1)?.timestamp,
        compactionSummaryTexts.join('\n'),
        focusKnowledgeTexts.join('\n'),
        focusCompaction.compactedCount,
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

  setCoreMemoryProvider(provider: SessionCoreMemoryProvider | null): void {
    this.coreMemoryProvider = provider;
  }

  setInternalRoleEnvelopeLedger(ledger: InternalRoleEnvelopeLedger | null): void {
    this.internalRoleEnvelopeLedger = ledger;
  }

  getInternalRoleEnvelopeLedger(): InternalRoleEnvelopeLedger | null {
    return this.internalRoleEnvelopeLedger;
  }

  recordCompressionFailureFromResponse(
    channelId: string,
    sourceMessageId: string,
    assistantResponse: string,
  ): boolean {
    const entry = this.compressionGuidelineRuntime.captureFailureFromResponse({
      channelId: this.resolveSessionChannelId(channelId),
      sourceMessageId,
      assistantResponse,
    });
    return entry !== null;
  }

  runPeriodicCompressionGuidelineUpdate(
    llmProvider: LLMProvider,
  ): Promise<CompressionGuidelineUpdateResult> {
    return this.compressionGuidelineRuntime.runPeriodicGuidelineUpdate(llmProvider);
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
    return collectRecentEntriesWithinTokenBudget({
      store: this.store,
      channelId: resolvedChannelId,
      estimatedCount: historyBudget.estimatedCount,
      tokenBudget: historyBudget.tokenBudget,
    }).entries;
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
