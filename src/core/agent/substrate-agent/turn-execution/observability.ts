import type { ContextManifestMemorySeed } from '../../../session/context-manifest.js';
import type {
  CorrelationMetadata,
  ObservabilityCallType,
  SubstrateMessage,
  TurnID,
} from '../../../../shared/contracts/runtime.js';
import type {
  TurnObservabilityRecord,
  TurnRetrievalTelemetryRecord,
  TurnStageTelemetryRecord,
} from '../../../turns/observability.js';
import {
  sanitizeTurnRetrievalTelemetry,
  sanitizeTurnSnapshot,
  sanitizeTurnStageTelemetry,
} from '../../../turns/observability.js';
import type { TurnSnapshot } from '../../../turns/snapshot.js';
import { createComponentLogger } from '../../../../shared/logger.js';
import { toErrorMessage } from '../../../../shared/utils/errors.js';

const log = createComponentLogger('SubstrateAgent');
type TurnExecutionRuntime = import('../turn-execution-runtime.js').TurnExecutionRuntime;

export type TurnExecutionStageName =
  | 'trust'
  | 'memory'
  | 'fatigue'
  | 'context'
  | 'first-token'
  | 'prompt'
  | 'end';

export interface TurnExecutionObservability {
  emitObservedTurnStage: (
    stage: TurnExecutionStageName,
    payload: Record<string, unknown>,
  ) => void;
  emitTurnSnapshotInBackground: (snapshot: TurnSnapshot) => void;
  emitTurnSnapshot: (snapshot: TurnSnapshot) => Promise<void>;
  getObservedTurnStages: () => TurnStageTelemetryRecord[];
  getObservedTurnRetrievals: () => TurnRetrievalTelemetryRecord[];
  getObservedTurnSnapshot: () => TurnObservabilityRecord['snapshot'] | undefined;
  getMemoryManifestSeed: () => ContextManifestMemorySeed | undefined;
  getRetrievalProvenanceRefs: () => string[];
  unsubscribe: () => void;
}

