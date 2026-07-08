import type {
  AdminObserverEvalSidecarHealthData,
  AdminObserverEvalSidecarObservationFilters,
  AdminObserverEvalSidecarObservationView,
} from '$lib/api/endpoints/observer-eval-sidecar';
import type { EmotionStateSnapshot } from '../../../../src/core/emotion/state.js';

export type ObserverEvalSidecarPageState =
  | 'loading'
  | 'error'
  | 'unavailable'
  | 'empty'
  | 'degraded'
  | 'redacted'
  | 'populated';

export type ObserverEvalSidecarTimeRange = '15m' | '1h' | '24h' | '7d' | 'all';

export interface ObserverEvalSidecarFilterInput {
  timeRange: ObserverEvalSidecarTimeRange;
  runId?: string;
  evalSessionId?: string;
  scenarioId?: string;
  testRunId?: string;
  turnId?: string;
  privacyClass?: string;
  status?: string;
  minDivergenceScore?: string;
  limit?: string;
}

export interface ObserverEvalSidecarPageStateInput {
  loading: boolean;
  errorMessage?: string | null;
  unavailableMessage?: string | null;
  health?: AdminObserverEvalSidecarHealthData | null;
  latestObservation?: AdminObserverEvalSidecarObservationView | null;
  observations?: readonly AdminObserverEvalSidecarObservationView[];
}

const TIME_RANGE_MS: Record<Exclude<ObserverEvalSidecarTimeRange, 'all'>, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
};

export function resolveObserverEvalSidecarPageState(
  input: ObserverEvalSidecarPageStateInput,
): ObserverEvalSidecarPageState {
  if (input.loading) return 'loading';
  if (input.errorMessage?.trim()) return 'error';
  if (input.unavailableMessage?.trim()) return 'unavailable';
  if (!input.health || !input.health.persistence.available) {
    return 'unavailable';
  }

  const observations = input.observations ?? [];
  const latest = input.latestObservation ?? observations[0] ?? null;
  if (!latest && observations.length === 0) {
    return input.health.status === 'unavailable' ? 'unavailable' : 'empty';
  }
  if (
    input.health.status === 'degraded'
    || input.health.status === 'unavailable'
    || latest?.status === 'degraded'
    || observations.some(observation => observation.status === 'degraded')
    || latest?.metrics.status === 'partial'
  ) {
    return 'degraded';
  }
  if (
    latest?.privacy.privacyClass !== 'public'
    || latest?.metrics.privacy.redactedObservation
    || observations.some(observation => observation.privacy.privacyClass !== 'public')
  ) {
    return 'redacted';
  }
  return 'populated';
}

export function buildObserverEvalSidecarFilters(
  input: ObserverEvalSidecarFilterInput,
  nowMs: number = Date.now(),
): AdminObserverEvalSidecarObservationFilters {
  const filters: AdminObserverEvalSidecarObservationFilters = {};
  const runId = trimmedOrUndefined(input.runId);
  if (runId) filters.runId = runId;
  const evalSessionId = trimmedOrUndefined(input.evalSessionId);
  if (evalSessionId) filters.evalSessionId = evalSessionId;
  const scenarioId = trimmedOrUndefined(input.scenarioId);
  if (scenarioId) filters.scenarioId = scenarioId;
  const testRunId = trimmedOrUndefined(input.testRunId);
  if (testRunId) filters.testRunId = testRunId;
  const turnId = trimmedOrUndefined(input.turnId);
  if (turnId) filters.turnId = turnId;
  const privacyClass = trimmedOrUndefined(input.privacyClass);
  if (privacyClass) filters.privacyClass = privacyClass;
  const status = trimmedOrUndefined(input.status);
  if (status) filters.status = status;

  const limit = parsePositiveInteger(input.limit);
  if (limit !== undefined) filters.limit = limit;
  const minDivergenceScore = parseBoundedUnit(input.minDivergenceScore);
  if (minDivergenceScore !== undefined) filters.minDivergenceScore = minDivergenceScore;
  if (input.timeRange !== 'all') {
    filters.sinceMs = nowMs - TIME_RANGE_MS[input.timeRange];
    filters.untilMs = nowMs;
  }
  return filters;
}

export function formatObserverEvalScore(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return value.toFixed(2);
}

export function formatObserverEvalPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

export function formatObserverEvalSigned(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  const normalized = Math.max(-1, Math.min(1, value));
  return normalized > 0 ? `+${normalized.toFixed(2)}` : normalized.toFixed(2);
}

export function formatObserverEvalTimestamp(value: number | null | undefined): string {
  if (!value || !Number.isFinite(value)) return '-';
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function topDiscreteEmotions(
  snapshot: EmotionStateSnapshot | null | undefined,
  limit = 5,
): Array<{ emotion: string; intensity: number }> {
  return Object.entries(snapshot?.discrete ?? {})
    .filter(([, intensity]) => Number.isFinite(intensity) && intensity > 0)
    .sort(([, left], [, right]) => right - left)
    .slice(0, limit)
    .map(([emotion, intensity]) => ({ emotion, intensity }));
}

export function statusBadgeClass(status: string): string {
  const classes: Record<string, string> = {
    enabled: 'border-moss-300 bg-moss-50 text-moss-700',
    ok: 'border-moss-300 bg-moss-50 text-moss-700',
    completed: 'border-moss-300 bg-moss-50 text-moss-700',
    aligned: 'border-moss-300 bg-moss-50 text-moss-700',
    running: 'border-gold-300 bg-gold-50 text-gold-800',
    watch: 'border-gold-300 bg-gold-50 text-gold-800',
    degraded: 'border-gold-300 bg-gold-50 text-gold-800',
    partial: 'border-gold-300 bg-gold-50 text-gold-800',
    divergent: 'border-wilt-300 bg-wilt-50 text-wilt-700',
    failed: 'border-wilt-300 bg-wilt-50 text-wilt-700',
    error: 'border-wilt-300 bg-wilt-50 text-wilt-700',
    blocking: 'border-wilt-300 bg-wilt-50 text-wilt-700',
    unavailable: 'border-wilt-300 bg-wilt-50 text-wilt-700',
    warning: 'border-gold-300 bg-gold-50 text-gold-800',
    redacted: 'border-gold-300 bg-gold-50 text-gold-800',
    empty: 'border-bark-300 bg-bark-100 text-shadow-700',
    loading: 'border-bark-300 bg-bark-100 text-shadow-700',
    populated: 'border-moss-300 bg-moss-50 text-moss-700',
    info: 'border-bark-300 bg-bark-100 text-shadow-700',
    disabled: 'border-bark-300 bg-bark-100 text-shadow-700',
  };
  return classes[status] ?? 'border-bark-300 bg-bark-100 text-shadow-700';
}

export function labelizeObserverEval(value: string | null | undefined): string {
  if (!value) return '-';
  return value
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseBoundedUnit(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.max(0, Math.min(1, parsed));
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
