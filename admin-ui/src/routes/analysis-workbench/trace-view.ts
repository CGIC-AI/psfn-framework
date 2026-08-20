export interface AnalysisTraceLimitPolicy {
  maxIterations: number;
  maxTokens: number | null;
  maxWallTimeMs: number | null;
  maxSubQueries: number | null;
  maxToolCalls: number | null;
}

export interface AnalysisTraceOutcomeInput {
  outcome?: 'completed' | 'limit_reached';
  continuation?: 'not_needed' | 'restart_required';
  budgetStop: string | null;
  iterations: number;
  totalTokens: number;
  durationMs: number;
  sessionCostUsd?: number;
  limitPolicy?: AnalysisTraceLimitPolicy;
}

export interface AnalysisTraceOutcomeView {
  status: string;
  continuation: string;
  progress: string;
  cost: string;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${ms}ms`;
}

export function projectAnalysisTraceOutcome(
  trace: AnalysisTraceOutcomeInput,
): AnalysisTraceOutcomeView {
  const policy = trace.limitPolicy;
  const progress = policy
    ? [
        `${trace.iterations}/${policy.maxIterations} iterations`,
        policy.maxTokens === null
          ? `${formatTokens(trace.totalTokens)} tokens`
          : `${formatTokens(trace.totalTokens)}/${formatTokens(policy.maxTokens)} tokens`,
        policy.maxWallTimeMs === null
          ? formatDuration(trace.durationMs)
          : `${formatDuration(trace.durationMs)}/${formatDuration(policy.maxWallTimeMs)}`,
      ].join(' · ')
    : `${trace.iterations} iteration${trace.iterations === 1 ? '' : 's'} · `
      + `${formatTokens(trace.totalTokens)} tokens · ${formatDuration(trace.durationMs)} `
      + '(limit policy unavailable)';

  return {
    status: trace.outcome === 'completed'
      ? 'completed'
      : trace.outcome === 'limit_reached'
        ? `incomplete — ${trace.budgetStop ?? 'limit reached'}`
        : 'outcome unavailable',
    continuation: trace.continuation === 'not_needed'
      ? 'complete; no continuation needed'
      : trace.continuation === 'restart_required'
        ? 'terminal; start a new run to continue'
        : 'continuation unavailable',
    progress,
    cost: trace.sessionCostUsd === undefined
      ? 'cost unavailable'
      : `$${trace.sessionCostUsd.toFixed(4)}`,
  };
}