export function createTurnExecutionObservability(input: {
  runtime: TurnExecutionRuntime;
  message: SubstrateMessage;
  startTime: number;
  turnId: TurnID;
  requestId: string;
  turnCallType: ObservabilityCallType;
  turnCorrelationBase: CorrelationMetadata;
}): TurnExecutionObservability {
  const {
    runtime,
    message,
    startTime,
    turnId,
    requestId,
    turnCallType,
    turnCorrelationBase,
  } = input;
  const observedTurnStages: TurnStageTelemetryRecord[] = [];
  const observedTurnRetrievals: TurnRetrievalTelemetryRecord[] = [];
  let observedTurnSnapshot: TurnObservabilityRecord['snapshot'] | undefined;
  let memoryManifestSeed: ContextManifestMemorySeed | undefined;
  let retrievalProvenanceRefs: string[] = [];

  const emitObservedTurnStage = (
    stage: TurnExecutionStageName,
    payload: Record<string, unknown>,
  ): void => {
    const telemetry = runtime.emitTurnStage(
      message,
      startTime,
      turnId,
      requestId,
      stage,
      turnCallType,
      payload,
    );
    observedTurnStages.push(sanitizeTurnStageTelemetry(telemetry));
  };

  const buildTurnSnapshotPayload = (snapshot: TurnSnapshot) => ({
    snapshot: structuredClone(snapshot),
    ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.snapshot'),
  });

  const recordObservedTurnSnapshot = (snapshot: TurnSnapshot): void => {
    observedTurnSnapshot = sanitizeTurnSnapshot(snapshot);
  };

  const emitTurnSnapshotInBackground = (snapshot: TurnSnapshot): void => {
    recordObservedTurnSnapshot(snapshot);
    void runtime.eventBus.emit('agent.turn.snapshot', buildTurnSnapshotPayload(snapshot)).catch(error => {
      log.debug('Background turn snapshot emit failed', {
        channelId: message.channelId,
        turnId,
        requestId,
        error: toErrorMessage(error),
      });
    });
  };

  const emitTurnSnapshot = async (snapshot: TurnSnapshot): Promise<void> => {
    recordObservedTurnSnapshot(snapshot);
    await runtime.eventBus.emit('agent.turn.snapshot', buildTurnSnapshotPayload(snapshot));
  };

  const unsubscribe = runtime.eventBus.on('memory.retrieval', (telemetry) => {
    if (telemetry.channelId !== message.channelId) return;
    if (telemetry.requestId && telemetry.requestId !== requestId) return;
    if (telemetry.turnId && telemetry.turnId !== turnId) return;

    const observedRetrieval = sanitizeTurnRetrievalTelemetry(telemetry);
    if (observedRetrieval) {
      observedTurnRetrievals.push(observedRetrieval);
    }

    memoryManifestSeed = {
      ...(telemetry.reason ? { reason: telemetry.reason } : {}),
      ...(telemetry.retrievalSource ? { retrievalSource: telemetry.retrievalSource } : {}),
      ...(telemetry.candidateCount !== undefined ? { candidateCount: telemetry.candidateCount } : {}),
      ...(telemetry.policyAllowedCount !== undefined ? { policyAllowedCount: telemetry.policyAllowedCount } : {}),
      ...(telemetry.rankedCount !== undefined ? { rankedCount: telemetry.rankedCount } : {}),
      ...(telemetry.returnedCount !== undefined ? { returnedCount: telemetry.returnedCount } : {}),
      ...(telemetry.retrievalLimit !== undefined ? { retrievalLimit: telemetry.retrievalLimit } : {}),
      ...(telemetry.retrievalBudgetPct !== undefined ? { retrievalBudgetPct: telemetry.retrievalBudgetPct } : {}),
      ...(telemetry.retrievalTokenBudget !== undefined ? { retrievalTokenBudget: telemetry.retrievalTokenBudget } : {}),
      ...(telemetry.retrievalLimitMode ? { retrievalLimitMode: telemetry.retrievalLimitMode } : {}),
      ...(telemetry.contactScopeRejectedCount !== undefined
        ? { contactScopeRejectedCount: telemetry.contactScopeRejectedCount }
        : {}),
      ...(telemetry.sensitivityRejectedCount !== undefined
        ? { sensitivityRejectedCount: telemetry.sensitivityRejectedCount }
        : {}),
      ...(telemetry.policyRejectedCount !== undefined ? { policyRejectedCount: telemetry.policyRejectedCount } : {}),
      ...(telemetry.policyRejectedReasonTags
        ? { policyRejectedReasonTags: { ...telemetry.policyRejectedReasonTags } }
        : {}),
      ...(telemetry.withheldCount !== undefined ? { withheldCount: telemetry.withheldCount } : {}),
      ...(telemetry.withheldReasonCounts
        ? { withheldReasonCounts: { ...telemetry.withheldReasonCounts } }
        : {}),
      ...(telemetry.withheldRelevanceBands
        ? { withheldRelevanceBands: { ...telemetry.withheldRelevanceBands } }
        : {}),
      ...(telemetry.scoreRejectedCount !== undefined ? { scoreRejectedCount: telemetry.scoreRejectedCount } : {}),
      ...(telemetry.budgetCappedCount !== undefined ? { budgetCappedCount: telemetry.budgetCappedCount } : {}),
      ...(telemetry.selectedTypes ? { selectedTypes: { ...telemetry.selectedTypes } } : {}),
      ...(telemetry.compositionalMode ? { compositionalMode: telemetry.compositionalMode } : {}),
    };
    const refs = telemetry.provenanceRefs ?? [];
    if (refs.length === 0) return;
    retrievalProvenanceRefs = [...new Set(refs.map(ref => ref.trim()).filter(Boolean))];
  });

  return {
    emitObservedTurnStage,
    emitTurnSnapshotInBackground,
    emitTurnSnapshot,
    getObservedTurnStages: () => [...observedTurnStages],
    getObservedTurnRetrievals: () => [...observedTurnRetrievals],
    getObservedTurnSnapshot: () => observedTurnSnapshot,
    getMemoryManifestSeed: () => memoryManifestSeed,
    getRetrievalProvenanceRefs: () => [...retrievalProvenanceRefs],
    unsubscribe,
  };
}
