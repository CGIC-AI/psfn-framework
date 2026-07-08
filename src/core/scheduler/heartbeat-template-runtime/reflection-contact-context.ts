import type { ActiveConcernSnapshot } from '../../intention/appraisal.js';
import type { Contact } from '../../contacts/types.js';
import {
  assembleReflectionContactContextBundle,
  type ReflectionContactActiveConcern,
  type ReflectionContactContextBundle,
  type ReflectionContactEmotionalSnapshot,
  type ReflectionContactRecentMessage,
} from '../../../persistence/journals/reflection-substrate.js';
import { runWithRequestContext } from '../../../primitives/llm/request-context.js';
import type { ReflectionTemplate } from '../heartbeat-policy.js';
import type {
  HeartbeatAgent,
  HeartbeatRuntimeOptions,
} from '../heartbeat-runtime-contracts.js';
import type { ReflectionIntrospectionPolicy } from '../reflection-introspection-policy.js';
import type { ReflectionInternalStateContext } from './prompt-formatting.js';
import {
  normalizeFiniteTimestamp,
  resolveCompanionNameFromCharacterVariables,
  selectFreshestLiveChatGapMs,
} from './runtime-helpers.js';
import { resolveReflectionContactSessionId } from './reflection-contact-session.js';

const REFLECTION_MEMORY_EXTRACTION_DRAIN_TIMEOUT_MS = 2_500;
const REFLECTION_CONTACT_EMOTIONAL_TIME_SERIES_LIMIT = 8;

interface ReflectionContactContextLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

interface ReflectionMemoryRetrievalResult {
  memoryBlock?: string;
  provenanceRefs: string[];
}

export interface ReflectionContactTelemetryDiagnostics {
  primarySessionId?: string;
  recentMessageCount: number;
  freshestLiveChatGapMs?: number;
  latestLiveActivityAgeMs?: number;
}

export interface ReflectionContactContextResolution {
  bundle: ReflectionContactContextBundle | null;
  diagnostics: ReflectionContactTelemetryDiagnostics;
}

export function normalizeRecentReflectionMessage(
  entry: { role: string; content: string; authorName?: string },
): ReflectionContactRecentMessage | null {
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
}

export function normalizeReflectionConcern(
  concern: ActiveConcernSnapshot,
): ReflectionContactActiveConcern | null {
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
}

export async function retrieveReflectionMemoryBlock(input: {
  memoryProvider: { retrieve: (...args: unknown[]) => Promise<string> };
  queryText: string;
  reflectionChannelId: string;
  trustLevel?: string;
  reflectionCanonicalContactId: string;
  currentVAD?: { valence: number; arousal: number; dominance: number };
  reflectionPolicy: ReflectionIntrospectionPolicy;
  runtimeOptions: HeartbeatRuntimeOptions;
}): Promise<ReflectionMemoryRetrievalResult> {
  const provenanceRefs = new Set<string>();
  const unsubscribe = input.runtimeOptions.eventBus?.on('memory.retrieval', (payload) => {
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
}

export async function awaitPendingReflectionExtractionDrain(input: {
  channelId: string;
  reflectionTemplate: ReflectionTemplate;
  reflectionCanonicalContactId?: string;
  agentLoop: HeartbeatAgent;
  runtimeOptions: HeartbeatRuntimeOptions;
  logger: ReflectionContactContextLogger;
}): Promise<void> {
  const {
    channelId,
    reflectionTemplate,
    reflectionCanonicalContactId,
    agentLoop,
    runtimeOptions,
    logger,
  } = input;
  const pendingExtractionPromise = agentLoop.memoryExtractor?.getPendingExtractionPromise?.(channelId);
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
    channelId,
    templateId: reflectionTemplate.id,
    templateName: reflectionTemplate.name,
    ...(reflectionCanonicalContactId ? { canonicalContactId: reflectionCanonicalContactId } : {}),
    timeoutMs: REFLECTION_MEMORY_EXTRACTION_DRAIN_TIMEOUT_MS,
    waitMs,
  };

  if (outcome.phase === 'completed') {
    logger.debug('Pending memory extraction drained before reflection', telemetry);
    if (runtimeOptions.eventBus) {
      try {
        await runtimeOptions.eventBus.emit('memory.extraction.flush', {
          ...telemetry,
          phase: 'completed',
        });
      } catch (error) {
        logger.warn('Failed to emit memory extraction flush telemetry', {
          ...telemetry,
          phase: 'completed',
          error: String(error),
        });
      }
    }
    return;
  }

  const error = outcome.phase === 'failed' ? String(outcome.error) : undefined;
  logger.warn('Timed out waiting for pending memory extraction before reflection', {
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
      logger.warn('Failed to emit memory extraction flush telemetry', {
        ...telemetry,
        phase: outcome.phase,
        ...(error ? { error } : {}),
        emitError: String(emitError),
      });
    }
  }
}

export async function resolveReflectionContactContextBundle(input: {
  template: ReflectionTemplate;
  reflectionPolicy: ReflectionIntrospectionPolicy;
  internalStateContext: ReflectionInternalStateContext | null;
  reflectionChannelId: string;
  reflectionCanonicalContactId: string | undefined;
  runtimeOptions: HeartbeatRuntimeOptions;
  agentLoop: HeartbeatAgent;
  logger: ReflectionContactContextLogger;
}): Promise<ReflectionContactContextResolution> {
  const {
    template,
    reflectionPolicy,
    internalStateContext,
    reflectionChannelId,
    reflectionCanonicalContactId,
    runtimeOptions,
    agentLoop,
    logger,
  } = input;

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

  await awaitPendingReflectionExtractionDrain({
    channelId: primarySessionId,
    reflectionTemplate: template,
    reflectionCanonicalContactId,
    agentLoop,
    runtimeOptions,
    logger,
  });

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
      retrieve: (...args: unknown[]) => Promise<string>;
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
      runtimeOptions,
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
}
