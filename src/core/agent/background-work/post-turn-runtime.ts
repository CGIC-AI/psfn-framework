import type { AgentMessage } from '../../../boundary/pi-agent/index.js';
import type { LLMProviderPort, MemoryExtractor } from '../contracts.js';
import type { AgentResponse, SubstrateMessage, TurnRecord } from '../../../shared/contracts/runtime.js';
import type { SessionManager } from '../../session/manager.js';
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

const SOURCE_RECORD_GRACE_MS = 60_000;

export interface PostTurnBackgroundRuntimeDependencies {
  sessionManager: SessionManager;
  llmProvider: LLMProviderPort;
  getMemoryExtractor: () => MemoryExtractor | null;
  runIntentionPostTurnHooks: (
    context: IntentionPostTurnHookContext,
    options?: IntentionPostTurnHookRunOptions,
  ) => Promise<void>;
  emotionRuntime: Pick<EmotionSelfModelRuntime, 'triggerEmotionAppraisal'>;
  getEmotionTemplateVariables: () => Record<string, string>;
  now?: () => number;
}

function requireCanonicalTurnRecord(
  source: BackgroundWorkSourceRef,
  jobCreatedAtMs: number,
  dependencies: PostTurnBackgroundRuntimeDependencies,
): TurnRecord {
  if (!dependencies.sessionManager.isSourceRecordedTurnEligible(
    source.channelId,
    source.logicalSessionId,
    source.turnId,
  )) {
    throw new BackgroundWorkPermanentError('source_missing');
  }
  const record = dependencies.sessionManager.findSourceRecordedTurn(
    source.channelId,
    source.logicalSessionId,
    source.turnId,
  );
  if (!record) {
    const nowMs = (dependencies.now ?? Date.now)();
    if (nowMs - jobCreatedAtMs < SOURCE_RECORD_GRACE_MS) {
      throw new BackgroundWorkDeferredError('source_not_ready', 250);
    }
    throw new BackgroundWorkPermanentError('source_missing');
  }
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
  dependencies: PostTurnBackgroundRuntimeDependencies,
  readSnapshot: () => ReturnType<SessionManager['getRecentMessagesAtOrBefore']>,
  operation: (entries: ReturnType<SessionManager['getRecentMessagesAtOrBefore']>) => Promise<T>,
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
      throw new BackgroundWorkDeferredError('source_not_ready', 250);
    }
    if (error instanceof Error && error.name === 'TurnRecordEligibilitySnapshotInvalidError') {
      throw new BackgroundWorkPermanentError('source_missing');
    }
    throw error;
  }
}

export async function executePostTurnBackgroundWork(
  input: BackgroundWorkExecutionInput,
  dependencies: PostTurnBackgroundRuntimeDependencies,
): Promise<void> {
  const { payload, job } = input;
  if (payload.kind === 'memory_extraction') {
    const maxSessionEntryId = requireMaxSessionEntryId(payload.source);
    await withStableConsumedSnapshot(
      input,
      dependencies,
      () => dependencies.sessionManager.getRecentMessagesAtOrBefore(
        payload.source.logicalSessionId,
        maxSessionEntryId,
        10,
      ),
      async (recentEntries) => {
        await input.effects.assertOwned();
        const record = requireCanonicalTurnRecord(payload.source, job.createdAtMs, dependencies);
        const extractor = dependencies.getMemoryExtractor();
        if (!extractor) throw new Error('Memory extraction background handler is not wired');
        await input.effects.run('memory-extraction', async (assertOwned) => {
          await extractor.maybeExtract(
            payload.source.logicalSessionId,
            payload.canonicalContactId,
            record.turnId,
            payload.placeId,
            payload.icpCorrelation,
            assertOwned,
            recentEntries,
          );
        });
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
        dependencies.sessionManager.getRecentMessagesAtOrBefore(
          payload.source.logicalSessionId,
          maxSessionEntryId,
          10,
        ),
      ),
      async (recentEntries) => {
        await input.effects.assertOwned();
        const record = requireCanonicalTurnRecord(payload.source, job.createdAtMs, dependencies);
        if (record.internalStateSnapshotRef !== payload.internalStateSnapshotRef) {
          throw new BackgroundWorkPermanentError('source_mismatch');
        }
        await input.effects.run('emotion-appraisal', async (assertOwned) => {
          const canonicalTemplateVariables = dependencies.getEmotionTemplateVariables();
          await dependencies.emotionRuntime.triggerEmotionAppraisal({
            sessionChannelId: payload.emotionSessionId,
            turnId: record.turnId,
            appraisalState: payload.appraisalState,
            templateVariables: canonicalTemplateVariables,
            assertEffectAllowed: assertOwned,
            recentEntries,
            ...(payload.icpCorrelation ? { icpCorrelation: payload.icpCorrelation } : {}),
          });
        });
      },
    );
    return;
  }
  if (payload.kind === 'auto_compaction') {
    const maxSessionEntryId = requireMaxSessionEntryId(payload.source);
    const snapshotAt = new Date();
    const captureParams = {
      channelId: payload.source.logicalSessionId,
      adaptiveProfile: payload.adaptiveProfile,
      turnBudgetCharacteristics: payload.turnBudgetCharacteristics,
      maxSessionEntryId,
      now: snapshotAt,
    } as const;
    await withStableConsumedSnapshot(
      input,
      dependencies,
      () => dependencies.sessionManager.captureAutoCompactionRecentEntries(captureParams),
      async (recentEntries) => {
        await input.effects.assertOwned();
        requireCanonicalTurnRecord(payload.source, job.createdAtMs, dependencies);
        await input.effects.run('auto-compaction', async (assertOwned) => {
          await dependencies.sessionManager.scheduleAutoCompactionBetweenTurns({
            channelId: payload.source.logicalSessionId,
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
      const record = requireCanonicalTurnRecord(payload.source, job.createdAtMs, dependencies);
      // Source-only audit: the sole production hook records a behavioral
      // pattern from this canonical message/response pair; it does not read a
      // session window. Keep it on the one-source fence unless that hook
      // contract changes.
      await dependencies.runIntentionPostTurnHooks(
        rehydrateIntentionContext(record, payload),
        {
          propagateFailures: true,
          runEffect: input.effects.run,
        },
      );
    },
  );
}
