import type { AgentMessage } from '../../../boundary/pi-agent/index.js';
import type { LLMProviderPort, MemoryExtractor } from '../contracts.js';
import type { AgentResponse, SubstrateMessage, TurnRecord } from '../../../shared/contracts/runtime.js';
import type { SessionManager } from '../../session/manager.js';
import type { CapturedSessionReads } from '../../session/manager/captured-session-owner.js';
import type {
  IntentionPostTurnHookContext,
  IntentionPostTurnHookRunOptions,
} from '../substrate-agent/post-turn-actions.js';
import {
  selectEmotionAppraisalSourceEntries,
  type EmotionSelfModelRuntime,
} from '../substrate-agent/emotion-self-model-runtime.js';
import {
  BackgroundWorkDeferredError,
  BackgroundWorkPermanentError,
  type BackgroundWorkExecutionInput,
} from './supervisor.js';
import {
  fingerprintBackgroundWorkTurnRecord,
  type BackgroundWorkPayload,
  type BackgroundWorkSourceRef,
} from './types.js';
import type { BackgroundWorkPostTurnTuning } from './config.js';
import { buildSubsystemOutputRef } from '../../../shared/contracts/subsystem-output-refs.js';
import { extractTurnRecordSelfSnapshotRef } from '../../../shared/contracts/turn-record-internal-state-ref.js';
import type { SocialDesireFeltSignalWriter } from '../../intention/social-desire-felt-signal.js';
import { runWithRequestContext } from '../../../primitives/llm/request-context.js';
import { RUNTIME_LANE_CLASSES } from '../../../shared/contracts/runtime-lanes.js';

export type PostTurnBackgroundSessionManager = Pick<
  SessionManager,
  | 'createCapturedSessionReads'
  | 'lookupSourceRecordedTurnEligibility'
  | 'withStableRecordedTurnEligibilitySnapshot'
  | 'withSourceRecordedTurnEligibilityFence'
>;

type AdmittedPostTurnBackgroundSessionManager = Omit<
  PostTurnBackgroundSessionManager,
  'createCapturedSessionReads'
>;

export interface PostTurnBackgroundRuntimeDependencies {
  sessionManager: PostTurnBackgroundSessionManager;
  llmProvider: LLMProviderPort;
  getMemoryExtractor: () => MemoryExtractor | null;
  runIntentionPostTurnHooks: (
    context: IntentionPostTurnHookContext,
    options?: IntentionPostTurnHookRunOptions,
  ) => Promise<void>;
  emotionRuntime: Pick<EmotionSelfModelRuntime, 'triggerEmotionAppraisal'>;
  getEmotionTemplateVariables: () => Record<string, string>;
  tuning: BackgroundWorkPostTurnTuning;
  /**
   * Social-desire accumulation writer (psfn-framework-hrmrq.85). When composed,
   * every bounded-turn intention job records the deterministic felt social
   * signal before intention hooks. This keeps accumulation independent of the
   * drift-only narrative lane. Absent only when the social-desire lane is
   * disabled (lane registration fails closed on the mismatch).
   */
  socialDesireFeltSignals?: SocialDesireFeltSignalWriter;
}

type AdmittedPostTurnBackgroundRuntimeDependencies = Omit<
  PostTurnBackgroundRuntimeDependencies,
  'sessionManager'
> & {
  sessionManager: AdmittedPostTurnBackgroundSessionManager;
};

function runWithPostTurnUsageAttribution<T>(
  record: TurnRecord,
  source: BackgroundWorkSourceRef,
  originStage: 'extraction' | 'emotion.appraisal',
  operation: () => Promise<T>,
): Promise<T> {
  return runWithRequestContext({
    sessionId: source.logicalSessionId,
    channelId: source.channelId,
    channelType: record.channelType,
    turnId: record.turnId,
    requestId: record.requestId,
    callType: 'background',
    purpose: originStage,
    originType: 'background',
    originStage,
    runtimeLaneClass: originStage === 'extraction'
      ? RUNTIME_LANE_CLASSES.maintenanceReflection
      : RUNTIME_LANE_CLASSES.backgroundContinuation,
    workloadType: 'background_work',
    workloadId: `${originStage}:${source.turnId}`,
    ...(record.icpCorrelation ? { icpCorrelation: record.icpCorrelation } : {}),
  }, operation);
}

