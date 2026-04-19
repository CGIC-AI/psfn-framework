import { randomUUID } from 'node:crypto';
import type { Scheduler } from './scheduler.js';
import type { MessageSender } from '../../system/lifecycle/notifications.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { ActiveConcernSnapshot } from '../intention/appraisal.js';
import {
  HEARTBEAT_SILENT_REFLECTION_TOKEN,
  HeartbeatPolicyStore,
  type HeartbeatPolicy,
  type ReflectionTemplate,
} from './heartbeat-policy.js';
import { ValuesJournalStore } from '../../faculties/values/store.js';
import type { ValuesDeliberationMetadata } from '../../faculties/values/store.js';
import type { CompletionPurpose, ContextMessage, PostTurnActionCandidate } from '../../shared/contracts/runtime.js';
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
  serializeInternalState,
  type InternalState,
} from '../self-model/state.js';
import {
  WHISPER_WORKER_LANE,
  createWorkerExecutionPolicy,
} from '../agent/worker-lanes.js';
import {
  detectReflectionGuardrailWarnings,
  type ReflectionGuardrailSnapshotSource,
  type ReflectionGuardrailSummary,
} from './reflection-guardrail-telemetry.js';

const log = createComponentLogger('HeartbeatTemplates');

const DEFERRED_REFLECTION_RUN_TASK_PREFIX = 'reflection-run:deferred:';
const LEGACY_DEFERRED_REFLECTION_TASK_PREFIX = 'reflection:deferred:';
const DEFERRED_HEARTBEAT_ACTION_KIND = 'heartbeat.run_template';
const MIN_SCHEDULED_TEMPLATE_GAP_MS = 60_000;
const TEMPLATE_EXECUTION_BURST_WINDOW_MS = 60_000;
const TEMPLATE_EXECUTION_BURST_LIMIT = 4;
const TEMPLATE_EXECUTION_COOLDOWN_MS = 10 * 60_000;
const REFLECTION_MEMORY_EXTRACTION_DRAIN_TIMEOUT_MS = 2_500;
const REFLECTION_CONTACT_EMOTIONAL_TIME_SERIES_LIMIT = 8;
const EXPERIENTIAL_DELIBERATION_TEMPLATE_IDS = new Set(['daily-review', 'emotional-check', 'goal-update']);
const DELIBERATION_DEFAULT_INPUT_USD_PER_MILLION_TOKENS = 2;
const DELIBERATION_DEFAULT_OUTPUT_USD_PER_MILLION_TOKENS = 8;
const MAX_UNSUPPORTED_CLAIM_FLAGS = 4;
const REFLECTION_PROMPT_TOKENS = {
  self: '{{reflection_self}}',
  relational: '{{reflection_relational}}',
  affect: '{{reflection_affect}}',
} as const;

interface ReflectionMetacognitiveFlag {
  flag: string;
  confidence: number;
  evidence?: string;
}

interface ReflectionInternalStateContext {
  internalState: InternalState;
  internalStateSnapshotRef: string;
  metacognitiveFlags: ReflectionMetacognitiveFlag[];
  snapshotSource: ReflectionGuardrailSnapshotSource;
}

type ReflectionPromptSectionBundle = Pick<
  ReflectionContactContextBundle,
  'self' | 'relational' | 'affect' | 'provenanceRefs'
>;

interface ReflectionPromptContext {
  internalState?: ReflectionInternalStateContext;
  contactBundle?: ReflectionContactContextBundle;
  substrateContext?: ReflectionSubstrateContext;
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

function getHeartbeatTemplateAuditProfile(
  _template: ReflectionTemplate,
): { allowSilentInterval: boolean } {
  return { allowSilentInterval: false };
}

type HeartbeatExecutionSource = 'manual' | 'scheduled' | 'deferred_scheduler' | 'deferred_post_turn';
type ReflectionRequestSource = 'manual' | 'scheduled';
type ReflectionDeliberationExecutionResult = {
  reflection: string;
  metadata: ValuesDeliberationMetadata;
  metacognitiveFlags: ReflectionMetacognitiveFlag[];
};
type ExperientialReflectionStage = 'evidence' | 'synthesis' | 'contradiction';

class HeartbeatTemplateLoopGuardError extends Error {
  readonly templateId: string;
  readonly source: HeartbeatExecutionSource;
  readonly cooldownUntil: number;

