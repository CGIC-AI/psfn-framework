import { randomUUID } from 'node:crypto';
import type { LLMContext, TurnRecord } from '../../shared/contracts/runtime.js';
import type { SessionRestartBehavior, SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { MemoryScopeQuery } from '../../faculties/memory/types.js';
import type { LLMProviderPort } from '../agent/contracts.js';
import type {
  SessionStore,
  SessionActivitySummary,
  LegacyChatImportRequest,
  LegacyChatImportResult,
  LegacyChatImportRange,
} from '../../persistence/sessions/store.js';
import {
  createUserContinuityPort,
  createMissingCrossChannelContinuityPort,
  type CrossChannelContinuityHealth,
  type CrossChannelContinuityPort,
} from './cross-channel-continuity-port.js';
import type { TranscriptSearchPort } from '../../persistence/sessions/transcript-search-port.js';
import type { UserContinuityStore } from './continuity.js';
import type { SessionEntry, SessionEntryRole } from './types.js';
import { detectInternalOriginForUserAttribution } from './entry-attribution.js';
import type { SessionSearchHit } from '../../persistence/sessions/transcript-projection-port.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { InternalRoleEnvelopeLedger } from '../internal-role-envelopes/types.js';
import { classifyChannelEnvelope, type ChannelMeta } from '../../system/trust/policy.js';
import { countTokens } from '../../primitives/llm/tokens.js';
import { createComponentLogger } from '../../shared/logger.js';
import {
  COMPACTION_SUMMARY_PROMPT_KEY,
  getDefaultPromptText,
} from '../identity/prompt-registry.js';
import type { PromptRegistryStatePort } from '../identity/prompt-state-port.js';
import type { CoreMemoryFormatContext } from '../../faculties/core-memory/store.js';
import {
  resolveConversationScopeFromMetadata,
  type ConversationScope,
  type ConversationScopeContact,
  type ConversationScopeSpeaker,
} from './conversation-scope.js';
import {
  markCompactionSummaryAsUntrustedRecord,
  wrapCompactionSummaryAsUntrustedContext,
} from '../identity/prompt-composer.js';
import {
  resolveAdaptiveContextBudgetProfile,
  resolveSessionHistoryBudget,
  type ContextBudgetTurnCharacteristics,
} from '../../shared/context-budget.js';
import {
  collectRecentEntriesWithinTokenBudget,
  isNonConversationalSessionEntry,
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
  captureTurnSessionContext,
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
import { cloneSessionContinuityArtifact } from '../turns/snapshot.js';
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
  resolveSessionRoutesPath,
  resolveSessionContinuityArtifactsDir,
} from '../../persistence/layout.js';
import {
  CompressionFailureLogStore,
  CompressionGuidelineRuntime,
  CompressionGuidelineStore,
  type CompressionGuidelineUpdateResult,
} from './compression-guideline.js';
import { resolveRoleEnvelopeRef } from '../internal-role-envelopes/projections.js';
import {
  SessionContinuityArtifactStore,
  type SessionContinuityArtifact,
  type SessionContinuityArtifactInput,
  type SessionContinuityArtifactListOptions,
} from './continuity-artifacts.js';
import {
  SessionRouteStore,
  type SessionRouteResetInput,
  type SessionRouteResetResult,
  type SourceChannelSessionRoute,
} from './session-routes.js';

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
  formatForContext(context?: CoreMemoryFormatContext): string;
}

export interface AutoCompactionBetweenTurnsParams {
  channelId: string;
  systemPrompt: string;
  memoriesBlock: string;
  llmProvider: LLMProviderPort;
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
  private transcriptSearch: TranscriptSearchPort;
  private compactionBoundaryStore: SessionStore;
  private config: SubstrateConfig;
  private eventBus: EventBus | null;
  private promptRegistry: PromptRegistryStatePort | null;
  private focusKnowledgeStore: FocusKnowledgeStore;
  private continuityArtifactStore: SessionContinuityArtifactStore;
  private sessionRouteStore: SessionRouteStore;
  private compressionGuidelineRuntime: CompressionGuidelineRuntime;
  private preCompactionExtractionHandler: PreCompactionExtractionHandler | null;
  private coreMemoryProvider: SessionCoreMemoryProvider | null;
  private internalRoleEnvelopeLedger: InternalRoleEnvelopeLedger | null;
  private activeContextSessionId: string | null = null;
  private activeFocusSessions: Map<string, ActiveFocusSession> = new Map();
  private pendingAutoCompactions = new Map<string, Promise<void>>();
  private continuityStoreRef: UserContinuityStore | null = null;
  crossChannelContinuity: CrossChannelContinuityPort = createMissingCrossChannelContinuityPort();
  /** Character name from identity card (e.g. 'Companion'). Used for display labels in context. */
  characterName: string | undefined;