async function requireCanonicalTurnRecord(
  source: BackgroundWorkSourceRef,
  dependencies: AdmittedPostTurnBackgroundRuntimeDependencies,
): Promise<TurnRecord> {
  const eligibility = await dependencies.sessionManager.lookupSourceRecordedTurnEligibility(
    source.channelId,
    source.logicalSessionId,
    source.turnId,
  );
  if (eligibility.kind === 'missing') {
    throw new BackgroundWorkDeferredError('source_not_ready', 250, 'source_missing');
  }
  if (eligibility.kind === 'ineligible') {
    throw new BackgroundWorkPermanentError('source_missing');
  }
  const record = eligibility.record;
  if ((record.sessionId ?? record.channelId) !== source.logicalSessionId
    || record.channelId !== source.channelId
    || record.requestId !== source.requestId
    || fingerprintBackgroundWorkTurnRecord(record) !== source.turnRecordFingerprint) {
    throw new BackgroundWorkPermanentError('source_mismatch');
  }
  return record;
}

function isDirectTurn(record: TurnRecord): boolean | undefined {
  if (record.auditPrivacy?.reason === 'direct_message') return true;
  if (record.channelPrivacy === 'public') return false;
  return undefined;
}

function rehydrateIntentionContext(
  record: TurnRecord,
  payload: Extract<BackgroundWorkPayload, { kind: 'intention_post_turn_hooks' }>,
): IntentionPostTurnHookContext {
  const message: SubstrateMessage = {
    id: record.userMessage.sourceMessageId ?? record.requestId,
    channelId: record.channelId,
    channelType: record.channelType,
    authorId: record.userMessage.authorId ?? 'unknown',
    authorName: record.userMessage.authorName ?? 'Unknown',
    content: record.userMessage.content,
    timestamp: new Date(record.userMessage.timestamp),
    ...(isDirectTurn(record) !== undefined ? { isDirectMessage: isDirectTurn(record) } : {}),
    ...(record.userMessage.replyToMessageId
      ? { replyToMessageId: record.userMessage.replyToMessageId }
      : {}),
    ...(record.icpCorrelation ? { routing: { icpCorrelation: record.icpCorrelation } } : {}),
  };
  const response: AgentResponse = {
    content: record.assistantMessage?.content ?? '',
    channelId: record.channelId,
    metadata: {
      model: record.versionPointers.model,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Math.max(0, record.completedAt - record.startedAt),
      turnId: record.turnId,
      requestId: record.requestId,
      ...(record.icpCorrelation ? { icpCorrelation: record.icpCorrelation } : {}),
    },
  };
  // Hook inputs are rehydrated from the canonical TurnRecord. Tool messages are
  // represented there as normalized toolCalls; the current intention hook uses
  // the stable source id and assistant response, so no raw tool payload is
  // duplicated into the queue merely to recreate upstream provider objects.
  const turnMessages: AgentMessage[] = [];
  return {
    message,
    response,
    turnMessages,
    turnId: record.turnId,
    completedAt: record.completedAt,
    ...(payload.canonicalContactKey
      ? { canonicalContactKey: payload.canonicalContactKey }
      : {}),
    ...(record.icpCorrelation ? { icpCorrelation: record.icpCorrelation } : {}),
  };
}

function resolveMaxSessionEntryId(source: BackgroundWorkSourceRef): number | undefined {
  return source.assistantSessionEntryId ?? source.userSessionEntryId;
}

function requireMaxSessionEntryId(source: BackgroundWorkSourceRef): number {
  const maxSessionEntryId = resolveMaxSessionEntryId(source);
  if (maxSessionEntryId === undefined) {
    throw new BackgroundWorkPermanentError('source_mismatch');
  }
  return maxSessionEntryId;
}

