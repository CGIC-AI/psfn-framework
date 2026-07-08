import { compactMemoryTextForPrompt } from '../../faculties/memory/retrieval/formatting.js';
import type { Scheduler } from './scheduler.js';
import type { MessageSender } from '../../system/lifecycle/notifications.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { ActiveConcernSnapshot } from '../intention/appraisal.js';
import {
  HEARTBEAT_SILENT_REFLECTION_TOKEN,
  HeartbeatPolicyStore,
  isValuesReflectionTemplateId,
  type HeartbeatPolicy,
  type ReflectionTemplate,
} from './heartbeat-policy.js';
import { ValuesJournalStore } from '../../faculties/values/store.js';
import type {
  ValuesDeliberationEpisodeMetadata,
  ValuesDeliberationMetadata,
} from '../../faculties/values/store.js';
import type {
  ObservabilityCallType,
  PostTurnActionCandidate,
  ReflectionScopeHint,
} from '../../shared/contracts/runtime.js';
import type { ConversationScope } from '../session/conversation-scope.js';
import type {
  HeartbeatAgent,
  HeartbeatRunTemplateResult,
  HeartbeatRuntimeOptions,
} from './heartbeat-runtime-contracts.js';
import {
  resolveHeartbeatPolicyPath,
  resolveLegacyValuesJournalPath,
  resolveReflectionDailyJournalsDir,
  resolveReflectionJournalPath,
  resolveReflectionMetacognitionJournalPath,
  resolveReflectionProcessLogsDir,
  resolveValuesJournalPath,
} from '../../persistence/layout.js';
import {
  ReflectionJournalStore,
} from '../../persistence/journals/reflection-journal.js';
import { ReflectionMetacognitionJournalStore } from '../../persistence/journals/reflection-metacognition-journal.js';
import {
  assembleReflectionContactContextBundle,
  assembleReflectionSubstrateContext,
  buildReflectionProcessId,
  ReflectionDailyJournalStore,
  ReflectionProcessLogStore,
  type ReflectionContactActiveConcern,
  type ReflectionContactContextBundle,
  type ReflectionContactEmotionalSnapshot,
  type ReflectionContactRecentMessage,
  type ReflectionSubstrateContext,
} from '../../persistence/journals/reflection-substrate.js';
import type { Contact } from '../contacts/types.js';
import { isBusyTurnError } from '../../system/lifecycle/turn-contention.js';
import { runDeliberation } from '../../primitives/llm/deliberation.js';
import type { DeliberationResult } from '../../primitives/llm/deliberation.js';
import {
  buildInternalStateSnapshotRef,
  cloneInternalState,
} from '../self-model/state.js';
import {
  WHISPER_WORKER_LANE,
  createWorkerExecutionPolicy,
} from '../agent/worker-lanes.js';
import {
  detectReflectionGuardrailWarnings,
  type ReflectionGuardrailSummary,
} from './reflection-guardrail-telemetry.js';
import {
  formatReflectionIntrospectionPolicyBlock,
  resolveReflectionIntrospectionPolicy,
  type ReflectionIntrospectionPolicy,
} from './reflection-introspection-policy.js';
import { runWithRequestContext } from '../../primitives/llm/request-context.js';
import { evaluateDeterministicGate } from '../../shared/gating/deterministic-gate.js';
import { DEFAULT_REFLECTION_NOVELTY_GATE } from '../../system/config/scheduler-config.js';
import {
  REFLECTION_PROMPT_TOKENS,
  formatReflectionPersonaBlock,
  joinReflectionPromptSections,
  mergeMetacognitiveFlags,
  mergeReflectionGroundingProvenanceRefs,
  mergeReflectionPromptBundles,
  promptUsesReflectionMacros,
  type ReflectionInternalStateContext,
  type ReflectionMetacognitiveFlag,
  type ReflectionPromptContext,
  type ReflectionPromptSectionBundle,
} from './heartbeat-template-runtime/prompt-formatting.js';
import {
  buildInternalStatePromptBundle,
  normalizeMetacognitiveFlags,
  normalizeSnapshotRef,
  resolveInternalStateContext,
} from './heartbeat-template-runtime/internal-state-prompt.js';
import { runExperientialTemplateDeliberation } from './heartbeat-template-runtime/experiential-deliberation.js';
import {
  HeartbeatTemplateLoopGuardError,
  REFLECTION_NOVELTY_ENTRY_SCAN_LIMIT,
  REFLECTION_NOVELTY_GATE_LANE,
  REFLECTION_NOVELTY_WATERMARK_PROCESSOR,
  buildReflectionNoveltyGateDefinition,
  buildUnsupportedReflectionSupportFlags,
  findReflectionTemplateById,
  getHeartbeatTemplateAuditProfile,
  isExperientialDeliberationTemplate,
  isHeartbeatTemplateLoopGuardError,
  normalizeFiniteTimestamp,
  resolveCompanionNameFromCharacterVariables,
  selectFreshestLiveChatGapMs,
  type HeartbeatExecutionSource,
} from './heartbeat-template-runtime/runtime-helpers.js';

const log = createComponentLogger('HeartbeatTemplates');

export { formatReflectionPersonaBlock } from './heartbeat-template-runtime/prompt-formatting.js';

const DEFERRED_REFLECTION_RUN_TASK_PREFIX = 'reflection-run:deferred:';
const LEGACY_DEFERRED_REFLECTION_TASK_PREFIX = 'reflection:deferred:';
const DEFERRED_HEARTBEAT_ACTION_KIND = 'heartbeat.run_template';
const MIN_SCHEDULED_TEMPLATE_GAP_MS = 60_000;
const TEMPLATE_EXECUTION_BURST_WINDOW_MS = 60_000;
const TEMPLATE_EXECUTION_BURST_LIMIT = 4;
const TEMPLATE_EXECUTION_COOLDOWN_MS = 10 * 60_000;
const REFLECTION_MEMORY_EXTRACTION_DRAIN_TIMEOUT_MS = 2_500;
const REFLECTION_CONTACT_EMOTIONAL_TIME_SERIES_LIMIT = 8;

interface ReflectionMemoryRetrievalResult {
  memoryBlock?: string;
  provenanceRefs: string[];
}

interface ReflectionContactTelemetryDiagnostics {
  primarySessionId?: string;
  recentMessageCount: number;
  freshestLiveChatGapMs?: number;
  latestLiveActivityAgeMs?: number;
}

interface ReflectionContactContextResolution {
  bundle: ReflectionContactContextBundle | null;
  diagnostics: ReflectionContactTelemetryDiagnostics;
}

type ReflectionRequestSource = 'manual' | 'scheduled';
type ReflectionDeliberationExecutionResult = {
  reflection: string;
  metadata: ValuesDeliberationMetadata;
  metacognitiveFlags: ReflectionMetacognitiveFlag[];
};

interface ReflectionNoveltyGateOutcome {
  open: boolean;
  reason: string;
  inputs: Record<string, number | string>;
  scopeKey: string;
}

export interface HeartbeatTemplateRuntime {
  policyStore: HeartbeatPolicyStore;
  valuesJournal: ValuesJournalStore;
  initialPolicy: HeartbeatPolicy;
  runTemplateNow(
    templateId: string,
    options?: {
      sendToDiscordOverride?: boolean;
      deferIfBusy?: boolean;
      conversationScope?: ConversationScope;
    },
  ): Promise<HeartbeatRunTemplateResult>;
  runDeferredTemplate(
    templateId: string,
    options?: { sendToDiscordOverride?: boolean; actionId?: string; requestedSource?: ReflectionRequestSource },
  ): Promise<void>;
  syncReflectionTasks(): void;
}

interface CreateHeartbeatTemplateRuntimeOptions {
  scheduler: Scheduler;
  agentLoop: HeartbeatAgent;
  sender: MessageSender;
  dataDir: string;
  heartbeatChannelId?: string;
  runtimeOptions?: HeartbeatRuntimeOptions;
}