  constructor(
    templateId: string,
    source: HeartbeatExecutionSource,
    cooldownUntil: number,
    message: string,
  ) {
    super(message);
    this.name = 'HeartbeatTemplateLoopGuardError';
    this.templateId = templateId;
    this.source = source;
    this.cooldownUntil = cooldownUntil;
  }
}

function isHeartbeatTemplateLoopGuardError(
  error: unknown,
): error is HeartbeatTemplateLoopGuardError {
  return error instanceof HeartbeatTemplateLoopGuardError;
}

function joinReflectionPromptSections(...sections: Array<string | undefined>): string {
  return sections
    .map(section => section?.trim() ?? '')
    .filter(section => section.length > 0)
    .join('\n\n');
}

function promptUsesReflectionMacros(prompt: string): boolean {
  return Object.values(REFLECTION_PROMPT_TOKENS).some(token => prompt.includes(token));
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function estimateDeliberationCostUsd(
  inputTokens: number,
  outputTokens: number,
  inputUsdPerMillionTokens: number,
  outputUsdPerMillionTokens: number,
): number {
  return (
    (Math.max(0, inputTokens) * Math.max(0, inputUsdPerMillionTokens))
    + (Math.max(0, outputTokens) * Math.max(0, outputUsdPerMillionTokens))
  ) / 1_000_000;
}

function normalizeFiniteTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function selectFreshestLiveChatGapMs(...values: Array<number | null | undefined>): number | undefined {
  const finiteValues = values
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  if (finiteValues.length === 0) {
    return undefined;
  }
  return Math.min(...finiteValues);
}

function extractEmbeddedJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    const body = fenced[1].trim();
    if (body.startsWith('{') && body.endsWith('}')) {
      return body;
    }
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return null;
}

function normalizeUnsupportedClaimFlags(raw: unknown): ReflectionMetacognitiveFlag[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const flags: ReflectionMetacognitiveFlag[] = [];
  for (const [index, entry] of raw.entries()) {
    if (flags.length >= MAX_UNSUPPORTED_CLAIM_FLAGS) {
      break;
    }
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const claim = typeof (entry as { claim?: unknown }).claim === 'string'
      ? (entry as { claim: string }).claim.trim()
      : '';
    if (!claim) {
      continue;
    }

    const reason = typeof (entry as { reason?: unknown }).reason === 'string'
      ? (entry as { reason: string }).reason.trim()
      : '';
    const confidence = clampUnit(
      typeof (entry as { confidence?: unknown }).confidence === 'number'
        ? (entry as { confidence: number }).confidence
        : 0.68,
    );

    flags.push({
      flag: 'unsupported_claim',
      confidence: Number(confidence.toFixed(4)),
      evidence: reason ? `${claim} :: ${reason}` : claim,
    });

    if (index >= MAX_UNSUPPORTED_CLAIM_FLAGS - 1) {
      break;
    }
  }

  return flags;
}

function mergeMetacognitiveFlags(
  ...groups: ReadonlyArray<readonly ReflectionMetacognitiveFlag[] | null | undefined>
): ReflectionMetacognitiveFlag[] {
  const merged = new Map<string, ReflectionMetacognitiveFlag>();

  for (const group of groups) {
    for (const flag of group ?? []) {
      const key = `${flag.flag}::${flag.evidence ?? ''}`;
      const existing = merged.get(key);
      if (!existing || flag.confidence > existing.confidence) {
        merged.set(key, flag);
      }
    }
  }

  return [...merged.values()];
}

function isExperientialDeliberationTemplate(template: ReflectionTemplate): boolean {
  return EXPERIENTIAL_DELIBERATION_TEMPLATE_IDS.has(template.id);
}

function mergeReflectionPromptBundles(
  ...bundles: Array<ReflectionPromptSectionBundle | null | undefined>
): ReflectionPromptSectionBundle | null {
  const self = joinReflectionPromptSections(...bundles.map(bundle => bundle?.self));
  const relational = joinReflectionPromptSections(...bundles.map(bundle => bundle?.relational));
  const affect = joinReflectionPromptSections(...bundles.map(bundle => bundle?.affect));
  const provenanceRefs = [...new Set(
    bundles.flatMap(bundle => bundle?.provenanceRefs ?? []),
  )];

  if (!self && !relational && !affect && provenanceRefs.length === 0) {
    return null;
  }

  return {
    self,
    relational,
    affect,
    provenanceRefs,
  };
}

export interface HeartbeatTemplateRuntime {
  policyStore: HeartbeatPolicyStore;
  valuesJournal: ValuesJournalStore;
  initialPolicy: HeartbeatPolicy;
  runTemplateNow(
    templateId: string,
    options?: { sendToDiscordOverride?: boolean; deferIfBusy?: boolean },
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

  let latestMetacognitiveFlags: ReflectionMetacognitiveFlag[] = [];

  const normalizeMetacognitiveFlags = (
    value: unknown,
    context: string,
  ): ReflectionMetacognitiveFlag[] => {
    if (value === undefined || value === null) {
      return [];
    }
    if (!Array.isArray(value)) {
      throw new Error(`${context} must be an array when provided`);
    }
    return value.map((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        throw new Error(`${context}[${String(index)}] must be an object`);
      }
      const flagRaw = (entry as { flag?: unknown }).flag;
      if (typeof flagRaw !== 'string' || flagRaw.trim().length === 0) {
        throw new Error(`${context}[${String(index)}].flag must be a non-empty string`);
      }
      const confidenceRaw = (entry as { confidence?: unknown }).confidence;
      if (typeof confidenceRaw !== 'number' || !Number.isFinite(confidenceRaw) || confidenceRaw < 0 || confidenceRaw > 1) {
        throw new Error(`${context}[${String(index)}].confidence must be a finite number in [0, 1]`);
      }
      const evidenceRaw = (entry as { evidence?: unknown }).evidence;
      if (evidenceRaw !== undefined && (typeof evidenceRaw !== 'string' || evidenceRaw.trim().length === 0)) {
        throw new Error(`${context}[${String(index)}].evidence must be a non-empty string when provided`);
      }
      return {
        flag: flagRaw.trim(),
        confidence: Number(confidenceRaw.toFixed(4)),
        ...(typeof evidenceRaw === 'string' ? { evidence: evidenceRaw.trim() } : {}),
      };
    });
  };