async function withStableConsumedSnapshot<T>(
  input: BackgroundWorkExecutionInput,
  dependencies: AdmittedPostTurnBackgroundRuntimeDependencies,
  readSnapshot: () => ReturnType<CapturedSessionReads['getRecentMessagesAtOrBefore']>,
  operation: (
    entries: ReturnType<CapturedSessionReads['getRecentMessagesAtOrBefore']>
  ) => Promise<T>,
): Promise<T> {
  try {
    return await dependencies.sessionManager.withStableRecordedTurnEligibilitySnapshot(
      input.payload.source.logicalSessionId,
      [input.payload.source.turnId],
      readSnapshot,
      async entries => operation([...entries]),
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'TurnRecordEligibilitySnapshotChangedError') {
      // A concurrently changed validation snapshot is unavailable, not
      // missing. Preserve that truthful terminal reason if the bounded
      // deferral budget is exhausted.
      throw new BackgroundWorkDeferredError('source_not_ready', 250);
    }
    if (error instanceof Error && error.name === 'TurnRecordEligibilitySnapshotInvalidError') {
      throw new BackgroundWorkPermanentError('source_missing');
    }
    throw error;
  }
}

/**
 * A bounded snapshot is usable only when it still contains the entry it was
 * anchored to. Older source entries may legitimately fall outside the window,
 * so require the max boundary id rather than every id recorded on the job.
 */
function requireSourceSessionEntry(
  entries: ReturnType<CapturedSessionReads['getRecentMessagesAtOrBefore']>,
  requiredSessionEntryId: number,
): void {
  if (!entries.some(entry => entry.id === requiredSessionEntryId)) {
    throw new BackgroundWorkDeferredError('source_not_ready', 250, 'source_missing');
  }
}

function errorCauseChainHasName(error: unknown, expectedName: string): boolean {
  const visited = new Set<Error>();
  let current = error;
  while (current instanceof Error && !visited.has(current)) {
    if (current.name === expectedName) {
      return true;
    }
    visited.add(current);
    current = current.cause;
  }
  return false;
}

/**
 * Post-turn background executor with model-call-gate preemption mapping.
 *
 * A higher-priority (foreground) acquire at the model-call gate aborts an
 * in-flight PREEMPTABLE background model call. For all four job classes that
 * abort is structurally PRE-`commitEffectBoundary` (the LLM call precedes every
 * durable write), so the effect runner has already abandoned the still-`pending`
 * receipt and the job is safe to requeue with no duplicate write. We therefore
 * map the preemption to a supervisor defer('foreground_active') — no attempt
 * consumed, later resumes — rather than a fail/retry. A gate preemption surfaces
 * as a typed ModelCallPreemptedError (matched by name to avoid a
 * core -> primitives import); any other error keeps its existing disposition.
 */
export async function executePostTurnBackgroundWork(
  input: BackgroundWorkExecutionInput,
  dependencies: PostTurnBackgroundRuntimeDependencies,
): Promise<void> {
  const sessionReads = dependencies.sessionManager.createCapturedSessionReads({
    logicalSessionId: input.payload.source.logicalSessionId,
    sourceChannelId: input.payload.source.channelId,
  });
  const admittedDependencies: AdmittedPostTurnBackgroundRuntimeDependencies = dependencies;
  try {
    await sessionReads.run(async () => {
      await runPostTurnBackgroundWork(input, admittedDependencies, sessionReads);
    });
  } catch (error) {
    if (errorCauseChainHasName(error, 'ModelCallPreemptedError')) {
      throw new BackgroundWorkDeferredError(
        'foreground_active',
        dependencies.tuning.foregroundPreemptionDeferDelayMs,
      );
    }
    throw error;
  }
}

