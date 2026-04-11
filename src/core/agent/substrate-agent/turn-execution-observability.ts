import type { ContextManifestMemorySeed } from '../../session/context-manifest.js';
import type { SubstrateMessage, CorrelationMetadata, ObservabilityCallType, TurnID } from '../../types.js';
import type {
  TurnObservabilityRecord,
  TurnRetrievalTelemetryRecord,
  TurnStageTelemetryRecord,
} from '../../turns/observability.js';
import {
  sanitizeTurnRetrievalTelemetry,
  sanitizeTurnSnapshot,
  sanitizeTurnStageTelemetry,
} from '../../turns/observability.js';
import type { TurnSnapshot } from '../../turns/snapshot.js';
import type { TurnExecutionRuntime } from './turn-execution-runtime.js';

export interface TurnExecutionObservability {
  emitObservedTurnStage: (
    stage: 'trust' | 'memory' | 'context' | 'first-token' | 'prompt' | 'end',
    payload: Record<string, unknown>,
  ) => void;
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
    stage: 'trust' | 'memory' | 'context' | 'first-token' | 'prompt' | 'end',
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

  const emitTurnSnapshot = async (snapshot: TurnSnapshot): Promise<void> => {
    observedTurnSnapshot = sanitizeTurnSnapshot(snapshot);
    await runtime.eventBus.emit('agent.turn.snapshot', {
      snapshot,
      ...runtime.withCorrelationPurpose(turnCorrelationBase, 'agent.turn.snapshot'),
    });
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
    emitTurnSnapshot,
    getObservedTurnStages: () => [...observedTurnStages],
    getObservedTurnRetrievals: () => [...observedTurnRetrievals],
    getObservedTurnSnapshot: () => observedTurnSnapshot,
    getMemoryManifestSeed: () => memoryManifestSeed,
    getRetrievalProvenanceRefs: () => [...retrievalProvenanceRefs],
    unsubscribe,
  };
}