  const normalizeSnapshotRef = (value: unknown, fieldName: string): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${fieldName} must be a non-empty string when provided`);
    }
    return value.trim();
  };

  const resolveInternalStateContext = (
    template: ReflectionTemplate,
  ): ReflectionInternalStateContext | null => {
    if (!template.internalStateInput) {
      return null;
    }

    const currentInternalState = agentLoop.getCurrentInternalState?.();
    if (!currentInternalState) {
      throw new Error(`Template "${template.id}" requires InternalState input, but no InternalState snapshot is available`);
    }

    const normalizedState = cloneInternalState(currentInternalState);
    const providedSnapshotRef = normalizeSnapshotRef(
      agentLoop.getCurrentInternalStateSnapshotRef?.(),
      'getCurrentInternalStateSnapshotRef result',
    );
    const snapshotRef = providedSnapshotRef ?? buildInternalStateSnapshotRef(normalizedState);
    const rawMetacognitiveFlags = agentLoop.getCurrentMetacognitiveFlags?.();
    const metacognitiveFlags = rawMetacognitiveFlags !== undefined
      ? normalizeMetacognitiveFlags(rawMetacognitiveFlags, 'getCurrentMetacognitiveFlags result')
      : latestMetacognitiveFlags;
    latestMetacognitiveFlags = metacognitiveFlags;

    return {
      internalState: normalizedState,
      internalStateSnapshotRef: snapshotRef,
      metacognitiveFlags,
      snapshotSource: providedSnapshotRef ? 'runtime' : 'derived_runtime',
    };
  };

  const formatInternalStateContextBlock = (
    context: ReflectionInternalStateContext | null,
  ): string | null => {
    if (!context) {
      return null;
    }

    const concerns = context.internalState.attention.activeConcerns
      .slice(0, 12)
      .map((concern) => `[${concern.priority}|${concern.source}] ${concern.text}`);
    const concernSection = concerns.length > 0
      ? concerns.map((concern) => `- ${concern}`).join('\n')
      : '- none';
    const metacognitiveSection = context.metacognitiveFlags.length > 0
      ? context.metacognitiveFlags
        .map((flag) => `- ${flag.flag} (confidence=${flag.confidence.toFixed(2)})${flag.evidence ? ` evidence: ${flag.evidence}` : ''}`)
        .join('\n')
      : '- none exposed';

    return [
      '[Internal State Input]',
      `snapshot_ref: ${context.internalStateSnapshotRef}`,
      `serialized_internal_state: ${serializeInternalState(context.internalState)}`,
      '[Recent Metacognitive Flags]',
      metacognitiveSection,
      '[Active Concerns]',
      concernSection,
    ].join('\n');
  };

  const buildInternalStatePromptBundle = (
    context: ReflectionInternalStateContext | null,
  ): ReflectionPromptSectionBundle | null => {
    const block = formatInternalStateContextBlock(context);
    if (!block) {
      return null;
    }

    return {
      self: block,
      relational: '',
      affect: '',
      provenanceRefs: [`internal_state_snapshot:${context?.internalStateSnapshotRef ?? 'unknown'}`],
    };
  };

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

  const resolveReflectionContactContextBundle = async (
    template: ReflectionTemplate,
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

    const pendingFollowUps = runtimeOptions.pendingFollowUpStore?.getPendingFollowUps
      ? await runtimeOptions.pendingFollowUpStore.getPendingFollowUps(reflectionCanonicalContactId)
      : [];

    const memoryProvider = (agentLoop as HeartbeatAgent & {
      memoryProvider?: {
        retrieve: (...args: any[]) => Promise<string>;
      };
    }).memoryProvider;

    const memoryBlock = memoryProvider
      ? await memoryProvider.retrieve(
        [
          template.prompt,
          recentSessionMessages.map((message) => `${message.role}: ${message.content}`).join('\n'),
        ].filter(Boolean).join('\n\n'),
        reflectionChannelId,
        trustLevel,
        undefined,
        reflectionCanonicalContactId,
        undefined,
        undefined,
        currentVAD,
        undefined,
        { retrievalMode: 'reflection' },
      )
      : undefined;

    return {
      bundle: assembleReflectionContactContextBundle({
        contactId: reflectionCanonicalContactId,
        contactDisplayName,
        trustLevel,
        primarySessionId,
        lastSeen,
        lastSeenDeltaSeconds,
        emotionalSnapshot,
        emotionalTimeSeries,
        recentSessionMessages,
        memoryBlock,
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
    context: ReflectionPromptContext,
  ): string => {
    const reflectionBundle = mergeReflectionPromptBundles(
      context.contactBundle,
      buildInternalStatePromptBundle(context.internalState ?? null),
      context.substrateContext,
    );

    if (promptUsesReflectionMacros(prompt)) {
      return prompt
        .split(REFLECTION_PROMPT_TOKENS.self).join(reflectionBundle?.self ?? '')
        .split(REFLECTION_PROMPT_TOKENS.relational).join(reflectionBundle?.relational ?? '')
        .split(REFLECTION_PROMPT_TOKENS.affect).join(reflectionBundle?.affect ?? '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    return joinReflectionPromptSections(
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
    sessionId: result.sessionId,
    stopReason: result.stopReason,
    rounds: result.rounds.length,
    totalInputTokens: result.totalInputTokens,
    totalOutputTokens: result.totalOutputTokens,
    totalTokens: result.totalTokens,
    estimatedCostUsd: result.estimatedCostUsd,
    durationMs: result.durationMs,
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

  const buildExperientialEvidenceMessages = (
    template: ReflectionTemplate,
    prompt: string,
  ): { systemPrompt: string; messages: ContextMessage[]; purpose: CompletionPurpose } => ({
    systemPrompt:
      `You are the evidence pass for the experiential reflection template "${template.name}". `
      + 'Extract only observations that are directly grounded in the supplied reflection context. '
      + 'Return 3-6 bullet points. Do not speculate and do not invent support.',
    messages: [{
      role: 'user',
      content: [
        `Template: ${template.name} (${template.id})`,
        'Stage: evidence',
        'Reflection context:',
        prompt,
      ].join('\n\n'),
    }],
    purpose: template.deliberation?.voices?.[0] ?? 'background',
  });

  const buildExperientialSynthesisMessages = (
    template: ReflectionTemplate,
    prompt: string,
    evidence: string,
  ): { systemPrompt: string; messages: ContextMessage[]; purpose: CompletionPurpose } => ({
    systemPrompt:
      `You are the synthesis pass for the experiential reflection template "${template.name}". `
      + 'Write a grounded reflection using only the supplied evidence. '
      + 'Keep it to 2-5 sentences and make uncertainty explicit when the evidence is partial.',
    messages: [{
      role: 'user',
      content: [
        `Template: ${template.name} (${template.id})`,
        'Stage: synthesis',
        'Original reflection context:',
        prompt,
        'Grounded evidence:',
        evidence,
      ].join('\n\n'),
    }],
    purpose: template.deliberation?.voices?.[1] ?? template.deliberation?.voices?.[0] ?? 'reasoning',
  });

  const buildExperientialContradictionMessages = (
    template: ReflectionTemplate,
    prompt: string,
    evidence: string,
    synthesis: string,
  ): { systemPrompt: string; messages: ContextMessage[]; purpose: CompletionPurpose } => ({
    systemPrompt:
      `You are the contradiction pass for the experiential reflection template "${template.name}". `
      + 'Compare the candidate reflection against the grounded evidence. '
      + 'Return strict JSON with keys "revisedReflection" and "unsupportedClaims". '
      + '"unsupportedClaims" must be an array of objects with "claim", "reason", and "confidence" in [0,1]. '
      + 'If every claim is supported, return an empty array and preserve the reflection.',
    messages: [{
      role: 'user',
      content: [
        `Template: ${template.name} (${template.id})`,
        'Stage: contradiction',
        'Original reflection context:',
        prompt,
        'Grounded evidence:',
        evidence,
        'Candidate reflection:',
        synthesis,
        'Return JSON only.',
      ].join('\n\n'),
    }],
    purpose: 'reasoning',
  });

  const parseExperientialContradictionResponse = (
    raw: string,
    fallbackReflection: string,
  ): { revisedReflection: string; metacognitiveFlags: ReflectionMetacognitiveFlag[] } => {
    const jsonObject = extractEmbeddedJsonObject(raw);
    if (!jsonObject) {
      return {
        revisedReflection: fallbackReflection,
        metacognitiveFlags: [],
      };
    }

    try {
      const parsed = JSON.parse(jsonObject) as {
        revisedReflection?: unknown;
        unsupportedClaims?: unknown;
      };
      const revisedReflection = typeof parsed.revisedReflection === 'string'
        && parsed.revisedReflection.trim().length > 0
        ? parsed.revisedReflection.trim()
        : fallbackReflection;
      return {
        revisedReflection,
        metacognitiveFlags: normalizeUnsupportedClaimFlags(parsed.unsupportedClaims),
      };
    } catch (error) {
      log.warn('Experiential contradiction pass returned invalid JSON; preserving synthesis', {
        error: String(error),
      });
      return {
        revisedReflection: fallbackReflection,
        metacognitiveFlags: [],
      };
    }
  };

  const runExperientialTemplateDeliberation = async (
    template: ReflectionTemplate,
    prompt: string,
  ): Promise<ReflectionDeliberationExecutionResult> => {
    const llmProvider = runtimeOptions.llmProvider;
    if (!llmProvider) {
      throw new Error('Experiential deliberation requested without llmProvider');
    }

    const startedAt = Date.now();
    const sessionId = randomUUID();
    const maxTotalTokens = Math.max(256, Math.floor(template.deliberation?.maxTotalTokens ?? 6_000));
    const maxWallTimeMs = Math.max(250, Math.floor(template.deliberation?.maxWallTimeMs ?? 35_000));
    const inputUsdPerMillionTokens = template.deliberation?.inputUsdPerMillionTokens
      ?? DELIBERATION_DEFAULT_INPUT_USD_PER_MILLION_TOKENS;
    const outputUsdPerMillionTokens = template.deliberation?.outputUsdPerMillionTokens
      ?? DELIBERATION_DEFAULT_OUTPUT_USD_PER_MILLION_TOKENS;

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let estimatedCostUsd = 0;
    let completedRounds = 0;
    let stopReason: ValuesDeliberationMetadata['stopReason'] = 'max_rounds';
    let evidence = '';
    let synthesis = '';
    let finalReflection = '';
    let metacognitiveFlags: ReflectionMetacognitiveFlag[] = [];

    const runStage = async (
      stage: ExperientialReflectionStage,
      builder: () => { systemPrompt: string; messages: ContextMessage[]; purpose: CompletionPurpose },
    ): Promise<string | null> => {
      if (Date.now() - startedAt >= maxWallTimeMs) {
        stopReason = 'time_cap';
        return null;
      }
      if (totalInputTokens + totalOutputTokens >= maxTotalTokens) {
        stopReason = 'token_cap';
        return null;
      }

      const stageStartedAt = Date.now();
      const { systemPrompt, messages, purpose } = builder();
      const response = await llmProvider.complete({ systemPrompt, messages }, purpose);
      const content = response.content.trim();

      totalInputTokens += response.inputTokens;
      totalOutputTokens += response.outputTokens;
      estimatedCostUsd += estimateDeliberationCostUsd(
        response.inputTokens,
        response.outputTokens,
        inputUsdPerMillionTokens,
        outputUsdPerMillionTokens,
      );
      completedRounds += 1;

      const elapsed = Date.now() - startedAt;
      if (elapsed >= maxWallTimeMs) {
        stopReason = 'time_cap';
      } else if (totalInputTokens + totalOutputTokens >= maxTotalTokens) {
        stopReason = 'token_cap';
      }

      log.debug('Completed experiential reflection deliberation stage', {
        templateId: template.id,
        stage,
        purpose,
        durationMs: Date.now() - stageStartedAt,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
      });

      return content;
    };

    const evidenceResult = await runStage(
      'evidence',
      () => buildExperientialEvidenceMessages(template, prompt),
    );
    if (evidenceResult) {
      evidence = evidenceResult;
      finalReflection = evidenceResult;
    }

    const synthesisResult = await runStage(
      'synthesis',
      () => buildExperientialSynthesisMessages(template, prompt, evidence || prompt),
    );
    if (synthesisResult) {
      synthesis = synthesisResult;
      finalReflection = synthesisResult;
    }

    const contradictionResult = await runStage(
      'contradiction',
      () => buildExperientialContradictionMessages(
        template,
        prompt,
        evidence || prompt,
        synthesis || finalReflection || evidence || prompt,
      ),
    );
    if (contradictionResult) {
      const parsedContradiction = parseExperientialContradictionResponse(
        contradictionResult,
        synthesis || finalReflection || evidence || prompt,
      );
      metacognitiveFlags = parsedContradiction.metacognitiveFlags;
      finalReflection = parsedContradiction.revisedReflection;
    }

    return {
      reflection: finalReflection.trim() || synthesis.trim() || evidence.trim() || prompt.trim(),
      metadata: {
        sessionId,
        stopReason,
        rounds: completedRounds,
        totalInputTokens,
        totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        estimatedCostUsd,
        durationMs: Math.max(0, Date.now() - startedAt),
      },
      metacognitiveFlags,
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
            initiatorSurface: 'tool:heartbeat_run_template',
            initiatedBy: 'companion',
            reason: 'Manual reflection run deferred to the scheduler while the runtime was busy',
          };
        case 'deferred_post_turn':
          return {
            initiatorSurface: 'tool:heartbeat_run_template',
            initiatedBy: 'companion',
            reason: 'Manual reflection run deferred to post-turn execution while the runtime was busy',
          };
        case 'manual':
        default:
          return {
            initiatorSurface: 'tool:heartbeat_run_template',
            initiatedBy: 'companion',
            reason: 'Manual reflection run via heartbeat_run_template',
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
    await runtimeOptions.memoryWriter.write({
      text: reflection,
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
  ): Promise<ReflectionDeliberationExecutionResult> => {
    if (isExperientialDeliberationTemplate(template)) {
      return runExperientialTemplateDeliberation(template, prompt);
    }

    const llmProvider = runtimeOptions.llmProvider;
    if (!llmProvider) {
      throw new Error('Deliberation mode requested without llmProvider');
    }
    const result = await runDeliberation(
      llmProvider,
      prompt,
      {
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
      },
    );
    return {
      reflection: result.output,
      metadata: toDeliberationMetadata(result),
      metacognitiveFlags: [],
    };
  };

  const executeTemplate = async (
    template: ReflectionTemplate,
    options: { sendToDiscordOverride?: boolean; requestedSource?: ReflectionRequestSource } = {},
    source: HeartbeatExecutionSource = 'scheduled',
  ): Promise<Omit<HeartbeatRunTemplateResult, 'queued' | 'queuedVia' | 'deferredAction'>> => {
    assertTemplateExecutionAllowed(template.id, source);

    const requestedSource = options.requestedSource ?? (source === 'manual' ? 'manual' : 'scheduled');
    const reflectionChannelId = `internal:reflection:${template.id}`;
    const internalStateContext = resolveInternalStateContext(template);
    const reflectionCanonicalContactId = resolveReflectionCanonicalContactId(internalStateContext);
    const reflectionContactResolution = await resolveReflectionContactContextBundle(
      template,
      internalStateContext,
      reflectionChannelId,
      reflectionCanonicalContactId,
    );
    const reflectionContactContext = reflectionContactResolution.bundle;
    const reflectionSubstrateContext = resolveReflectionSubstratePromptContext(template);
    const reflectionCreatedAt = new Date(Date.now()).toISOString();
    const reflectionPrompt = formatNarrativePromptInput(
      template.prompt,
      {
        internalState: internalStateContext ?? undefined,
        contactBundle: reflectionContactContext ?? undefined,
        substrateContext: reflectionSubstrateContext ?? undefined,
      },
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
        const deliberationResult = await runTemplateDeliberation(template, reflectionPrompt);
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
      const response = await agentLoop.handleMessage({
        id: `reflection-${template.id}-${Date.now()}`,
        channelId: reflectionChannelId,
        channelType: 'terminal',
        authorId: reflectionCanonicalContactId ?? 'scheduler',
        authorName: template.name,
        content: reflectionPrompt,
        timestamp: new Date(),
        routing: {
          ...(reflectionCanonicalContactId ? { canonicalContactId: reflectionCanonicalContactId } : {}),
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
          ...(persistenceContext ? {
            internalStateSnapshotRef: persistenceContext.internalStateSnapshotRef,
            internalState: persistenceContext.internalState,
            metacognitiveFlags: persistenceContext.metacognitiveFlags,
          } : {}),
          ...(reflectionSubstrateContext ? {
            substrateBoundary: reflectionSubstrateContext.canonicalTruthBoundary,
            substrateProvenanceRefs: reflectionSubstrateContext.provenanceRefs,
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
        ...(persistenceContext ? {
          internalStateSnapshotRef: persistenceContext.internalStateSnapshotRef,
          ...(persistenceContext.metacognitiveFlags.length > 0
            ? { metacognitiveFlags: persistenceContext.metacognitiveFlags }
            : {}),
        } : {}),
        ...(reflectionJournalEntryId ? { reflectionJournalEntryId } : {}),
        ...(dailyJournalEntryId ? { dailyJournalEntryId } : {}),
        ...(reflectionProcessId ? { processId: reflectionProcessId } : {}),
        ...(deliberationMetadata ? { deliberation: deliberationMetadata } : {}),
        ...(reflectionSubstrateContext ? {
          substrateBoundary: reflectionSubstrateContext.canonicalTruthBoundary,
          substrateProvenanceRefs: reflectionSubstrateContext.provenanceRefs,
        } : {}),
      });

      if (template.id === 'values-reflection') {
        valuesJournal.append({
          templateId: template.id,
          templateName: template.name,
          prompt: reflectionPrompt,
          reflection: reflectionText,
          ...(deliberationMetadata ? { deliberation: deliberationMetadata } : {}),
          ...(persistenceContext ? {
            internalStateSnapshotRef: persistenceContext.internalStateSnapshotRef,
            internalState: persistenceContext.internalState,
            metacognitiveFlags: persistenceContext.metacognitiveFlags,
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
    const template = current.templates.find(candidate => candidate.id === templateId);
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
    options: { sendToDiscordOverride?: boolean; deferIfBusy?: boolean } = {},
  ): Promise<HeartbeatRunTemplateResult> => {
    const current = store.load();
    const template = current.templates.find(candidate => candidate.id === templateId);
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
    const template = current.templates.find(candidate => candidate.id === templateId);
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