async function runPostTurnBackgroundWork(
  input: BackgroundWorkExecutionInput,
  dependencies: AdmittedPostTurnBackgroundRuntimeDependencies,
  sessionReads: CapturedSessionReads,
): Promise<void> {
  const { payload, job } = input;
  if (payload.kind === 'memory_extraction') {
    const maxSessionEntryId = requireMaxSessionEntryId(payload.source);
    const extractor = dependencies.getMemoryExtractor();
    if (!extractor) throw new Error('Memory extraction background handler is not wired');
    // Size the bounded snapshot to the configured extraction interval instead of
    // a fixed ten entries. A snapshot capped at ten can never contain the 11-50
    // uncovered entries a valid interval requires, so those configs would never
    // interval-fire and every job receipt completed as a durable no-op. The
    // extractor clamps this to its recovery window, keeping coverage aligned with
    // the entries its LLM prompt actually consumes.
    const snapshotLimit = extractor.getBoundedExtractionSnapshotLimit();
    await withStableConsumedSnapshot(
      input,
      dependencies,
      () => sessionReads.getRecentMessagesAtOrBefore(
        maxSessionEntryId,
        snapshotLimit,
      ),
      async (recentEntries) => {
        await input.effects.assertOwned();
        const record = await requireCanonicalTurnRecord(payload.source, dependencies);
        requireSourceSessionEntry(recentEntries, maxSessionEntryId);
        try {
          await runWithPostTurnUsageAttribution(
            record,
            payload.source,
            'extraction',
            () => input.effects.run('memory-extraction', async (crossBoundary) => {
              // Extraction has a long, failable pre-write phase (LLM call, parse, DB
              // reads) before its first durable write. Guard that phase with the
              // NON-crossing `assertOwned` fence so a transient pre-write failure
              // leaves the receipt `pending` and the job retryable; `crossBoundary`
              // is called only at the durable write sites, where a post-write crash
              // must instead fail closed. Passing both keeps pre-write work
              // retryable while the write phase stays exactly-once.
              const outputs = await extractor.maybeExtract(
                payload.source.logicalSessionId,
                payload.canonicalContactId,
                record.turnId,
                payload.placeId,
                payload.icpCorrelation,
                crossBoundary,
                recentEntries,
                input.effects.assertOwned,
                // mmo9.7.4: a welfare-escalated claim protects its model call from
                // gate preemption so the aged memory job runs to completion instead
                // of re-entering the preempt→defer loop. fxt1: pair the flag with
                // the granting job id so the gateway can re-verify the escalation
                // against the store; the id rides only when the claim is welfare.
                job.welfareClaimed
                  ? { preemptionProtected: true, welfareGrantJobId: job.jobId }
                  : { preemptionProtected: false },
              );
              if (!outputs) return [];
              return [
                ...outputs.memoryIds.map(id => buildSubsystemOutputRef('memory', id)),
                ...outputs.concernIds.map(id => buildSubsystemOutputRef('concern', id)),
                ...outputs.contactIds.map(id => buildSubsystemOutputRef('contact', id)),
              ];
            }, { projectsSubsystemOutputs: true }),
          );
        } catch (error) {
          // u5bv.11: the queued durable extraction found the extractor draining
          // before its serialized run wrote any fact. It crossed no write
          // boundary and its `pending` receipt was abandoned by the effect
          // runner, so defer the job (retryable) rather than let a drain-time
          // no-op complete the receipt and mark the snapshot covered. Matched by
          // name to avoid a core -> faculties error-class import.
          if (error instanceof Error && error.name === 'ExtractionDrainRequeueError') {
            throw new BackgroundWorkDeferredError(
              'handler_failed',
              dependencies.tuning.extractionDrainRequeueDelayMs,
            );
          }
          throw error;
        }
      },
    );
    return;
  }
  if (payload.kind === 'emotion_appraisal') {
    const maxSessionEntryId = requireMaxSessionEntryId(payload.source);
    await withStableConsumedSnapshot(
      input,
      dependencies,
      () => selectEmotionAppraisalSourceEntries(
        sessionReads.getRecentMessagesAtOrBefore(
          maxSessionEntryId,
          10,
        ),
      ),
      async (recentEntries) => {
        await input.effects.assertOwned();
        const record = await requireCanonicalTurnRecord(payload.source, dependencies);
        requireSourceSessionEntry(recentEntries, maxSessionEntryId);
        if (
          extractTurnRecordSelfSnapshotRef(record.internalStateSnapshotRef)
          !== payload.internalStateSnapshotRef
        ) {
          throw new BackgroundWorkPermanentError('source_mismatch');
        }
        await runWithPostTurnUsageAttribution(
          record,
          payload.source,
          'emotion.appraisal',
          () => input.effects.run('emotion-appraisal', async (assertOwned) => {
            const canonicalTemplateVariables = dependencies.getEmotionTemplateVariables();
            await dependencies.emotionRuntime.triggerEmotionAppraisal({
              sessionChannelId: payload.emotionSessionId,
              turnId: record.turnId,
              appraisalState: payload.appraisalState,
              templateVariables: canonicalTemplateVariables,
              assertEffectAllowed: assertOwned,
              recentEntries,
              driftDecision: payload.driftDecision,
              // mmo9.7.4: protect the welfare-escalated appraisal model call.
              // fxt1: pair the flag with the granting job id for gateway re-verify.
              preemptionProtected: job.welfareClaimed,
              ...(job.welfareClaimed ? { welfareGrantJobId: job.jobId } : {}),
              ...(payload.icpCorrelation ? { icpCorrelation: payload.icpCorrelation } : {}),
            });
          }),
        );
      },
    );
    return;
  }
  if (payload.kind === 'auto_compaction') {
    const maxSessionEntryId = requireMaxSessionEntryId(payload.source);
    const snapshotAt = new Date();
    const captureParams = {
      adaptiveProfile: payload.adaptiveProfile,
      turnBudgetCharacteristics: payload.turnBudgetCharacteristics,
      maxSessionEntryId,
      now: snapshotAt,
    } as const;
    await withStableConsumedSnapshot(
      input,
      dependencies,
      () => sessionReads.captureAutoCompactionRecentEntries(captureParams),
      async (recentEntries) => {
        await input.effects.assertOwned();
        await requireCanonicalTurnRecord(payload.source, dependencies);
        requireSourceSessionEntry(recentEntries, maxSessionEntryId);
        await input.effects.run('auto-compaction', async (assertOwned) => {
          await sessionReads.scheduleAutoCompactionBetweenTurns({
            systemPromptTokenCount: payload.systemPromptTokenCount,
            memoriesTokenCount: payload.memoriesTokenCount,
            adaptiveProfile: payload.adaptiveProfile,
            turnBudgetCharacteristics: payload.turnBudgetCharacteristics,
            llmProvider: dependencies.llmProvider,
            throwOnFailure: true,
            assertEffectAllowed: assertOwned,
            capturedRecentEntries: recentEntries,
            ...(payload.channelMeta ? { channelMeta: payload.channelMeta } : {}),
            ...(payload.userId ? { userId: payload.userId } : {}),
            ...(payload.icpCorrelation ? { icpCorrelation: payload.icpCorrelation } : {}),
          });
        });
      },
    );
    return;
  }
  await dependencies.sessionManager.withSourceRecordedTurnEligibilityFence(
    payload.source.channelId,
    payload.source.logicalSessionId,
    payload.source.turnId,
    async () => {
      // The durable source fence is shared with turn-tombstone and duplicate
      // TurnRecord writers. Queue ownership and canonical eligibility are both
      // proved only after it is held, and raw content never leaves its scope.
      await input.effects.assertOwned();
      const record = await requireCanonicalTurnRecord(payload.source, dependencies);
      // Social desire consumes the cheap, content-free felt-state projection
      // on every bounded turn. It stays on the always-enqueued intention job so
      // drift-only narrative scheduling cannot starve accumulation.
      if (payload.appraisalState && dependencies.socialDesireFeltSignals) {
        const appraisalState = payload.appraisalState;
        const feltSignalWriter = dependencies.socialDesireFeltSignals;
        await input.effects.run('social-desire-felt-signal', async (assertOwned) => {
          await assertOwned();
          await feltSignalWriter.record(appraisalState, {
            sourceRef: `emotion_appraisal:${payload.source.channelId}:${payload.source.turnId}`,
            nowMs: payload.source.createdAtMs,
          });
        });
      }
      // Source-only audit: the sole production hook records a behavioral
      // pattern from this canonical message/response pair; it does not read a
      // session window. Keep it on the one-source fence unless that hook
      // contract changes.
      await dependencies.runIntentionPostTurnHooks(
        rehydrateIntentionContext(record, payload),
        {
          propagateFailures: true,
          assertOwned: input.effects.assertOwned,
          runEffect: input.effects.run,
        },
      );
    },
  );
}