  constructor(
    store: SessionStore,
    config: SubstrateConfig,
    eventBus?: EventBus,
    promptRegistry?: PromptRegistryStatePort | null,
    transcriptSearch?: TranscriptSearchPort,
  ) {
    this.store = store;
    this.transcriptSearch = transcriptSearch ?? store;
    this.compactionBoundaryStore = createCompactionBoundaryStore(store);
    this.config = config;
    this.eventBus = eventBus ?? null;
    this.promptRegistry = promptRegistry ?? null;
    const companionDataDir = resolveConfiguredCompanionDataDir(config);
    this.focusKnowledgeStore = new FocusKnowledgeStore(resolveFocusKnowledgePath(companionDataDir));
    this.continuityArtifactStore = new SessionContinuityArtifactStore(
      resolveSessionContinuityArtifactsDir(companionDataDir),
    );
    this.sessionRouteStore = new SessionRouteStore(resolveSessionRoutesPath(companionDataDir));
    this.compressionGuidelineRuntime = new CompressionGuidelineRuntime(
      new CompressionGuidelineStore(resolveCompressionGuidelinePath(companionDataDir)),
      new CompressionFailureLogStore(resolveCompressionFailureLogPath(companionDataDir)),
    );
    this.preCompactionExtractionHandler = null;
    this.coreMemoryProvider = null;
    this.internalRoleEnvelopeLedger = null;
  }

  private resolveContextCharacterName(): string | undefined {
    const runtimeName = this.characterName?.trim();
    if (runtimeName) return runtimeName;
    const configuredName = typeof this.config.characterName === 'string'
      ? this.config.characterName.trim()
      : '';
    return configuredName || undefined;
  }

  get continuityStore(): UserContinuityStore | null {
    return this.continuityStoreRef;
  }

  set continuityStore(store: UserContinuityStore | null) {
    this.continuityStoreRef = store;
    this.crossChannelContinuity = store
      ? createUserContinuityPort(store)
      : createMissingCrossChannelContinuityPort();
  }

  getCrossChannelContinuityHealth(): CrossChannelContinuityHealth {
    return this.crossChannelContinuity.getHealth();
  }

  private resolveCompactionPromptText(basePrompt: string): string {
    return this.compressionGuidelineRuntime.buildCompactionPrompt(basePrompt);
  }

  private shouldOverrideSessionContext(channelId: string): boolean {
    return channelId.startsWith('api:') || channelId.startsWith('terminal:');
  }

  private resolveOriginChannelId(channelId: string, resolvedChannelId: string): string | undefined {
    const normalized = channelId.trim();
    return normalized && normalized !== resolvedChannelId ? normalized : undefined;
  }

  private resolveSourceChannelId(channelId: string): string {
    return this.sessionRouteStore.resolveSourceChannelId(channelId);
  }

  resolveSessionChannelId(channelId: string): string {
    const routedSessionId = this.sessionRouteStore.resolve(channelId);
    if (routedSessionId) return routedSessionId;
    if (!this.activeContextSessionId) return channelId;
    if (!this.shouldOverrideSessionContext(channelId)) return channelId;
    return this.activeContextSessionId;
  }

  listSessionRoutes(): SourceChannelSessionRoute[] {
    return this.sessionRouteStore.listRoutes();
  }

  getSessionRoute(sourceChannelId: string): SourceChannelSessionRoute | null {
    return this.sessionRouteStore.getRoute(sourceChannelId);
  }

