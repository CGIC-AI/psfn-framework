import type { TelemetryEvent } from '$lib/types';
import {
  parseContextCoherenceEvent,
  type ContextCoherenceEvent,
  type ContextCoherenceSignal,
} from '../../../../src/shared/contracts/context-coherence.js';

export const CONTEXT_COHERENCE_SIGNAL_LABELS: Record<ContextCoherenceSignal, string> = {
  confusion_ask: 'Confusion asks',
  looping: 'Looping',
  confabulation_self_report: 'Confabulation self-reports',
  concern_rumination: 'Concern rumination',
  operator_intervention: 'Operator interventions',
};

export interface ContextCoherenceTelemetryView {
  total: number;
  breakdown: Record<ContextCoherenceSignal, number>;
  trend: number[];
  missingTurnCorrelatedCount: number;
  groundTruthCount: number;
  latest: ContextCoherenceEvent | null;
}

const TREND_BUCKET_COUNT = 12;
const TREND_BUCKET_MS = 3_600_000;

function emptyBreakdown(): Record<ContextCoherenceSignal, number> {
  return {
    confusion_ask: 0,
    looping: 0,
    confabulation_self_report: 0,
    concern_rumination: 0,
    operator_intervention: 0,
  };
}

export function deriveContextCoherenceTelemetry(
  telemetryEvents: readonly TelemetryEvent[],
  nowMs: number = Date.now(),
): ContextCoherenceTelemetryView {
  const events = telemetryEvents
    .filter(event => event.type === 'context.coherence.detected')
    .map(event => parseContextCoherenceEvent(event.data))
    .filter((event): event is ContextCoherenceEvent => event !== null)
    .sort((left, right) => left.timestamp - right.timestamp);
  const breakdown = emptyBreakdown();
  const trend = Array.from({ length: TREND_BUCKET_COUNT }, () => 0);
  const currentBucketStart = Math.floor(nowMs / TREND_BUCKET_MS) * TREND_BUCKET_MS;
  const trendStart = currentBucketStart - ((TREND_BUCKET_COUNT - 1) * TREND_BUCKET_MS);
  let missingTurnCorrelatedCount = 0;
  let groundTruthCount = 0;

  for (const event of events) {
    breakdown[event.signal] += 1;
    if (event.correlations.some(correlation => correlation.kind === 'missing_turn')) {
      missingTurnCorrelatedCount += 1;
    }
    if (event.groundTruth) groundTruthCount += 1;
    const bucketIndex = Math.floor((event.timestamp - trendStart) / TREND_BUCKET_MS);
    if (bucketIndex >= 0 && bucketIndex < trend.length) {
      trend[bucketIndex] += 1;
    }
  }

  return {
    total: events.length,
    breakdown,
    trend,
    missingTurnCorrelatedCount,
    groundTruthCount,
    latest: events.at(-1) ?? null,
  };
}
