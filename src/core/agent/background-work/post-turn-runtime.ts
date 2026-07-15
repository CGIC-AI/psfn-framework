import type { AgentMessage } from '../../../boundary/pi-agent/index.js';
import type { LLMProviderPort, MemoryExtractor } from '../contracts.js';
import type { AgentResponse, SubstrateMessage, TurnRecord } from '../../../shared/contracts/runtime.js';
import type { SessionManager } from '../../session/manager.js';
import type {
  IntentionPostTurnHookContext,
  IntentionPostTurnHookRunOptions,
} from '../substrate-agent/post-turn-actions.js';
import type { EmotionSelfModelRuntime } from '../substrate-agent/emotion-self-model-runtime.js';
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

export async function executePostTurnBackgroundWork(
  input: BackgroundWorkExecutionInput,
  dependencies: PostTurnBackgroundRuntimeDependencies,
): Promise<void> {
  const { payload, job } = input;
  await input.effects.assertOwned();
  const record = requireCanonicalTurnRecord(payload.source, job.createdAtMs, dependencies);
  switch (payload.kind) {
    case 'memory_extraction': {
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
        );
      });
      return;
    }
    case 'intention_post_turn_hooks':
      await dependencies.runIntentionPostTurnHooks(
        rehydrateIntentionContext(record, payload),
        {
          propagateFailures: true,
          runEffect: input.effects.run,
        },
      );
      return;
    case 'emotion_appraisal':
      if (record.internalStateSnapshotRef !== payload.internalStateSnapshotRef) {
        throw new BackgroundWorkPermanentError('source_mismatch');
      }
      await input.effects.run('emotion-appraisal', async (assertOwned) => {
        const canonicalTemplateVariables = dependencies.getEmotionTemplateVariables();
        // Identity may have legitimately changed since enqueue, so execution
        // always consumes current canonical owner data rather than queued prose.
        await dependencies.emotionRuntime.triggerEmotionAppraisal({
          sessionChannelId: payload.emotionSessionId,
          turnId: record.turnId,
          appraisalState: payload.appraisalState,
          templateVariables: canonicalTemplateVariables,
          assertEffectAllowed: assertOwned,
          ...(resolveMaxSessionEntryId(payload.source) !== undefined
            ? { maxSessionEntryId: resolveMaxSessionEntryId(payload.source) }
            : {}),
          ...(payload.icpCorrelation ? { icpCorrelation: payload.icpCorrelation } : {}),
        });
      });
      return;
    case 'auto_compaction':
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
          ...(payload.channelMeta ? { channelMeta: payload.channelMeta } : {}),
          ...(payload.userId ? { userId: payload.userId } : {}),
          ...(payload.icpCorrelation ? { icpCorrelation: payload.icpCorrelation } : {}),
        });
      });
      return;
  }
}