  getSessionRouteForLogicalSession(logicalSessionId: string): SourceChannelSessionRoute | null {
    return this.sessionRouteStore.getRouteForLogicalSession(logicalSessionId);
  }

  getRetiredLogicalSessionIds(): Set<string> {
    return this.sessionRouteStore.getRetiredLogicalSessionIds();
  }

  isSessionRetiredOrQuarantined(logicalSessionId: string): boolean {
    return this.sessionRouteStore.isRetiredOrQuarantined(logicalSessionId);
  }

  resetSourceChannelSession(input: SessionRouteResetInput): SessionRouteResetResult {
    const result = this.sessionRouteStore.resetSourceChannel(input);
    this.activeFocusSessions.delete(result.oldLogicalSessionId);
    this.activeFocusSessions.delete(result.newLogicalSessionId);
    this.pendingAutoCompactions.delete(result.oldLogicalSessionId);
    this.pendingAutoCompactions.delete(result.newLogicalSessionId);
    void this.eventBus?.emit('session.route.reset', {
      sourceChannelId: result.sourceChannelId,
      oldLogicalSessionId: result.oldLogicalSessionId,
      newLogicalSessionId: result.newLogicalSessionId,
      routeGeneration: result.route.routeGeneration,
      mode: result.route.mode,
      actor: result.route.actor,
      reason: result.route.reason,
      timestamp: Date.now(),
    });
    return result;
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

  recordSessionContinuityArtifact(input: SessionContinuityArtifactInput): SessionContinuityArtifact {
    return this.continuityArtifactStore.append(input);
  }

  listSessionContinuityArtifacts(
    sessionId: string,
    options?: SessionContinuityArtifactListOptions,
  ): SessionContinuityArtifact[] {
    return this.continuityArtifactStore.listRecent(sessionId, options);
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
    const originChannelId = this.resolveOriginChannelId(channelId, resolvedChannelId);
    const sourceChannelId = originChannelId ?? resolvedChannelId;
    const meta = options.channelMeta ?? (isDirectMessage != null ? { isDirectMessage } : undefined);
    const channelVisibility = classifyChannelEnvelope(sourceChannelId, meta).privacy;
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

    // Authorship integrity guard (charter laws 17/19): internal-origin
    // messages must never persist as partner speech. The read-time
    // normalizer already classifies these signatures as system; storing
    // them as user lets a future consumer or a missed normalization path
    // present them as the partner talking inside her head.
    const guardReason = detectInternalOriginForUserAttribution({
      channelId: resolvedChannelId,
      content,
      authorId,
      authorName,
      metadata,
      ...(options.requestId ? { requestId: options.requestId } : {}),
      ...(options.sourceMessageId ? { sourceMessageId: options.sourceMessageId } : {}),
    });
    const entryRole: SessionEntryRole = guardReason ? 'system' : 'user';
    if (guardReason) {
      log.warn('Authorship guard re-tagged internal-origin message submitted as user speech', {
        channelId: resolvedChannelId,
        reason: guardReason,
        authorId,
        authorName,
      });
      void this.eventBus?.emit('session.authorship_guard.retagged', {
        channelId: resolvedChannelId,
        reason: guardReason,
        authorId,
        authorName,
        timestamp,
      });
    }

    if (!shouldPersistSessionChannel(resolvedChannelId)) {
      if (
        continuityKey
        && resolvedChannelId.startsWith(INTERNAL_REFLECTION_CHANNEL_PREFIX)
      ) {
        this.crossChannelContinuity.append({
          continuityUserId: continuityKey,
          entry: {
            channelId: resolvedChannelId,
            role: entryRole,
            content,
            authorId,
            authorName,
            timestamp,
            originChannelId: sourceChannelId,
            channelVisibility,
            ...(metadata ? { metadata } : {}),
          },
        });
      }
      return null;
    }

    const entryId = this.store.append({
      channelId: resolvedChannelId,
      role: entryRole,
      content,
      authorId,
      authorName,
      timestamp,
      channelVisibility,
      ...(originChannelId ? { originChannelId } : {}),
      ...(metadata ? { metadata } : {}),
    });

    if (continuityKey) {
      this.crossChannelContinuity.append({
        continuityUserId: continuityKey,
        entry: {
          channelId: resolvedChannelId,
          role: entryRole,
          content,
          authorId,
          authorName,
          timestamp,
          originChannelId: sourceChannelId,
          channelVisibility,
          ...(metadata ? { metadata } : {}),
        },
      });
    }

    if (!guardReason) {
      this.mirrorMessageToActiveSessions({
        continuityKey,
        sourceChannelId,
        sourceVisibility: channelVisibility,
        sourceRole: 'user',
        sourceAuthorName: authorName,
        content,
        trustLevel: options.trustLevel ?? 'regular',
        timestamp,
        mirrorEnabled: options.mirror !== false,
      });
    }
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
    const originChannelId = this.resolveOriginChannelId(channelId, resolvedChannelId);
    const sourceChannelId = originChannelId ?? resolvedChannelId;
    const meta = options.channelMeta ?? (isDirectMessage != null ? { isDirectMessage } : undefined);
    const channelVisibility = classifyChannelEnvelope(sourceChannelId, meta).privacy;
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
        continuityKey
        && resolvedChannelId.startsWith(INTERNAL_REFLECTION_CHANNEL_PREFIX)
      ) {
        this.crossChannelContinuity.append({
          continuityUserId: continuityKey,
          entry: {
            channelId: resolvedChannelId,
            role: 'assistant',
            content,
            timestamp,
            originChannelId: sourceChannelId,
            channelVisibility,
            ...(metadata ? { metadata } : {}),
          },
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
      ...(originChannelId ? { originChannelId } : {}),
      ...(metadata ? { metadata } : {}),
    });

    if (continuityKey) {
      this.crossChannelContinuity.append({
        continuityUserId: continuityKey,
        entry: {
          channelId: resolvedChannelId,
          role: 'assistant',
          content,
          timestamp,
          originChannelId: sourceChannelId,
          channelVisibility,
          ...(metadata ? { metadata } : {}),
        },
      });
    }

    this.mirrorMessageToActiveSessions({
      continuityKey,
      sourceChannelId,
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
    const originChannelId = this.resolveOriginChannelId(channelId, resolvedChannelId);
    const sourceChannelId = originChannelId ?? resolvedChannelId;
    const meta = options.channelMeta ?? (isDirectMessage != null ? { isDirectMessage } : undefined);
    const channelVisibility = classifyChannelEnvelope(sourceChannelId, meta).privacy;
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
      ...(originChannelId ? { originChannelId } : {}),
      ...(metadata ? { metadata } : {}),
    });

    const continuityKey = continuityUserId ?? authorId;
    if (continuityKey) {
      this.crossChannelContinuity.append({
        continuityUserId: continuityKey,
        entry: {
          channelId: resolvedChannelId,
          role: 'system',
          content,
          authorId,
          authorName,
          timestamp,
          originChannelId: sourceChannelId,
          channelVisibility,
          ...(metadata ? { metadata } : {}),
        },
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
          turnBudgetCharacteristics: params.turnBudgetCharacteristics,
        }).entries;
        recent = applyFocusCompactionRanges(
          recent,
          this.getFocusCompactionRanges(resolvedChannelId),
        ).entries;
        recent = applyObservationMasking(
          recent,
          this.config.observationMaskingWindow ?? DEFAULT_OBSERVATION_MASKING_WINDOW,
        ).entries;
        const coreMemoryBlock = this.coreMemoryProvider
          ?.formatForContext(this.buildCoreMemoryFormatContext(
            // Between-turns work resolves its own scope at drain time; the
            // session store may have advanced since the turn that scheduled it.
            this.resolveConversationScopeForResolvedChannel(resolvedChannelId, {
              ...(params.channelMeta ? { channelMeta: params.channelMeta } : {}),
              ...(params.userId ? { userId: params.userId } : {}),
            }),
          ))
          .trim() ?? '';
        const baseCompactionPrompt = this.promptRegistry?.getPrompt(COMPACTION_SUMMARY_PROMPT_KEY)
          ?? getDefaultPromptText(COMPACTION_SUMMARY_PROMPT_KEY);
        const systemTokens = countTokens(params.systemPrompt)
          + countTokens(coreMemoryBlock)
          + countTokens(params.memoriesBlock);
        await runAutoCompaction({
          channelId: resolvedChannelId,
          recent,
          channelVisibility: classifyChannelEnvelope(resolvedChannelId, params.channelMeta).privacy,
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
    const originChannelId = this.resolveOriginChannelId(channelId, resolvedChannelId);
    const sourceChannelId = originChannelId ?? resolvedChannelId;
    const meta = options.channelMeta ?? (isDirectMessage != null ? { isDirectMessage } : undefined);
    const channelVisibility = classifyChannelEnvelope(sourceChannelId, meta).privacy;
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
      ...(originChannelId ? { originChannelId } : {}),
      metadata,
    });
  }

  recordTurn(record: TurnRecord): void {
    this.store.appendTurnRecord(record);
  }

  getRoleEnvelopeRefsForEntries(channelId: string, sessionEntryIds: readonly number[]): string[] {
    const resolvedChannelId = this.resolveSessionChannelId(channelId);
    const refs: string[] = [];
    const requestedEntryIds: number[] = [];
    const seenEntryIds = new Set<number>();
    const seenRefs = new Set<string>();
    let rangeStartId = Number.POSITIVE_INFINITY;
    let rangeEndId = 0;

    for (const rawEntryId of sessionEntryIds) {
      if (!Number.isFinite(rawEntryId)) continue;
      const entryId = Math.floor(rawEntryId);
      if (entryId <= 0 || seenEntryIds.has(entryId)) continue;
      seenEntryIds.add(entryId);
      requestedEntryIds.push(entryId);
      rangeStartId = Math.min(rangeStartId, entryId);
      rangeEndId = Math.max(rangeEndId, entryId);
    }

    if (requestedEntryIds.length === 0) return refs;

    const entries = this.store.getEntriesInRange(resolvedChannelId, rangeStartId, rangeEndId);
    const entriesById = new Map<number, (typeof entries)[number]>();
    for (const entry of entries) {
      if (!seenEntryIds.has(entry.id) || entriesById.has(entry.id)) continue;
      entriesById.set(entry.id, entry);
    }

    for (const entryId of requestedEntryIds) {
      const entry = entriesById.get(entryId);
      if (!entry) continue;

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
    sourceVisibility: import('../../system/trust/context-envelope.js').ChannelPrivacy;
    sourceRole: 'user' | 'assistant';
    sourceAuthorName?: string;
    content: string;
    trustLevel: import('../../system/trust/types.js').TrustLevel;
    timestamp: number;
    mirrorEnabled: boolean;
  }): void {
    mirrorMessageToActiveSessions({
      config: this.config,
      store: this.store,
      crossChannelContinuity: this.crossChannelContinuity,
      characterName: this.resolveContextCharacterName(),
      ...params,
    });
  }

  /**
   * Capture the turn's session-context snapshot through the single derivation
   * path (context-builder captureTurnSessionContext). The turn pipeline calls
   * this once pre-turn (feeding the retrieval query and the persisted
   * PromptPlan); buildContext captures inline for direct callers. There is no
   * parallel live re-derivation (E2.2).
   */
  async captureTurnSessionContext(input: {
    channelId: string;
    userId?: string;
    channelMeta?: ChannelMeta;
    continuityFallbackUserIds?: string[];
    turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics;
    /** Optional LLM provider for foreground history-budget summarization. */
    llmProvider?: LLMProviderPort;
  }): Promise<TurnSessionContextSnapshot> {
    const resolvedChannelId = this.resolveSessionChannelId(input.channelId);
    const sourceChannelId = this.resolveSourceChannelId(resolvedChannelId);
    const baseCompactionPrompt = this.promptRegistry?.getPrompt(COMPACTION_SUMMARY_PROMPT_KEY)
      ?? getDefaultPromptText(COMPACTION_SUMMARY_PROMPT_KEY);
    return captureTurnSessionContext({
      channelId: resolvedChannelId,
      sourceChannelId,
      userId: input.userId,
      channelMeta: input.channelMeta,
      continuityFallbackUserIds: input.continuityFallbackUserIds ?? [],
      turnBudgetCharacteristics: input.turnBudgetCharacteristics,
      config: this.config,
      store: this.compactionBoundaryStore,
      activityStore: this.store,
      crossChannelContinuity: this.crossChannelContinuity,
      focusCompactionRanges: this.getFocusCompactionRanges(resolvedChannelId),
      focusKnowledgeTexts: this.getFocusKnowledgeTexts(resolvedChannelId),
      wakeReturnArtifacts: this.listSessionContinuityArtifacts(resolvedChannelId, {
        kind: 'wake_return',
        limit: 2,
      }),
      compactionPromptText: this.resolveCompactionPromptText(baseCompactionPrompt),
      characterName: this.resolveContextCharacterName(),
      llmProvider: input.llmProvider,
      promptRegistry: this.promptRegistry,
    });
  }

  async buildContext(
    channelId: string,
    systemPrompt: string,
    memoriesBlock: string,
    llmProvider?: LLMProviderPort,
    userId?: string,
    channelMeta?: ChannelMeta,
    continuityFallbackUserIds: string[] = [],
    turnSessionContext?: TurnSessionContextSnapshot,
    memoryManifestSeed?: ContextManifestMemorySeed,
    turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics,
    conversationScope?: ConversationScope,
  ): Promise<LLMContext> {
    const resolvedChannelId = this.resolveSessionChannelId(channelId);
    const sourceChannelId = this.resolveSourceChannelId(resolvedChannelId);
    if (conversationScope && conversationScope.channelId !== resolvedChannelId) {
      throw new Error(
        `ConversationScope channel mismatch: scope is bound to "${conversationScope.channelId}" `
        + `but buildContext resolved "${resolvedChannelId}". The scope must be resolved for the `
        + 'same session channel as the context it feeds.',
      );
    }
    // The turn pipeline resolves the scope exactly once per turn and passes it
    // in; direct callers (tests, non-turn surfaces) resolve at this entry.
    const scope = conversationScope
      ?? this.resolveConversationScopeForResolvedChannel(resolvedChannelId, {
        ...(channelMeta ? { channelMeta } : {}),
        ...(userId ? { userId } : {}),
      });
    // Single derivation path: the turn pipeline passes the snapshot it captured
    // pre-turn (the one persisted in the PromptPlan turn snapshot); direct
    // callers capture inline through the same function.
    const sessionContext = turnSessionContext
      ?? await this.captureTurnSessionContext({
        channelId: resolvedChannelId,
        userId,
        channelMeta,
        continuityFallbackUserIds,
        turnBudgetCharacteristics,
        llmProvider,
      });
    const coreMemoryBlock = this.coreMemoryProvider
      ? this.coreMemoryProvider.formatForContext(
        this.buildCoreMemoryFormatContext(scope),
      )
      : '';
    const baseCompactionPrompt = this.promptRegistry?.getPrompt(COMPACTION_SUMMARY_PROMPT_KEY)
      ?? getDefaultPromptText(COMPACTION_SUMMARY_PROMPT_KEY);
    const compactionPromptText = sessionContext.compactionPromptText
      ?? this.resolveCompactionPromptText(baseCompactionPrompt);
    const wakeReturnArtifacts = (sessionContext.wakeReturnArtifacts ?? [])
      .map(cloneSessionContinuityArtifact);
    return buildSessionContext({
      channelId: resolvedChannelId,
      sourceChannelId,
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
      crossChannelContinuity: this.crossChannelContinuity,
      wakeReturnArtifacts,
      characterName: this.resolveContextCharacterName(),
      turnSessionContext: sessionContext,
      memoryManifestSeed,
      turnBudgetCharacteristics,
      compactionMode: 'deferred',
      pendingCompaction: this.pendingAutoCompactions.has(resolvedChannelId),
    });
  }

  /** Append a system note to a session's internal lane. Hidden from ordinary context builds. */
  appendSystemNote(channelId: string, note: string, source = 'appendSystemNote'): void {
    const resolvedChannelId = this.resolveSessionChannelId(channelId);
    if (!shouldPersistSessionChannel(resolvedChannelId)) return;
    const originChannelId = this.resolveOriginChannelId(channelId, resolvedChannelId);
    this.store.append({
      channelId: resolvedChannelId,
      role: 'system',
      content: note,
      authorId: 'system',
      authorName: 'System',
      timestamp: Date.now(),
      ...(originChannelId ? { originChannelId } : {}),
      metadata: JSON.stringify({
        sessionLane: {
          schemaVersion: 1,
          kind: 'internal',
          source,
        },
      }),
    });
  }

  getRecentSessionEntries(channelId: string, limit: number): SessionEntry[] {
    const resolvedChannelId = this.resolveSessionChannelId(channelId);
    return this.store.getRecent(resolvedChannelId, limit);
  }

  setPreCompactionExtractionHandler(handler: PreCompactionExtractionHandler | null): void {
    this.preCompactionExtractionHandler = handler;
  }

  setCoreMemoryProvider(provider: SessionCoreMemoryProvider | null): void {
    this.coreMemoryProvider = provider;
  }

  /**
   * Resolve the ConversationScope for a conversation from ingress metadata.
   *
   * This is the single scope construction path: the turn pipeline calls it
   * exactly once per turn (turn-execution prepareTurnIdentityState) and
   * threads the resulting value object to every scope consumer. Non-turn
   * callers (between-turns compaction, direct buildContext callers) resolve
   * at their own entry with the same rule.
   *
   * Group/direct determination matches the runtime's existing detector
   * (resolveConversationChatType / message.isDirectMessage): only an explicit
   * `isDirectMessage === true` is a DM.
   */
  resolveConversationScope(input: {
    channelId: string;
    channelMeta?: ChannelMeta;
    userId?: string;
    contact?: ConversationScopeContact;
    /** Precomputed speaker window (single scan per turn); absent rescans. */
    recentSpeakers?: readonly ConversationScopeSpeaker[];
    /**
     * Recent speakers resolvable to contacts (E3.3 envelope derivation input,
     * supplied by turn ingress). Absent fails closed to 0 resolved.
     */
    resolvedSpeakerContactCount?: number;
  }): ConversationScope {
    return this.resolveConversationScopeForResolvedChannel(
      this.resolveSessionChannelId(input.channelId),
      input,
    );
  }

  private resolveConversationScopeForResolvedChannel(
    resolvedChannelId: string,
    input: {
      channelMeta?: ChannelMeta;
      userId?: string;
      contact?: ConversationScopeContact;
      recentSpeakers?: readonly ConversationScopeSpeaker[];
      resolvedSpeakerContactCount?: number;
    },
  ): ConversationScope {
    return resolveConversationScopeFromMetadata({
      channelId: resolvedChannelId,
      isDirectMessage: input.channelMeta?.isDirectMessage,
      ...(input.channelMeta ? { channelMeta: input.channelMeta } : {}),
      ...(input.contact ? { contact: input.contact } : {}),
      ...(input.userId ? { participantId: input.userId } : {}),
      ...(input.resolvedSpeakerContactCount !== undefined
        ? { resolvedSpeakerContactCount: input.resolvedSpeakerContactCount }
        : {}),
      recentSpeakers: input.recentSpeakers
        ?? this.scanRecentConversationSpeakers(resolvedChannelId),
    });
  }

  /**
   * Distinct recent user-role speakers in the session window (max 5) for a
   * channel. Public so turn ingress can scan ONCE, resolve speaker→contact
   * resolvability against the contact store, and feed both back into
   * resolveConversationScope (E3.3 envelope derivation).
   */
  getRecentConversationSpeakers(channelId: string): ConversationScopeSpeaker[] {
    return this.scanRecentConversationSpeakers(this.resolveSessionChannelId(channelId));
  }

  /**
   * Distinct recent user-role speakers in the session window (max 5). This is
   * the recent-participant scan that previously lived inside
   * buildCoreMemoryFormatContext; it now feeds ConversationScope construction.
   */
  private scanRecentConversationSpeakers(channelId: string): ConversationScopeSpeaker[] {
    const recentSpeakers: ConversationScopeSpeaker[] = [];
    const seenParticipantKeys = new Set<string>();
    for (const entry of this.store.getRecent(channelId, 50)) {
      if (entry.role !== 'user') continue;
      const key = entry.authorId?.trim() || entry.authorName?.trim() || '';
      if (!key || seenParticipantKeys.has(key)) continue;
      seenParticipantKeys.add(key);
      const name = entry.authorName?.trim() || entry.authorId?.trim();
      if (name) {
        recentSpeakers.push({ authorId: key, name });
      }
      if (recentSpeakers.length >= 5) break;
    }
    return recentSpeakers;
  }

  private buildCoreMemoryFormatContext(
    scope: ConversationScope,
  ): CoreMemoryFormatContext {
    if (scope.kind === 'dm') {
      // DM scope: bind the canonical DM partner from the resolved scope, never
      // a history-derived speaker. The rendered block is named for the contact
      // (participant_context name=<contact>), so a relayed guest line in the
      // window can no longer flip the subject binding.
      const contactId = scope.contact.contactId;
      const participantName = scope.contact.displayName
        ?? scope.recentSpeakers.find(speaker => speaker.authorId === contactId)?.name;
      return {
        channelId: scope.channelId,
        isDirectMessage: true,
        participantId: contactId,
        ...(participantName ? { participantName } : {}),
      };
    }
    // Group scope: NEVER a single-person binding. The block represents the room
    // (room identity + <=5 recently active speaker names); per-person detail
    // stays in per-contact profiles and is never blended into this block.
    const activeParticipantNames = scope.recentSpeakers.map(speaker => speaker.name);
    return {
      channelId: scope.channelId,
      isDirectMessage: false,
      ...(scope.roomName ? { roomName: scope.roomName } : {}),
      ...(scope.memberCountHint !== undefined ? { participantCount: scope.memberCountHint } : {}),
      ...(activeParticipantNames.length > 0 ? { activeParticipantNames } : {}),
    };
  }

  /**
   * Resolve the ConversationScope for a channel from its persisted session
   * state (the last user turn's author id and DM classification) and render the
   * scoped core-memory block through the same read path a turn uses. Startup
   * hydration calls this so the first post-restart prompt carries a non-empty
   * scoped block for recently active channels while async memory catches up.
   */
  renderActiveCoreMemoryBlock(channelId: string): string {
    if (!this.coreMemoryProvider) return '';
    const resolvedChannelId = this.resolveSessionChannelId(channelId);
    let userId: string | undefined;
    let channelVisibility: string | undefined;
    const recent = this.store.getRecent(resolvedChannelId, 50);
    for (let i = recent.length - 1; i >= 0; i -= 1) {
      const entry = recent[i];
      if (entry.role !== 'user') continue;
      userId = entry.authorId?.trim() || undefined;
      channelVisibility = entry.channelVisibility;
      break;
    }
    // The most authoritative persisted DM signal is the channelVisibility that
    // classifyChannel stamped on the recorded turn: 'private' is the honne DM
    // channel class. Group rooms carry any non-private visibility.
    const channelMeta: ChannelMeta | undefined = channelVisibility
      ? { isDirectMessage: channelVisibility === 'private' }
      : undefined;
    const scope = this.resolveConversationScopeForResolvedChannel(resolvedChannelId, {
      ...(channelMeta ? { channelMeta } : {}),
      ...(userId ? { userId } : {}),
    });
    return this.coreMemoryProvider.formatForContext(
      this.buildCoreMemoryFormatContext(scope),
    );
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
    llmProvider: LLMProviderPort,
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
      return this.store.getRecent(resolvedChannelId, limit)
        .filter(entry => !isNonConversationalSessionEntry(entry));
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

  async searchByKeywords(query: string, limit?: number): Promise<SessionSearchHit[]> {
    return await this.transcriptSearch.searchByKeywords(query, limit);
  }

  async searchTranscripts(query: string, limit?: number): Promise<SessionSearchHit[]> {
    return await this.searchByKeywords(query, limit);
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
