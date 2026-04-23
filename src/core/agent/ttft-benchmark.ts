export type TtftMeasurementClass = 'local_structural_latency' | 'provider_e2e_ttft';

export interface TtftBenchmarkMethodology {
  benchmarkId: string;
  measurementClass: TtftMeasurementClass;
  measuredPath: string[];
  providerSensitiveMetrics: string[];
  structuralMetrics: string[];
  hotPathSignals: string[];
  warmupTurns: number;
  measuredTurns: number;
}

export interface TtftHotPathEvidence {
  transportStreamCalls: number;
  transportTextDeltas: number;
  agentStreamDeltas: number;
  firstTokenSource: 'stream' | 'fallback' | 'missing';
  promptStageObserved: boolean;
}

export interface TtftHotPathVerdict extends TtftHotPathEvidence {
  liveHotPathSatisfied: boolean;
  missingSignals: string[];
}

export interface TtftBenchmarkSample {
  providerId: string;
  turnIndex: number;
  ttftMs: number;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
  hotPath: TtftHotPathVerdict;
  localPreProviderMs?: number;
  providerTtfbMs?: number;
  providerRoundTripMs?: number;
  localPostProviderMs?: number;
  structuralOverheadMs?: number;
  error?: string;
}

export interface TtftMetricSummary {
  count: number;
  minMs: number;
  medianMs: number;
  p90Ms: number;
  maxMs: number;
}

export interface TtftBenchmarkReport {
  methodology: TtftBenchmarkMethodology;
  summary: {
    benchmarkId: string;
    measurementClass: TtftMeasurementClass;
    sampleCount: number;
    successCount: number;
    errorCount: number;
    hotPathFailures: number;
    metrics: Record<string, TtftMetricSummary>;
  };
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))] ?? 0;
}

export function summarizeDurations(values: number[]): TtftMetricSummary | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    minMs: sorted[0] ?? 0,
    medianMs: percentile(sorted, 50),
    p90Ms: percentile(sorted, 90),
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

export function evaluateHotPath(evidence: TtftHotPathEvidence): TtftHotPathVerdict {
  const missingSignals: string[] = [];

  if (evidence.transportStreamCalls < 1) {
    missingSignals.push('transport.stream');
  }
  if (evidence.transportTextDeltas < 1) {
    missingSignals.push('transport.onText');
  }
  if (evidence.agentStreamDeltas < 1) {
    missingSignals.push('agent.stream.delta');
  }
  if (evidence.firstTokenSource !== 'stream') {
    missingSignals.push('agent.turn.stage:first-token=stream');
  }
  if (!evidence.promptStageObserved) {
    missingSignals.push('agent.turn.stage:prompt');
  }

  return {
    ...evidence,
    liveHotPathSatisfied: missingSignals.length === 0,
    missingSignals,
  };
}

export function buildTtftBenchmarkReport(input: {
  methodology: TtftBenchmarkMethodology;
  samples: TtftBenchmarkSample[];
  metrics: Record<string, (sample: TtftBenchmarkSample) => number | undefined>;
}): TtftBenchmarkReport {
  const successfulSamples = input.samples.filter((sample) => sample.error === undefined);
  const metrics = Object.fromEntries(
    Object.entries(input.metrics).flatMap(([metricName, select]) => {
      const values = successfulSamples
        .map((sample) => select(sample))
        .filter(isFiniteNumber);
      const summary = summarizeDurations(values);
      return summary ? [[metricName, summary]] : [];
    }),
  );

  return {
    methodology: input.methodology,
    summary: {
      benchmarkId: input.methodology.benchmarkId,
      measurementClass: input.methodology.measurementClass,
      sampleCount: input.samples.length,
      successCount: successfulSamples.length,
      errorCount: input.samples.length - successfulSamples.length,
      hotPathFailures: successfulSamples.filter((sample) => !sample.hotPath.liveHotPathSatisfied).length,
      metrics,
    },
  };
}