export function createHeartbeatTemplateRuntime(
  options: CreateHeartbeatTemplateRuntimeOptions,
): HeartbeatTemplateRuntime {
  const {
    scheduler,
    agentLoop,
    sender,
    dataDir,
    heartbeatChannelId,
    runtimeOptions = {},
  } = options;

  const store = new HeartbeatPolicyStore(resolveHeartbeatPolicyPath(dataDir));
  const valuesJournal = new ValuesJournalStore(resolveValuesJournalPath(dataDir), {
    legacyFilePaths: [resolveLegacyValuesJournalPath(dataDir)],
  });
  const reflectionJournal = new ReflectionJournalStore(resolveReflectionJournalPath(dataDir));
  const reflectionMetacognitionJournal = runtimeOptions.reflectionStore
    ?? new ReflectionMetacognitionJournalStore(resolveReflectionMetacognitionJournalPath(dataDir));
  const reflectionDailyJournal = new ReflectionDailyJournalStore(resolveReflectionDailyJournalsDir(dataDir));
  const reflectionProcessLog = new ReflectionProcessLogStore(resolveReflectionProcessLogsDir(dataDir));
  const initialPolicy = store.load();
  const pendingDeferredTemplates = new Set<string>();
  const lastScheduledRunAt = new Map<string, number>();
  const templateExecutionHistory = new Map<string, number[]>();
  const templateExecutionCooldownUntil = new Map<string, number>();

  const assertTemplateExecutionAllowed = (
    templateId: string,
    source: HeartbeatExecutionSource,
  ): void => {
    if (source === 'manual') {
      return;
    }

    const now = Date.now();
    const cooldownUntil = templateExecutionCooldownUntil.get(templateId);
    if (typeof cooldownUntil === 'number' && cooldownUntil > now) {
      throw new HeartbeatTemplateLoopGuardError(
        templateId,
        source,
        cooldownUntil,
        `Template "${templateId}" is temporarily suppressed by rapid-fire loop guard`,
      );
    }

    const recentRuns = (templateExecutionHistory.get(templateId) ?? [])
      .filter((timestamp) => now - timestamp <= TEMPLATE_EXECUTION_BURST_WINDOW_MS);
    recentRuns.push(now);
    templateExecutionHistory.set(templateId, recentRuns);

    if (recentRuns.length <= TEMPLATE_EXECUTION_BURST_LIMIT) {
      return;
    }

    const nextCooldownUntil = now + TEMPLATE_EXECUTION_COOLDOWN_MS;
    templateExecutionCooldownUntil.set(templateId, nextCooldownUntil);
    log.error('Suppressing reflection template due to rapid-fire loop guard', {
      templateId,
      source,
      burstCount: recentRuns.length,
      windowMs: TEMPLATE_EXECUTION_BURST_WINDOW_MS,
      cooldownUntil: new Date(nextCooldownUntil).toISOString(),
    });
    throw new HeartbeatTemplateLoopGuardError(
      templateId,
      source,
      nextCooldownUntil,
      `Template "${templateId}" exceeded rapid-fire burst limits`,
    );
  };

  const resolveReflectionNoveltyScopeKey = (
    canonicalContactId: string | undefined,
    groupScope: { channelId: string } | undefined,
  ): string => {
    if (groupScope) return `group:${groupScope.channelId}`;
    if (canonicalContactId) return `contact:${canonicalContactId}`;
    return 'substrate';
  };

  /**
   * jpvd.4 novelty gate for cadence-fired reflection templates: deterministic
   * "new scope entries since this template's last reflection" count against a
   * per-template/scope watermark. Opens with an explicit bypass reason when a
   * deterministic count is not available (no watermark store, no session
   * signal, or no live activity stream bound to the scope) — the gate never
   * guesses, and every consultation is visible through the typed gate event.
   */
  const evaluateReflectionNoveltyGate = async (
    template: ReflectionTemplate,
    reflectionChannelId: string,
    canonicalContactId: string | undefined,
    groupScope: { channelId: string } | undefined,
  ): Promise<ReflectionNoveltyGateOutcome> => {
    const scopeKey = resolveReflectionNoveltyScopeKey(canonicalContactId, groupScope);
    const minNewEntries = runtimeOptions.reflectionNoveltyGate?.minNewEntries
      ?? DEFAULT_REFLECTION_NOVELTY_GATE.minNewEntries;
    const baseInputs: Record<string, number | string> = {
      templateId: template.id,
      scope: scopeKey,
      minNewEntries,
    };

    const watermarkStore = runtimeOptions.episodicWatermarkStore;
    if (!watermarkStore) {
      return { open: true, reason: 'no_watermark_store', inputs: baseInputs, scopeKey };
    }
    const sessionManager = runtimeOptions.sessionManager;
    if (!sessionManager?.getRecentMessages) {
      return { open: true, reason: 'no_activity_signal', inputs: baseInputs, scopeKey };
    }

    let activitySessionId: string | undefined;
    if (groupScope) {
      activitySessionId = groupScope.channelId;
    } else if (canonicalContactId) {
      const contact = runtimeOptions.contactStore?.getById
        ? await runtimeOptions.contactStore.getById(canonicalContactId) as Contact | undefined
        : undefined;
      activitySessionId = resolveReflectionContactSessionId(contact ?? null, reflectionChannelId);
    }
    // The internal reflection channel is the reflection's own output stream,
    // not scope activity; counting it would let reflections feed themselves.
    if (!activitySessionId || activitySessionId === reflectionChannelId) {
      return { open: true, reason: 'no_activity_signal', inputs: baseInputs, scopeKey };
    }

    const watermark = await watermarkStore.getProcessingWatermark({
      processor: REFLECTION_NOVELTY_WATERMARK_PROCESSOR,
      sourceRef: template.id,
      channelId: scopeKey,
    });
    const watermarkMs = watermark?.lastProcessedAt
      ? Date.parse(watermark.lastProcessedAt)
      : Number.NaN;

    const newEntriesSinceLastReflection = sessionManager
      .getRecentMessages(activitySessionId, REFLECTION_NOVELTY_ENTRY_SCAN_LIMIT)
      .filter((entry) => {
        if (entry.role !== 'user' && entry.role !== 'assistant') return false;
        const timestamp = normalizeFiniteTimestamp((entry as { timestamp?: unknown }).timestamp);
        if (timestamp === undefined) return false;
        return !Number.isFinite(watermarkMs) || timestamp > watermarkMs;
      })
      .length;

    const decision = evaluateDeterministicGate(
      buildReflectionNoveltyGateDefinition(minNewEntries),
      {
        ...baseInputs,
        newEntriesSinceLastReflection,
        ...(Number.isFinite(watermarkMs)
          ? { lastReflectionAt: new Date(watermarkMs).toISOString() }
          : {}),
      },
    );
    return { open: decision.open, reason: decision.reason, inputs: decision.inputs as Record<string, number | string>, scopeKey };
  };

  const emitReflectionNoveltyGateEvent = async (
    outcome: 'ran' | 'skipped',
    gate: Pick<ReflectionNoveltyGateOutcome, 'reason' | 'inputs'>,
    reflectionChannelId: string,
  ): Promise<void> => {
    if (!runtimeOptions.eventBus) {
      return;
    }
    try {
      await runtimeOptions.eventBus.emit('reflection.template.novelty.gate', {
        lane: REFLECTION_NOVELTY_GATE_LANE,
        outcome,
        reason: gate.reason,
        inputs: gate.inputs,
        timestamp: Date.now(),
        channelId: reflectionChannelId,
      });
    } catch (error) {
      log.warn('Failed to emit reflection novelty gate telemetry', {
        outcome,
        reason: gate.reason,
        error: String(error),
      });
    }
  };

  /**
   * Advance the per-template/scope novelty watermark after a completed
   * reflection run (any execution source: a manual reflection also consumed
   * the scope's novelty). Failures are loud but do not fail the delivered
   * reflection; an unadvanced watermark only makes the next cadence run more
   * likely to fire.
   */
  const advanceReflectionNoveltyWatermark = async (
    template: ReflectionTemplate,
    canonicalContactId: string | undefined,
    groupScope: { channelId: string } | undefined,
  ): Promise<void> => {
    const watermarkStore = runtimeOptions.episodicWatermarkStore;
    if (!watermarkStore) {
      return;
    }
    const scopeKey = resolveReflectionNoveltyScopeKey(canonicalContactId, groupScope);
    const watermarkScope = {
      processor: REFLECTION_NOVELTY_WATERMARK_PROCESSOR,
      sourceRef: template.id,
      channelId: scopeKey,
    };
    try {
      const existing = await watermarkStore.getProcessingWatermark(watermarkScope);
      const nowIso = new Date().toISOString();
      await watermarkStore.upsertProcessingWatermark({
        ...watermarkScope,
        ...(existing?.id ? { id: existing.id } : {}),
        previousWatermarkJson: existing?.nextWatermarkJson ?? {},
        nextWatermarkJson: {
          lastReflection: { at: nowIso, templateId: template.id, scope: scopeKey },
        },
        status: 'active',
        reconciliationStatus: 'clean',
        lastProcessedAt: nowIso,
      });
    } catch (error) {
      log.warn('Reflection novelty watermark advance skipped', {
        templateId: template.id,
        scope: scopeKey,
        error: String(error),
      });
    }
  };

  let latestMetacognitiveFlags: ReflectionMetacognitiveFlag[] = [];

  const normalizeCanonicalContactId = (
    value: string | null | undefined,
  ): string | undefined => {
    if (typeof value !== 'string') {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  const resolveReflectionCanonicalContactId = (
    internalStateContext: ReflectionInternalStateContext | null,
  ): string | undefined => normalizeCanonicalContactId(
    internalStateContext?.internalState.relational.contactId
      ?? agentLoop.getCurrentInternalState?.()?.relational.contactId
      ?? undefined,
  );

  const awaitPendingReflectionExtractionDrain = async (
    reflectionChannelId: string,
    reflectionTemplate: ReflectionTemplate,
    reflectionCanonicalContactId?: string,
  ): Promise<void> => {
    const pendingExtractionPromise = agentLoop.memoryExtractor?.getPendingExtractionPromise?.(reflectionChannelId);
    if (!pendingExtractionPromise) {
      return;
    }

    const startedAt = Date.now();
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<
      { phase: 'timeout' }
    >((resolve) => {
      timeoutHandle = setTimeout(() => resolve({ phase: 'timeout' }), REFLECTION_MEMORY_EXTRACTION_DRAIN_TIMEOUT_MS);
    });
    const drainPromise = pendingExtractionPromise.then(
      () => ({ phase: 'completed' as const }),
      (error) => ({ phase: 'failed' as const, error }),
    );

    const outcome = await Promise.race([drainPromise, timeoutPromise]);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    const waitMs = Date.now() - startedAt;
    const telemetry = {
      channelId: reflectionChannelId,
      templateId: reflectionTemplate.id,
      templateName: reflectionTemplate.name,
      ...(reflectionCanonicalContactId ? { canonicalContactId: reflectionCanonicalContactId } : {}),
      timeoutMs: REFLECTION_MEMORY_EXTRACTION_DRAIN_TIMEOUT_MS,
      waitMs,
    };

    if (outcome.phase === 'completed') {
      log.debug('Pending memory extraction drained before reflection', telemetry);
      if (runtimeOptions.eventBus) {
        try {
          await runtimeOptions.eventBus.emit('memory.extraction.flush', {
            ...telemetry,
            phase: 'completed',
          });
        } catch (error) {
          log.warn('Failed to emit memory extraction flush telemetry', {
            ...telemetry,
            phase: 'completed',
            error: String(error),
          });
        }
      }
      return;
    }

    const error = outcome.phase === 'failed' ? String(outcome.error) : undefined;
    log.warn('Timed out waiting for pending memory extraction before reflection', {
      ...telemetry,
      phase: outcome.phase,
      ...(error ? { error } : {}),
    });
    if (runtimeOptions.eventBus) {
      try {
        await runtimeOptions.eventBus.emit('memory.extraction.flush', {
          ...telemetry,
          phase: outcome.phase,
          ...(error ? { error } : {}),
        });
      } catch (emitError) {
        log.warn('Failed to emit memory extraction flush telemetry', {
          ...telemetry,
          phase: outcome.phase,
          ...(error ? { error } : {}),
          emitError: String(emitError),
        });
      }
    }
  };

  const resolveReflectionContactSessionId = (
    contact: Contact | null,
    fallbackSessionId: string,
  ): string => {
    let bestSessionId = fallbackSessionId;
    let bestLastSeen = Number.NEGATIVE_INFINITY;

    for (const conversation of contact?.conversationChannels ?? []) {
      const channelId = conversation.channelId.trim();
      if (!channelId) {
        continue;
      }
      const lastSeen = Date.parse(conversation.lastSeen);
      if (Number.isNaN(lastSeen)) {
        continue;
      }
      if (lastSeen > bestLastSeen || (lastSeen === bestLastSeen && channelId.localeCompare(bestSessionId) < 0)) {
        bestLastSeen = lastSeen;
        bestSessionId = channelId;
      }
    }

    return bestSessionId;
  };

  const normalizeRecentReflectionMessage = (
    entry: { role: string; content: string; authorName?: string },
  ): ReflectionContactRecentMessage | null => {
    if (entry.role !== 'user' && entry.role !== 'assistant') {
      return null;
    }
    const content = entry.content.trim();
    if (!content) {
      return null;
    }
    return {
      role: entry.role,
      content,
      ...(typeof entry.authorName === 'string' && entry.authorName.trim().length > 0
        ? { authorName: entry.authorName.trim() }
        : {}),
    };
  };

  const normalizeReflectionConcern = (
    concern: ActiveConcernSnapshot,
  ): ReflectionContactActiveConcern | null => {
    const title = typeof concern.title === 'string' ? concern.title.trim() : '';
    const summary = typeof concern.summary === 'string' ? concern.summary.trim() : '';
    const text = [title, summary].filter(Boolean).join(': ').trim();
    if (!text) return null;
    return {
      ...(typeof concern.id === 'string' && concern.id.trim().length > 0 ? { id: concern.id.trim() } : {}),
      text,
      ...(typeof concern.priority === 'string'
        ? { priority: concern.priority as ReflectionContactActiveConcern['priority'] }
        : {}),
      ...(typeof concern.status === 'string' ? { source: concern.status } : {}),
      ...(typeof concern.dueAt === 'number' && Number.isFinite(concern.dueAt)
        ? { expiresAt: new Date(concern.dueAt).toISOString() }
        : {}),
    };
  };

  const retrieveReflectionMemoryBlock = async (input: {
    memoryProvider: { retrieve: (...args: any[]) => Promise<string> };
    queryText: string;
    reflectionChannelId: string;
    trustLevel?: string;
    reflectionCanonicalContactId: string;
    currentVAD?: { valence: number; arousal: number; dominance: number };
    reflectionPolicy: ReflectionIntrospectionPolicy;
  }): Promise<ReflectionMemoryRetrievalResult> => {
    const provenanceRefs = new Set<string>();
    const unsubscribe = runtimeOptions.eventBus?.on('memory.retrieval', (payload) => {
      if (payload.channelId !== input.reflectionChannelId) {
        return;
      }
      for (const ref of payload.provenanceRefs ?? []) {
        const normalized = ref.trim();
        if (normalized) provenanceRefs.add(normalized);
      }
    });

    try {
      const memoryBlock = await runWithRequestContext({
        channelId: input.reflectionChannelId,
        callType: 'background',
        originType: 'background',
        originStage: 'heartbeat.reflection.memory_retrieval',
        purpose: 'heartbeat.reflection.memory_retrieval',
      }, () => input.memoryProvider.retrieve(
        input.queryText,
        input.reflectionChannelId,
        input.trustLevel,
        undefined,
        input.reflectionCanonicalContactId,
        undefined,
        undefined,
        input.currentVAD,
        undefined,
        { retrievalMode: input.reflectionPolicy.memoryRetrievalModes },
        input.reflectionPolicy.memoryRetrievalModes,
      ));

      return {
        memoryBlock,
        provenanceRefs: [...provenanceRefs],
      };
    } finally {
      unsubscribe?.();
    }
  };

  const resolveReflectionContactContextBundle = async (
    template: ReflectionTemplate,
    reflectionPolicy: ReflectionIntrospectionPolicy,
    internalStateContext: ReflectionInternalStateContext | null,
    reflectionChannelId: string,
    reflectionCanonicalContactId: string | undefined,
  ): Promise<ReflectionContactContextResolution> => {
    if (!reflectionCanonicalContactId) {
      return {
        bundle: null,
        diagnostics: {
          recentMessageCount: 0,
        },
      };
    }

    const nowMs = Date.now();
    const contact = runtimeOptions.contactStore?.getById
      ? await runtimeOptions.contactStore.getById(reflectionCanonicalContactId) as Contact | undefined
      : undefined;
    const primarySessionId = resolveReflectionContactSessionId(
      contact ?? null,
      reflectionChannelId,
    );

    const recentSessionEntries = runtimeOptions.sessionManager?.getRecentMessages
      ? runtimeOptions.sessionManager.getRecentMessages(primarySessionId, 12)
      : [];
    const recentLiveActivityTimestamps = recentSessionEntries
      .filter((entry) => entry.role === 'user' || entry.role === 'assistant')
      .map(entry => normalizeFiniteTimestamp((entry as { timestamp?: unknown }).timestamp))
      .filter((timestamp): timestamp is number => timestamp !== undefined);
    const recentSessionMessages = recentSessionEntries
      .map(normalizeRecentReflectionMessage)
      .filter((message): message is ReflectionContactRecentMessage => message !== null);

    await awaitPendingReflectionExtractionDrain(
      primarySessionId,
      template,
      reflectionCanonicalContactId,
    );

    const currentInternalState = internalStateContext?.internalState
      ?? agentLoop.getCurrentInternalState?.()
      ?? null;
    const currentVAD = currentInternalState?.emotional.vad;
    const emotionalSnapshot = (
      reflectionCanonicalContactId && runtimeOptions.contactStore?.getEmotionalSnapshot
    )
      ? await runtimeOptions.contactStore.getEmotionalSnapshot(reflectionCanonicalContactId) ?? null
      : null;
    const reflectionEmotionalSnapshot: ReflectionContactEmotionalSnapshot | null = emotionalSnapshot
      ? {
        baselineValence: emotionalSnapshot.baselineValence,
        moodValence: emotionalSnapshot.moodValence,
        moodDrift: emotionalSnapshot.moodDrift,
        moodSamples: emotionalSnapshot.moodSamples,
        ...(emotionalSnapshot.lastMoodUpdateEpochMs !== undefined
          ? { lastMoodUpdateEpochMs: emotionalSnapshot.lastMoodUpdateEpochMs }
          : {}),
      }
      : null;
    const emotionalTimeSeries = (
      reflectionCanonicalContactId && runtimeOptions.contactStore?.getEmotionalTimeSeries
    )
      ? await runtimeOptions.contactStore.getEmotionalTimeSeries(
        reflectionCanonicalContactId,
        REFLECTION_CONTACT_EMOTIONAL_TIME_SERIES_LIMIT,
      )
      : [];
    const lastSeen = contact?.lastSeen ? contact.lastSeen.trim() : undefined;
    const lastSeenTimestamp = lastSeen ? Date.parse(lastSeen) : Number.NaN;
    const contactLastSeenGapMs = Number.isFinite(lastSeenTimestamp)
      ? Math.max(0, nowMs - lastSeenTimestamp)
      : undefined;
    const stateLastSeenDeltaMs = currentInternalState?.relational.lastSeenDeltaSeconds !== null
      && currentInternalState?.relational.lastSeenDeltaSeconds !== undefined
      ? Math.max(0, currentInternalState.relational.lastSeenDeltaSeconds * 1000)
      : undefined;
    const latestLiveActivityAtMs = recentLiveActivityTimestamps.length > 0
      ? Math.max(...recentLiveActivityTimestamps)
      : undefined;
    const latestLiveActivityAgeMs = latestLiveActivityAtMs !== undefined
      ? Math.max(0, nowMs - latestLiveActivityAtMs)
      : undefined;
    const lastSeenDeltaSeconds = contactLastSeenGapMs !== undefined
      ? Math.max(0, Math.floor(contactLastSeenGapMs / 1000))
      : currentInternalState?.relational.lastSeenDeltaSeconds ?? null;
    const trustLevel = contact?.trustLevel ?? currentInternalState?.relational.trustLevel;
    const contactDisplayName = contact?.displayName ?? contact?.nickname ?? undefined;

    const activeConcernsRaw = runtimeOptions.getActiveConcerns
      ? await Promise.resolve(runtimeOptions.getActiveConcerns({
        channelId: primarySessionId,
        canonicalContactKey: reflectionCanonicalContactId,
      }))
      : [];
    const activeConcerns = activeConcernsRaw
      .map(normalizeReflectionConcern)
      .filter((concern): concern is ReflectionContactActiveConcern => concern !== null);

    const pendingFollowUps = runtimeOptions.pendingFollowUpStore
      ? await runtimeOptions.pendingFollowUpStore.list({
        contactId: reflectionCanonicalContactId,
      })
      : [];

    const memoryProvider = (agentLoop as HeartbeatAgent & {
      memoryProvider?: {
        retrieve: (...args: any[]) => Promise<string>;
      };
    }).memoryProvider;

    const memoryRetrieval = memoryProvider
      ? await retrieveReflectionMemoryBlock({
        memoryProvider,
        queryText: [
          template.prompt,
          recentSessionMessages.map((message) => `${message.role}: ${message.content}`).join('\n'),
        ].filter(Boolean).join('\n\n'),
        reflectionChannelId,
        trustLevel,
        reflectionCanonicalContactId,
        currentVAD,
        reflectionPolicy,
      })
      : { provenanceRefs: [] };

    return {
      bundle: assembleReflectionContactContextBundle({
        contactId: reflectionCanonicalContactId,
        companionName: resolveCompanionNameFromCharacterVariables(runtimeOptions.characterPromptVariablesProvider),
        contactDisplayName,
        trustLevel,
        primarySessionId,
        lastSeen,
        lastSeenDeltaSeconds,
        emotionalSnapshot: reflectionEmotionalSnapshot,
        emotionalTimeSeries,
        recentSessionMessages,
        memoryBlock: memoryRetrieval.memoryBlock,
        memoryProvenanceRefs: memoryRetrieval.provenanceRefs,
        activeConcerns,
        pendingFollowUps,
      }),
      diagnostics: {
        primarySessionId,
        recentMessageCount: recentSessionMessages.length,
        freshestLiveChatGapMs: selectFreshestLiveChatGapMs(
          latestLiveActivityAgeMs,
          contactLastSeenGapMs,
          stateLastSeenDeltaMs,
        ),
        ...(latestLiveActivityAgeMs !== undefined ? { latestLiveActivityAgeMs } : {}),
      },
    };
  };

  const resolveReflectionSubstratePromptContext = (
    template: ReflectionTemplate,
  ): ReflectionSubstrateContext | null => {
    if (!template.internalStateInput && template.mode !== 'deliberation') {
      return null;
    }
    const context = assembleReflectionSubstrateContext({
      recentReflectionJournalEntries: reflectionJournal.listRecent({ limit: 2 }),
      recentDailyJournalEntries: reflectionDailyJournal.listRecent({ limit: 2 }),
      recentProcessLogEntries: reflectionProcessLog.listRecent({
        limit: 2,
        stages: ['completed', 'failed'],
      }),
    });
    return context;
  };

  const formatNarrativePromptInput = (
    prompt: string,
    reflectionBundle: ReflectionPromptSectionBundle | null,
    reflectionPolicyBlock: string,
  ): string => {
    // E6.2: her full persona leads the reflection (soft framing first), so a
    // scheduled introspection turn reflects as HER rather than as a context
    // analyzer. If the operator template places {{reflection_persona}} itself,
    // we honor that placement; otherwise the persona block leads the prompt.
    const personaBlock = formatReflectionPersonaBlock(
      runtimeOptions.characterPromptVariablesProvider?.(),
    );
    const promptPlacesPersona = prompt.includes(REFLECTION_PROMPT_TOKENS.persona);

    if (promptUsesReflectionMacros(prompt)) {
      const expandedPrompt = prompt
        .split(REFLECTION_PROMPT_TOKENS.persona).join(personaBlock)
        .split(REFLECTION_PROMPT_TOKENS.self).join(reflectionBundle?.self ?? '')
        .split(REFLECTION_PROMPT_TOKENS.relational).join(reflectionBundle?.relational ?? '')
        .split(REFLECTION_PROMPT_TOKENS.affect).join(reflectionBundle?.affect ?? '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      return joinReflectionPromptSections(
        promptPlacesPersona ? undefined : personaBlock,
        reflectionPolicyBlock,
        expandedPrompt,
      );
    }

    return joinReflectionPromptSections(
      personaBlock,
      reflectionPolicyBlock,
      prompt,
      reflectionBundle?.relational,
      reflectionBundle?.affect,
      reflectionBundle?.self,
    );
  };

  const captureResponseInternalStateContext = (
    response: Awaited<ReturnType<HeartbeatAgent['handleMessage']>>,
  ): ReflectionInternalStateContext | null => {
    const metadata = response.metadata;
    if (!metadata) {
      return null;
    }

    if (metadata.internalState === undefined && metadata.internalStateSnapshotRef === undefined && metadata.metacognitiveFlags === undefined) {
      return null;
    }

    if (metadata.internalState === undefined) {
      throw new Error('Heartbeat response metadata.internalState is required when snapshot metadata is provided');
    }

    const internalState = cloneInternalState(metadata.internalState);
    const providedSnapshotRef = normalizeSnapshotRef(
      metadata.internalStateSnapshotRef,
      'metadata.internalStateSnapshotRef',
    );
    const snapshotRef = providedSnapshotRef ?? buildInternalStateSnapshotRef(internalState);
    const metacognitiveFlags = normalizeMetacognitiveFlags(
      metadata.metacognitiveFlags,
      'metadata.metacognitiveFlags',
    );
    latestMetacognitiveFlags = metacognitiveFlags;
    return {
      internalState,
      internalStateSnapshotRef: snapshotRef,
      metacognitiveFlags,
      snapshotSource: providedSnapshotRef ? 'response' : 'derived_response',
    };
  };

  const toDeliberationMetadata = (
    result: DeliberationResult,
  ): ValuesDeliberationMetadata => ({
    sessionId: result.episode.id,
    stopReason: result.episode.exit.reason,
    rounds: result.rounds.length,
    totalInputTokens: result.totalInputTokens,
    totalOutputTokens: result.totalOutputTokens,
    totalTokens: result.totalTokens,
    estimatedCostUsd: result.estimatedCostUsd,
    durationMs: result.durationMs,
    episode: toDeliberationEpisodeMetadata(result.episode),
  });

  const toDeliberationEpisodeMetadata = (
    episode: DeliberationResult['episode'],
  ): ValuesDeliberationEpisodeMetadata => ({
    id: episode.id,
    kind: episode.kind,
    mode: episode.mode,
    budget: {
      maxRounds: episode.budget.maxRounds,
      maxTotalTokens: episode.budget.maxTotalTokens,
      maxWallTimeMs: episode.budget.maxWallTimeMs,
      ...(episode.budget.maxTokensPerRound !== undefined
        ? { maxTokensPerRound: episode.budget.maxTokensPerRound }
        : {}),
    },
    exit: {
      reason: episode.exit.reason,
      exhaustedBudget: episode.exit.exhaustedBudget,
      maxRoundsReached: episode.exit.maxRoundsReached,
      maxTotalTokensReached: episode.exit.maxTotalTokensReached,
      maxWallTimeReached: episode.exit.maxWallTimeReached,
      maxTokensPerRoundReached: episode.exit.maxTokensPerRoundReached,
      fatigueTapered: episode.exit.fatigueTapered,
    },
  });

  const resolveReflectionDeliberationCallType = (
    source: HeartbeatExecutionSource,
  ): ObservabilityCallType => (source === 'manual' ? 'background' : 'scheduled');

  const buildReflectionDeliberationCorrelation = (
    source: HeartbeatExecutionSource,
    reflectionChannelId: string,
    processId: string,
    originStage = 'heartbeat.deliberation',
  ) => {
    const callType = resolveReflectionDeliberationCallType(source);
    return {
      requestId: processId,
      channelId: reflectionChannelId,
      callType,
      originType: callType,
      originStage,
      purpose: originStage,
    };
  };

  const buildReflectionDeliberationOptions = (
    template: ReflectionTemplate,
    source: HeartbeatExecutionSource,
    reflectionChannelId: string,
    processId: string,
  ) => ({
    episode: {
      kind: 'maintenance_reflection' as const,
      mode: 'background_bounded' as const,
    },
    correlation: buildReflectionDeliberationCorrelation(source, reflectionChannelId, processId),
    ...(template.deliberation?.voices ? { voices: template.deliberation.voices } : {}),
    caps: {
      ...(template.deliberation?.maxRounds !== undefined
        ? { maxRounds: template.deliberation.maxRounds }
        : {}),
      ...(template.deliberation?.maxTotalTokens !== undefined
        ? { maxTotalTokens: template.deliberation.maxTotalTokens }
        : {}),
      ...(template.deliberation?.maxWallTimeMs !== undefined
        ? { maxWallTimeMs: template.deliberation.maxWallTimeMs }
        : {}),
    },
    cost: {
      ...(template.deliberation?.inputUsdPerMillionTokens !== undefined
        ? { inputUsdPerMillionTokens: template.deliberation.inputUsdPerMillionTokens }
        : {}),
      ...(template.deliberation?.outputUsdPerMillionTokens !== undefined
        ? { outputUsdPerMillionTokens: template.deliberation.outputUsdPerMillionTokens }
        : {}),
    },
  });

  const mergeInternalStateContextMetacognitiveFlags = (
    context: ReflectionInternalStateContext | null,
    flags: readonly ReflectionMetacognitiveFlag[],
  ): ReflectionInternalStateContext | null => {
    if (flags.length === 0 || !context) {
      return context;
    }
    const mergedFlags = mergeMetacognitiveFlags(context.metacognitiveFlags, flags);
    latestMetacognitiveFlags = mergedFlags;
    return {
      ...context,
      metacognitiveFlags: mergedFlags,
    };
  };

  const resolveReflectionInitiationContext = (
    source: HeartbeatExecutionSource,
    requestedSource: ReflectionRequestSource,
  ): { initiatorSurface: string; initiatedBy: string; reason: string } => {
    if (requestedSource === 'manual') {
      switch (source) {
        case 'deferred_scheduler':
          return {
            initiatorSurface: 'tool:schedule',
            initiatedBy: 'companion',
            reason: 'Manual reflection run deferred to the scheduler while the runtime was busy',
          };
        case 'deferred_post_turn':
          return {
            initiatorSurface: 'tool:schedule',
            initiatedBy: 'companion',
            reason: 'Manual reflection run deferred to post-turn execution while the runtime was busy',
          };
        case 'manual':
        default:
          return {
            initiatorSurface: 'tool:schedule',
            initiatedBy: 'companion',
            reason: 'Manual reflection run via schedule action=run_template',
          };
      }
    }

    switch (source) {
      case 'deferred_scheduler':
        return {
          initiatorSurface: 'scheduler:reflection_template',
          initiatedBy: 'scheduler',
          reason: 'Scheduled reflection resumed after busy runtime deferral',
        };
      case 'deferred_post_turn':
        return {
          initiatorSurface: 'scheduler:reflection_template',
          initiatedBy: 'scheduler',
          reason: 'Scheduled reflection resumed through post-turn execution after runtime deferral',
        };
      case 'scheduled':
      default:
        return {
          initiatorSurface: 'scheduler:reflection_template',
          initiatedBy: 'scheduler',
          reason: 'Scheduled reflection run',
        };
    }
  };

  const emitReflectionGuardrailTelemetry = async (input: {
    template: ReflectionTemplate;
    reflectionChannelId: string;
    executionSource: HeartbeatExecutionSource;
    reflectionMode: 'agent' | 'deliberation';
    canonicalContactId?: string;
    diagnostics: ReflectionContactTelemetryDiagnostics;
    persistenceContext: ReflectionInternalStateContext | null;
    summary: ReflectionGuardrailSummary;
  }): Promise<void> => {
    if (input.summary.warnings.length === 0) {
      return;
    }

    const warningCodes = input.summary.warnings.map(warning => warning.code);
    log.warn('Reflection guardrail warnings detected', {
      templateId: input.template.id,
      executionSource: input.executionSource,
      reflectionMode: input.reflectionMode,
      canonicalContactId: input.canonicalContactId ?? null,
      warningCodes,
      counters: input.summary.counters,
    });

    if (!runtimeOptions.eventBus) {
      return;
    }

    const callType = input.executionSource === 'manual' ? 'tool' : 'scheduled';
    try {
      await runtimeOptions.eventBus.emit('reflection.guardrail', {
        templateId: input.template.id,
        templateName: input.template.name,
        channelId: input.reflectionChannelId,
        executionSource: input.executionSource,
        reflectionMode: input.reflectionMode,
        timestamp: Date.now(),
        snapshotSource: input.persistenceContext?.snapshotSource ?? 'missing',
        warnings: input.summary.warnings,
        counters: input.summary.counters,
        ...(input.canonicalContactId ? { canonicalContactId: input.canonicalContactId } : {}),
        ...(input.diagnostics.primarySessionId ? { primarySessionId: input.diagnostics.primarySessionId } : {}),
        ...(input.persistenceContext?.internalStateSnapshotRef
          ? { internalStateSnapshotRef: input.persistenceContext.internalStateSnapshotRef }
          : {}),
        callType,
        originType: callType,
        originStage: 'reflection.guardrail',
        purpose: 'reflection.guardrail',
      });
    } catch (error) {
      log.warn('Failed to emit reflection guardrail telemetry', {
        templateId: input.template.id,
        warningCodes,
        error: String(error),
      });
    }
  };

  const persistDeliberationMemory = async (
    template: ReflectionTemplate,
    reflection: string,
    metadata: ValuesDeliberationMetadata,
  ): Promise<void> => {
    if (!runtimeOptions.memoryWriter) return;
    // Store the narrative paragraph as the memory; the full deliberation
    // output (including any fenced self-report artifact) already persists
    // in the reflection journal with provenance.
    await runtimeOptions.memoryWriter.write({
      text: compactMemoryTextForPrompt(reflection),
      type: 'reflection',
      importance: 0.72,
      confidence: 0.78,
      emotionalValence: 0,
      sourceRef:
        `source:heartbeat|template:${template.id}|mode:deliberation`
        + `|session:${metadata.sessionId}|tokens:${metadata.totalTokens}`
        + `|cost_usd:${metadata.estimatedCostUsd.toFixed(6)}`,
      tags: [
        'heartbeat',
        'reflection',
        'deliberation',
        template.id,
        `stop:${metadata.stopReason}`,
      ],
    });
  };

  const shouldUseDeliberation = (template: ReflectionTemplate): boolean => {
    if (template.mode !== 'deliberation') return false;
    return Boolean(runtimeOptions.llmProvider);
  };

  const normalizeTemplateReflectionOutput = (
    template: ReflectionTemplate,
    reflection: string,
  ): { reflection: string; silent: boolean } => {
    const trimmed = reflection.trim();
    const audit = getHeartbeatTemplateAuditProfile(template);
    if (
      audit.allowSilentInterval
      && (
        trimmed.length === 0
        || trimmed.toLowerCase() === HEARTBEAT_SILENT_REFLECTION_TOKEN
      )
    ) {
      return { reflection: '', silent: true };
    }
    return { reflection: trimmed, silent: false };
  };

  const runTemplateDeliberation = async (
    template: ReflectionTemplate,
    prompt: string,
    source: HeartbeatExecutionSource,
    reflectionChannelId: string,
    processId: string,
  ): Promise<ReflectionDeliberationExecutionResult> => {
    if (isExperientialDeliberationTemplate(template)) {
      return runExperientialTemplateDeliberation({
        llmProvider: runtimeOptions.llmProvider,
        template,
        prompt,
        correlation: buildReflectionDeliberationCorrelation(source, reflectionChannelId, processId),
        logger: log,
        toDeliberationMetadata,
      });
    }

    const llmProvider = runtimeOptions.llmProvider;
    if (!llmProvider) {
      throw new Error('Deliberation mode requested without llmProvider');
    }
    const result = await runDeliberation(
      llmProvider,
      prompt,
      buildReflectionDeliberationOptions(template, source, reflectionChannelId, processId),
    );
    return {
      reflection: result.output,
      metadata: toDeliberationMetadata(result),
      metacognitiveFlags: [],
    };
  };

  const executeTemplate = async (
    template: ReflectionTemplate,
    options: {
      sendToDiscordOverride?: boolean;
      requestedSource?: ReflectionRequestSource;
      /**
       * E1.7: explicit ConversationScope the reflection reflects over. A group
       * scope makes the reflection reflect on the ROOM (room-scoped context and
       * memories, no single canonical contact binding). Absent or dm-scoped
       * keeps the pre-E1.7 canonical-contact reflection behavior byte-identical.
       */
      conversationScope?: ConversationScope;
    } = {},
    source: HeartbeatExecutionSource = 'scheduled',
  ): Promise<Omit<HeartbeatRunTemplateResult, 'queued' | 'queuedVia' | 'deferredAction'>> => {
    assertTemplateExecutionAllowed(template.id, source);

    const requestedSource = options.requestedSource ?? (source === 'manual' ? 'manual' : 'scheduled');
    const reflectionChannelId = `internal:reflection:${template.id}`;
    const currentInternalState = template.internalStateInput
      ? agentLoop.getCurrentInternalState?.()
      : null;
    const internalStateContextResult = resolveInternalStateContext({
      template,
      currentInternalState,
      currentInternalStateSnapshotRef: currentInternalState
        ? agentLoop.getCurrentInternalStateSnapshotRef?.()
        : undefined,
      currentMetacognitiveFlags: currentInternalState
        ? agentLoop.getCurrentMetacognitiveFlags?.()
        : undefined,
      latestMetacognitiveFlags,
    });
    latestMetacognitiveFlags = internalStateContextResult.latestMetacognitiveFlags;
    const internalStateContext = internalStateContextResult.context;
    const reflectionCanonicalContactId = resolveReflectionCanonicalContactId(internalStateContext);
    // E1.7: only an explicit group scope diverges from today. It drops the single
    // canonical-contact binding and carries a room hint the turn pipeline rebuilds
    // the ConversationScope around.
    const reflectionGroupScope = options.conversationScope?.kind === 'group'
      ? options.conversationScope
      : undefined;
    const reflectionScopeHint: ReflectionScopeHint | undefined = reflectionGroupScope
      ? {
        kind: 'group',
        roomId: reflectionGroupScope.channelId,
        ...(reflectionGroupScope.roomName ? { roomName: reflectionGroupScope.roomName } : {}),
      }
      : undefined;
    // E1.7: a group-scoped reflection reflects on the ROOM, not a single
    // canonical contact. Suppress the DM-style canonical-contact binding so
    // introspection policy, contact-context grounding, and journal provenance
    // don't inherit a single-contact identity. The novelty gate still takes the
    // group scope separately, and the turn pipeline rebuilds the
    // ConversationScope from reflectionScopeHint.
    const reflectionGroundingContactId = reflectionGroupScope
      ? undefined
      : reflectionCanonicalContactId;

    // jpvd.4: only cadence-fired runs are novelty-gated. Manual run_template
    // invocations (including manual runs deferred through the scheduler or
    // post-turn queue) bypass the gate — an explicit operator/model request is
    // its own justification.
    if (requestedSource === 'scheduled') {
      const noveltyGate = await evaluateReflectionNoveltyGate(
        template,
        reflectionChannelId,
        reflectionCanonicalContactId,
        reflectionGroupScope,
      );
      if (!noveltyGate.open) {
        log.info('Skipped cadence reflection below novelty watermark', {
          templateId: template.id,
          executionSource: source,
          scope: noveltyGate.scopeKey,
          reason: noveltyGate.reason,
          inputs: noveltyGate.inputs,
        });
        await emitReflectionNoveltyGateEvent('skipped', noveltyGate, reflectionChannelId);
        return {
          templateId: template.id,
          templateName: template.name,
          reflection: '',
          noveltyGateSkipped: true,
        };
      }
      await emitReflectionNoveltyGateEvent('ran', noveltyGate, reflectionChannelId);
    }

    const plannedReflectionMode: 'agent' | 'deliberation' = shouldUseDeliberation(template)
      ? 'deliberation'
      : 'agent';
    const reflectionPolicy = resolveReflectionIntrospectionPolicy({
      template,
      canonicalContactId: reflectionGroundingContactId,
      reflectionMode: plannedReflectionMode,
    });
    const reflectionContactResolution = await resolveReflectionContactContextBundle(
      template,
      reflectionPolicy,
      internalStateContext,
      reflectionChannelId,
      reflectionGroundingContactId,
    );
    const reflectionContactContext = reflectionContactResolution.bundle;
    const reflectionSubstrateContext = resolveReflectionSubstratePromptContext(template);
    const reflectionCreatedAt = new Date(Date.now()).toISOString();
    const reflectionPromptContext: ReflectionPromptContext = {
      internalState: internalStateContext ?? undefined,
      contactBundle: reflectionContactContext ?? undefined,
      substrateContext: reflectionSubstrateContext ?? undefined,
    };
    const reflectionPromptBundle = mergeReflectionPromptBundles(
      reflectionPromptContext.contactBundle,
      buildInternalStatePromptBundle(reflectionPromptContext.internalState ?? null),
      reflectionPromptContext.substrateContext,
    );
    let reflectionGroundingProvenanceRefs = reflectionPromptBundle?.provenanceRefs ?? [];
    const reflectionPrompt = formatNarrativePromptInput(
      template.prompt,
      reflectionPromptBundle,
      formatReflectionIntrospectionPolicyBlock(reflectionPolicy),
    );
    let reflectionText = '';
    let silentInterval = false;
    let deliberationMetadata: ValuesDeliberationMetadata | undefined;
    let reflectionMode: 'agent' | 'deliberation' = 'agent';
    let persistenceContext = internalStateContext;
    let reflectionProcessId: string | undefined;

    if (shouldUseDeliberation(template)) {
      const processId = buildReflectionProcessId(`${template.id}-${source}`);
      reflectionProcessId = processId;
      try {
        reflectionProcessLog.append({
          processId,
          processLabel: `${template.name} deliberation`,
          processType: 'reflection_deliberation',
          stage: 'started',
          executionSource: source,
          createdAt: reflectionCreatedAt,
          templateId: template.id,
          templateName: template.name,
          channelId: reflectionChannelId,
          prompt: reflectionPrompt,
          tags: [template.id, 'reflection', 'deliberation'],
        });
      } catch (error) {
        log.warn(`Reflection "${template.id}" process-start log persistence skipped`, {
          error: String(error),
        });
      }

      try {
        const deliberationResult = await runTemplateDeliberation(
          template,
          reflectionPrompt,
          source,
          reflectionChannelId,
          processId,
        );
        const normalizedReflection = normalizeTemplateReflectionOutput(template, deliberationResult.reflection);
        reflectionText = normalizedReflection.reflection;
        silentInterval = normalizedReflection.silent;
        deliberationMetadata = deliberationResult.metadata;
        reflectionMode = 'deliberation';
        persistenceContext = mergeInternalStateContextMetacognitiveFlags(
          persistenceContext,
          deliberationResult.metacognitiveFlags,
        );

        try {
          reflectionProcessLog.append({
            processId,
            processLabel: `${template.name} deliberation`,
            processType: 'reflection_deliberation',
            stage: 'completed',
            executionSource: source,
            createdAt: new Date(Date.now()).toISOString(),
            templateId: template.id,
            templateName: template.name,
            channelId: reflectionChannelId,
            prompt: reflectionPrompt,
            ...(reflectionText ? { reflection: reflectionText } : {}),
            deliberation: deliberationMetadata,
            tags: [template.id, 'reflection', 'deliberation'],
          });
        } catch (error) {
          log.warn(`Reflection "${template.id}" process log persistence skipped`, {
            error: String(error),
          });
        }

        if (!silentInterval) {
          try {
            await persistDeliberationMemory(template, reflectionText, deliberationMetadata);
          } catch (error) {
            log.warn(`Reflection "${template.id}" memory persistence skipped`, {
              error: String(error),
            });
          }
        }
      } catch (error) {
        try {
          reflectionProcessLog.append({
            processId,
            processLabel: `${template.name} deliberation`,
            processType: 'reflection_deliberation',
            stage: 'failed',
            executionSource: source,
            createdAt: new Date(Date.now()).toISOString(),
            templateId: template.id,
            templateName: template.name,
            channelId: reflectionChannelId,
            prompt: reflectionPrompt,
            error: String(error),
            tags: [template.id, 'reflection', 'deliberation'],
          });
        } catch (processLogError) {
          log.warn(`Reflection "${template.id}" process-failure log persistence skipped`, {
            error: String(processLogError),
          });
        }
        throw error;
      }
    } else {
      // E1.7: reflection/heartbeat turns enter the same turn pipeline as chat
      // turns, so the turn's ConversationScope is resolved at session-manager
      // ingress from this message. A dm/absent scope keeps the internal-channel
      // canonical-contact binding byte-identical; an explicit group scope makes
      // the reflection reflect on the ROOM (room-scoped context/memories, no
      // single canonical contact) via the reflectionScope routing hint.
      const response = await agentLoop.handleMessage({
        id: `reflection-${template.id}-${Date.now()}`,
        channelId: reflectionChannelId,
        channelType: 'terminal',
        authorId: reflectionScopeHint ? 'scheduler' : (reflectionCanonicalContactId ?? 'scheduler'),
        authorName: template.name,
        content: reflectionPrompt,
        timestamp: new Date(),
        routing: {
          ...(reflectionScopeHint
            ? { reflectionScope: reflectionScopeHint }
            : (reflectionCanonicalContactId ? { canonicalContactId: reflectionCanonicalContactId } : {})),
          workerExecution: createWorkerExecutionPolicy(WHISPER_WORKER_LANE),
        },
      });
      const normalizedReflection = normalizeTemplateReflectionOutput(template, response.content);
      reflectionText = normalizedReflection.reflection;
      silentInterval = normalizedReflection.silent;
      const responseContext = captureResponseInternalStateContext(response);
      if (responseContext) {
        persistenceContext = responseContext;
      }
      const responseRetrievalProvenanceRefs = response.metadata?.retrievalProvenanceRefs ?? [];
      if (responseRetrievalProvenanceRefs.length > 0) {
        reflectionGroundingProvenanceRefs = [...new Set([
          ...reflectionGroundingProvenanceRefs,
          ...responseRetrievalProvenanceRefs.map(ref => ref.trim()).filter(Boolean),
        ])];
      }
    }

    const guardrailSummary = detectReflectionGuardrailWarnings({
      templateIntervalMs: template.intervalMs,
      ...(reflectionCanonicalContactId ? { canonicalContactId: reflectionCanonicalContactId } : {}),
      ...(reflectionContactResolution.diagnostics.primarySessionId
        ? { primarySessionId: reflectionContactResolution.diagnostics.primarySessionId }
        : {}),
      recentMessageCount: reflectionContactResolution.diagnostics.recentMessageCount,
      ...(reflectionContactResolution.diagnostics.freshestLiveChatGapMs !== undefined
        ? { freshestLiveChatGapMs: reflectionContactResolution.diagnostics.freshestLiveChatGapMs }
        : {}),
      ...(reflectionContactResolution.diagnostics.latestLiveActivityAgeMs !== undefined
        ? { latestLiveActivityAgeMs: reflectionContactResolution.diagnostics.latestLiveActivityAgeMs }
        : {}),
      reflectionText,
      internalStateSnapshotRef: persistenceContext?.internalStateSnapshotRef,
      snapshotSource: persistenceContext?.snapshotSource ?? 'missing',
      ...(normalizeCanonicalContactId(persistenceContext?.internalState.relational.contactId)
        ? { internalStateContactId: normalizeCanonicalContactId(persistenceContext?.internalState.relational.contactId) }
        : {}),
    });
    await emitReflectionGuardrailTelemetry({
      template,
      reflectionChannelId,
      executionSource: source,
      reflectionMode,
      canonicalContactId: reflectionCanonicalContactId,
      diagnostics: reflectionContactResolution.diagnostics,
      persistenceContext,
      summary: guardrailSummary,
    });

    const journalGroundingProvenanceRefs = mergeReflectionGroundingProvenanceRefs(
      reflectionGroundingProvenanceRefs,
      {
        ...(persistenceContext?.internalStateSnapshotRef
          ? { internalStateSnapshotRef: persistenceContext.internalStateSnapshotRef }
          : {}),
        ...(reflectionGroundingContactId ? { canonicalContactId: reflectionGroundingContactId } : {}),
      },
    );
    const supportGapFlags = buildUnsupportedReflectionSupportFlags(
      reflectionText,
      journalGroundingProvenanceRefs,
    );
    const persistedMetacognitiveFlags = mergeMetacognitiveFlags(
      persistenceContext?.metacognitiveFlags,
      supportGapFlags,
    );
    const persistenceContextForJournal = persistenceContext
      ? {
        ...persistenceContext,
        metacognitiveFlags: persistedMetacognitiveFlags,
      }
      : null;

    let reflectionJournalEntryId: string | undefined;
    let dailyJournalEntryId: string | undefined;
    if (!silentInterval) {
      try {
        const reflectionEntry = reflectionJournal.append({
          templateId: template.id,
          templateName: template.name,
          prompt: reflectionPrompt,
          reflection: reflectionText,
          channelId: reflectionChannelId,
          mode: reflectionMode,
          createdAt: reflectionCreatedAt,
          ...(deliberationMetadata ? { deliberation: deliberationMetadata } : {}),
          ...(persistenceContextForJournal ? {
            internalStateSnapshotRef: persistenceContextForJournal.internalStateSnapshotRef,
            internalState: persistenceContextForJournal.internalState,
            metacognitiveFlags: persistenceContextForJournal.metacognitiveFlags,
          } : {}),
          ...(journalGroundingProvenanceRefs.length > 0 ? {
            ...(reflectionSubstrateContext ? { substrateBoundary: reflectionSubstrateContext.canonicalTruthBoundary } : {}),
            substrateProvenanceRefs: journalGroundingProvenanceRefs,
          } : {}),
        });
        reflectionJournalEntryId = reflectionEntry.id;
      } catch (error) {
        log.warn(`Reflection "${template.id}" note journal persistence skipped`, {
          error: String(error),
        });
      }

      try {
        const dailyEntry = reflectionDailyJournal.append({
          source: 'heartbeat_template',
          executionSource: source,
          templateId: template.id,
          templateName: template.name,
          channelId: reflectionChannelId,
          prompt: reflectionPrompt,
          reflection: reflectionText,
          mode: reflectionMode,
          createdAt: reflectionCreatedAt,
          ...(reflectionJournalEntryId ? { reflectionJournalEntryId } : {}),
          ...(reflectionProcessId ? { processId: reflectionProcessId } : {}),
          tags: [template.id, 'reflection', reflectionMode],
        });
        dailyJournalEntryId = dailyEntry.id;
      } catch (error) {
        log.warn(`Reflection "${template.id}" daily journal persistence skipped`, {
          error: String(error),
        });
      }

      const shouldSendToDiscord = options.sendToDiscordOverride ?? template.sendToDiscord;
      const sendToDiscordEffective = Boolean(shouldSendToDiscord && heartbeatChannelId);
      const initiationContext = resolveReflectionInitiationContext(source, requestedSource);

      await reflectionMetacognitionJournal.append({
        kind: 'reflection_run',
        occurredAt: reflectionCreatedAt,
        templateId: template.id,
        templateName: template.name,
        executionSource: source,
        initiatorSurface: initiationContext.initiatorSurface,
        initiatedBy: initiationContext.initiatedBy,
        reason: initiationContext.reason,
        channelId: reflectionChannelId,
        sendToDiscordEffective,
        mode: reflectionMode,
        prompt: reflectionPrompt,
        reflection: reflectionText,
        ...(persistenceContextForJournal ? {
          internalStateSnapshotRef: persistenceContextForJournal.internalStateSnapshotRef,
        } : {}),
        ...(persistedMetacognitiveFlags.length > 0
          ? { metacognitiveFlags: persistedMetacognitiveFlags }
          : {}),
        ...(reflectionJournalEntryId ? { reflectionJournalEntryId } : {}),
        ...(dailyJournalEntryId ? { dailyJournalEntryId } : {}),
        ...(reflectionProcessId ? { processId: reflectionProcessId } : {}),
        ...(deliberationMetadata ? { deliberation: deliberationMetadata } : {}),
        ...(journalGroundingProvenanceRefs.length > 0 ? {
          ...(reflectionSubstrateContext ? { substrateBoundary: reflectionSubstrateContext.canonicalTruthBoundary } : {}),
          substrateProvenanceRefs: journalGroundingProvenanceRefs,
        } : {}),
      });

      if (isValuesReflectionTemplateId(template.id)) {
        valuesJournal.append({
          templateId: template.id,
          templateName: template.name,
          prompt: reflectionPrompt,
          reflection: reflectionText,
          ...(deliberationMetadata ? { deliberation: deliberationMetadata } : {}),
          ...(persistenceContextForJournal ? {
            internalStateSnapshotRef: persistenceContextForJournal.internalStateSnapshotRef,
            internalState: persistenceContextForJournal.internalState,
            metacognitiveFlags: persistenceContextForJournal.metacognitiveFlags,
          } : {}),
          provenance: {
            source: 'companion_reflection',
            templateId: template.id,
            templateName: template.name,
            channelId: reflectionChannelId,
            mode: reflectionMode,
            ...(reflectionJournalEntryId ? { reflectionJournalEntryId } : {}),
          },
        });
      }

      if (runtimeOptions.vaultAutoPublisher) {
        try {
          await runtimeOptions.vaultAutoPublisher.publishReflection({
            templateId: template.id,
            templateName: template.name,
            reflection: reflectionText,
            mode: reflectionMode,
            createdAt: new Date(),
          });
        } catch (error) {
          log.warn(`Reflection "${template.id}" vault publish skipped`, { error: String(error) });
        }
      }
    }

    const shouldSendToDiscord = options.sendToDiscordOverride ?? template.sendToDiscord;
    if (!silentInterval && shouldSendToDiscord && heartbeatChannelId) {
      await sender.send(heartbeatChannelId, reflectionText);
    }

    await advanceReflectionNoveltyWatermark(
      template,
      reflectionCanonicalContactId,
      reflectionGroupScope,
    );

    return {
      templateId: template.id,
      templateName: template.name,
      reflection: reflectionText,
      ...(silentInterval ? { silent: true } : {}),
    };
  };

  const executeScheduledTemplate = async (template: ReflectionTemplate): Promise<void> => {
    const now = Date.now();
    const lastRunAt = lastScheduledRunAt.get(template.id);
    if (lastRunAt !== undefined && now - lastRunAt < MIN_SCHEDULED_TEMPLATE_GAP_MS) {
      log.warn(`Skipping reflection "${template.id}" due to rapid re-fire guard`, {
        templateId: template.id,
        sinceLastMs: now - lastRunAt,
      });
      return;
    }
    lastScheduledRunAt.set(template.id, now);
    try {
      await executeTemplate(template, {}, 'scheduled');
    } catch (error) {
      if (isHeartbeatTemplateLoopGuardError(error)) {
        log.warn('Scheduled reflection suppressed by rapid-fire loop guard', {
          templateId: template.id,
          source: error.source,
          cooldownUntil: new Date(error.cooldownUntil).toISOString(),
        });
        return;
      }
      if (!isBusyTurnError(error)) {
        throw error;
      }
      const deferred = queueDeferredTemplateRun(template.id, { requestedSource: 'scheduled' });
      log.info('Deferred scheduled reflection template execution', {
        templateId: template.id,
        queuedNow: deferred.queuedNow,
      });
    }
  };

  const buildDeferredHeartbeatAction = (
    template: ReflectionTemplate,
    options: { sendToDiscordOverride?: boolean } = {},
  ): PostTurnActionCandidate => ({
    kind: DEFERRED_HEARTBEAT_ACTION_KIND,
    payload: {
      templateId: template.id,
      ...(options.sendToDiscordOverride !== undefined
        ? { sendToDiscordOverride: options.sendToDiscordOverride }
        : {}),
    },
    dedupeKey: (
      options.sendToDiscordOverride === undefined
        ? `${DEFERRED_HEARTBEAT_ACTION_KIND}:${template.id}`
        : `${DEFERRED_HEARTBEAT_ACTION_KIND}:${template.id}:discord:${String(options.sendToDiscordOverride)}`
    ),
    maxRetries: 2,
  });

  const queueDeferredTemplateRun = (
    templateId: string,
    options: { sendToDiscordOverride?: boolean; requestedSource?: ReflectionRequestSource } = {},
  ): { templateName: string; queuedNow: boolean; requestedSource: ReflectionRequestSource } => {
    const requestedSource = options.requestedSource ?? 'scheduled';
    const current = store.load();
    const template = findReflectionTemplateById(current, templateId);
    if (!template) {
      throw new Error(`Template "${templateId}" not found`);
    }
    if (pendingDeferredTemplates.has(template.id)) {
      return { templateName: template.name, queuedNow: false, requestedSource };
    }

    pendingDeferredTemplates.add(template.id);
    const taskId = `${DEFERRED_REFLECTION_RUN_TASK_PREFIX}${requestedSource}:${template.id}:${Date.now()}`;
    try {
      scheduler.register({
        id: taskId,
        name: `Deferred ${requestedSource} reflection run: ${template.name}`,
        type: 'one-shot',
        intervalMs: 0,
        runAt: Date.now() + 250,
        handler: async () => {
          try {
            await agentLoop.waitForIdle?.();
            const latestPolicy = store.load();
            const latestTemplate = latestPolicy.templates.find(candidate => candidate.id === template.id);
            if (!latestTemplate) {
              log.warn('Skipped deferred reflection; template removed before execution', {
                templateId: template.id,
                taskId,
              });
              return;
            }
            await executeTemplate(latestTemplate, { ...options, requestedSource }, 'deferred_scheduler');
          } catch (error) {
            if (isHeartbeatTemplateLoopGuardError(error)) {
              log.warn(`Deferred reflection "${template.id}" suppressed by rapid-fire loop guard`, {
                templateId: template.id,
                source: error.source,
                cooldownUntil: new Date(error.cooldownUntil).toISOString(),
              });
              return;
            }
            log.error(`Deferred reflection "${template.id}" failed`, { error: String(error) });
          } finally {
            pendingDeferredTemplates.delete(template.id);
          }
        },
        state: 'idle',
      });
      return { templateName: template.name, queuedNow: true, requestedSource };
    } catch (error) {
      pendingDeferredTemplates.delete(template.id);
      throw error;
    }
  };

  const runTemplateNow = async (
    templateId: string,
    options: {
      sendToDiscordOverride?: boolean;
      deferIfBusy?: boolean;
      conversationScope?: ConversationScope;
    } = {},
  ): Promise<HeartbeatRunTemplateResult> => {
    const current = store.load();
    const template = findReflectionTemplateById(current, templateId);
    if (!template) {
      throw new Error(`Template "${templateId}" not found`);
    }
    try {
      return await executeTemplate(template, { ...options, requestedSource: 'manual' }, 'manual');
    } catch (error) {
      if (options.deferIfBusy === false || !isBusyTurnError(error)) {
        throw error;
      }
      if (runtimeOptions.postTurnActions) {
        const deferredAction = buildDeferredHeartbeatAction(template, options);
        log.info('Inferred deferred heartbeat action from busy template execution', {
          templateId: template.id,
          dedupeKey: deferredAction.dedupeKey,
        });
        return {
          templateId: template.id,
          templateName: template.name,
          reflection: '',
          queued: true,
          queuedVia: 'post_turn',
          deferredAction,
        };
      }

      const deferred = queueDeferredTemplateRun(template.id, {
        sendToDiscordOverride: options.sendToDiscordOverride,
        requestedSource: 'manual',
      });
      log.info('Deferred manual reflection template execution', {
        templateId: template.id,
        queuedNow: deferred.queuedNow,
      });
      return {
        templateId: template.id,
        templateName: deferred.templateName,
        reflection: '',
        queued: true,
        queuedVia: 'scheduler',
        deferredAction: buildDeferredHeartbeatAction(template, options),
      };
    }
  };

  const runDeferredTemplate = async (
    templateId: string,
    options: { sendToDiscordOverride?: boolean; actionId?: string; requestedSource?: ReflectionRequestSource } = {},
  ): Promise<void> => {
    const current = store.load();
    const template = findReflectionTemplateById(current, templateId);
    if (!template) {
      throw new Error(`Template "${templateId}" not found`);
    }
    try {
      await executeTemplate(template, {
        ...(options.sendToDiscordOverride !== undefined
          ? { sendToDiscordOverride: options.sendToDiscordOverride }
          : {}),
        requestedSource: options.requestedSource ?? 'manual',
      }, 'deferred_post_turn');
    } catch (error) {
      if (isHeartbeatTemplateLoopGuardError(error)) {
        log.warn(`Deferred heartbeat action "${options.actionId ?? templateId}" suppressed by rapid-fire loop guard`, {
          templateId,
          source: error.source,
          cooldownUntil: new Date(error.cooldownUntil).toISOString(),
        });
        return;
      }
      throw error;
    }
  };

  const syncReflectionTasks = (): void => {
    for (const task of scheduler.listTasks()) {
      if (task.id.startsWith('reflection:') && !task.id.startsWith(LEGACY_DEFERRED_REFLECTION_TASK_PREFIX)) {
        scheduler.unregister(task.id);
      }
    }

    const current = store.load();
    for (const template of current.templates) {
      if (!template.enabled) continue;
      scheduler.register(
        {
          id: `reflection:${template.id}`,
          name: template.name,
          type: 'every',
          intervalMs: template.intervalMs,
          cadence: template.cadence,
          handler: async () => {
            try {
              await executeScheduledTemplate(template);
            } catch (err) {
              log.error(`Reflection "${template.id}" error`, { error: String(err) });
            }
          },
          state: 'idle',
        },
        { skipFirstRun: true },
      );
    }

    const activeCount = current.templates.filter(t => t.enabled).length;
    log.info(`Synced ${activeCount} reflection tasks`);
  };

  syncReflectionTasks();

  return {
    policyStore: store,
    valuesJournal,
    initialPolicy,
    runTemplateNow,
    runDeferredTemplate,
    syncReflectionTasks,
  };
}
