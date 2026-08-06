import { apiGet } from '$lib/api/client';
import { withQuery } from '$lib/api/query';
import type {
  ObserverEvalAgreementBand as CanonicalObserverEvalAgreementBand,
  ObserverEvalComparisonSummary as CanonicalObserverEvalComparisonSummary,
  ObserverEvalMetricsStatus as CanonicalObserverEvalMetricsStatus,
} from '../../../../../src/core/eval/observer-sidecar/metrics.js';
import type {
  ObserverEvalPsfnEmotionReference as CanonicalObserverEvalPsfnEmotionReference,
  ObserverEvalSidecarErrorState as CanonicalObserverEvalSidecarErrorState,
  ObserverEvalSidecarObservationStatus as CanonicalObserverEvalSidecarObservationStatus,
  ObserverEvalSidecarRetentionMetadata as CanonicalObserverEvalSidecarRetentionMetadata,
  ObserverEvalSidecarRunStatus as CanonicalObserverEvalSidecarRunStatus,
} from '../../../../../src/core/eval/observer-sidecar/persistence.js';
import type {
  ObserverEvalPrivacyClass as CanonicalObserverEvalPrivacyClass,
  ObserverEvalPrivacyDecision as CanonicalObserverEvalPrivacyDecision,
  ObserverEvalSanitizedEmotionSnapshot as CanonicalObserverEvalSanitizedEmotionSnapshot,
  ObserverEvalSanitizedProvenance as CanonicalObserverEvalSanitizedProvenance,
  ObserverEvalSanitizedSourceMetadata as CanonicalObserverEvalSanitizedSourceMetadata,
  ObserverEvalSanitizedTurnIdentity as CanonicalObserverEvalSanitizedTurnIdentity,
  ObserverEvalSanitizedTurnMetadata as CanonicalObserverEvalSanitizedTurnMetadata,
} from '../../../../../src/core/eval/observer-sidecar/privacy.js';

export type ObserverEvalSidecarHealthStatus = 'disabled' | 'enabled' | 'degraded' | 'unavailable';
export type ObserverEvalSidecarObservationStatus = CanonicalObserverEvalSidecarObservationStatus;
export type ObserverEvalSidecarRunStatus = CanonicalObserverEvalSidecarRunStatus;
export type ObserverEvalPrivacyClass = CanonicalObserverEvalPrivacyClass;
export type ObserverEvalAgreementBand = CanonicalObserverEvalAgreementBand;
export type ObserverEvalMetricsStatus = CanonicalObserverEvalMetricsStatus;
export type ObserverEvalPrivacyDecision = CanonicalObserverEvalPrivacyDecision;
export type ObserverEvalSanitizedTurnIdentity = CanonicalObserverEvalSanitizedTurnIdentity;
export type ObserverEvalSanitizedSourceMetadata = CanonicalObserverEvalSanitizedSourceMetadata;
export type ObserverEvalSanitizedEmotionSnapshot = CanonicalObserverEvalSanitizedEmotionSnapshot;
export type ObserverEvalSanitizedTurnMetadata = CanonicalObserverEvalSanitizedTurnMetadata;
export type ObserverEvalSanitizedProvenance = CanonicalObserverEvalSanitizedProvenance;
export type ObserverEvalPsfnEmotionReference = CanonicalObserverEvalPsfnEmotionReference;
export type ObserverEvalComparisonSummary = CanonicalObserverEvalComparisonSummary;
export type ObserverEvalSidecarErrorState = CanonicalObserverEvalSidecarErrorState;
export type ObserverEvalSidecarRetentionMetadata =
  CanonicalObserverEvalSidecarRetentionMetadata;

export interface AdminObserverEvalSidecarObservationFilters {
  runId?: string;
  evalSessionId?: string;
  scenarioId?: string;
  testRunId?: string;
  turnId?: string;
  privacyClass?: ObserverEvalPrivacyClass | string;
  status?: ObserverEvalSidecarObservationStatus | string;
  minDivergenceScore?: number;
  sinceMs?: number;
  untilMs?: number;
  limit?: number;
}

export interface AdminObserverEvalSidecarRunFilters {
  evalSessionId?: string;
  scenarioId?: string;
  testRunId?: string;
  status?: ObserverEvalSidecarRunStatus | string;
  sinceMs?: number;
  untilMs?: number;
  limit?: number;
}

export type ObserverEvalSidecarLeverName =
  | 'would_message'
  | 'would_check_in'
  | 'would_rest'
  | 'rumination_watch';

export interface AdminObserverEvalSidecarLeverEventFilters {
  lever?: ObserverEvalSidecarLeverName | string;
  runId?: string;
  sinceMs?: number;
  untilMs?: number;
  limit?: number;
}

export interface AdminObserverEvalSidecarLeverEventView {
  eventId: string;
  runId: string;
  lever: ObserverEvalSidecarLeverName;
  firedAtMs: number;
  observationId: string;
  detail: string;
  stateValues: Record<string, number | string | null>;
  sustainMs: number;
  firstCrossingMs: number;
  sustainedForMs: number;
  cooldown: {
    cooldownMs: number;
    previousFiredAtMs: number | null;
    refireReason: 'first_fire' | 'condition_reset' | 'cooldown_elapsed';
  };
  retention: ObserverEvalSidecarRetentionMetadata;
  evalOwner: string;
  authoritative: false;
  nonAuthoritativeNotice: string;
}

export interface AdminObserverEvalSidecarLeverEventListData {
  events: AdminObserverEvalSidecarLeverEventView[];
  filters: AdminObserverEvalSidecarLeverEventFilters;
  pagination: {
    limit: number;
    count: number;
    hasMore: boolean;
  };
}

export interface AdminObserverEvalSidecarHealthData {
  status: ObserverEvalSidecarHealthStatus;
  observedAt: number;
  runtime: {
    status: ObserverEvalSidecarHealthStatus;
    observedAt: number;
    sidecarId?: string;
    enabled: boolean;
    available: boolean;
    accepting: boolean;
    queue: {
      queuedCount: number;
      runningCount: number;
      maxQueuedTurns: number;
      overflowPolicy: string;
      shuttingDown: boolean;
    };
    counts: {
      accepted: number;
      completed: number;
      dropped: number;
      failed: number;
      timedOut: number;
      retried: number;
      lifecycleHookFailed: number;
      shutdownTimedOut: number;
    };
    dropCounts: Record<string, number>;
    failureCounts: Record<string, number>;
  } | null;
  persistence: {
    available: boolean;
    evalOwned: boolean;
    authoritative: false;
  };
  latestLifecycleState?: {
    status: ObserverEvalSidecarHealthStatus;
    observedAt: number;
    sidecarId?: string;
    reason?: string;
  };
}

export interface AdminObserverEvalSidecarObservationListData {
  observations: AdminObserverEvalSidecarObservationView[];
  filters: AdminObserverEvalSidecarObservationFilters;
  pagination: {
    limit: number;
    count: number;
    hasMore: boolean;
  };
}

export interface AdminObserverEvalSidecarRunListData {
  runs: AdminObserverEvalSidecarRunView[];
  filters: AdminObserverEvalSidecarRunFilters;
  pagination: {
    limit: number;
    count: number;
    hasMore: boolean;
  };
}

export interface AdminObserverEvalSidecarLatestData {
  observation: AdminObserverEvalSidecarObservationView | null;
  filters: Omit<AdminObserverEvalSidecarObservationFilters, 'limit'>;
}

export interface AdminObserverEvalSidecarExportData {
  exportVersion: 'garden.observer-eval-sidecar.export.v1';
  generatedAtMs: number;
  redacted: true;
  filters: AdminObserverEvalSidecarObservationFilters;
  observations: AdminObserverEvalSidecarObservationView[];
}

export interface AdminObserverEvalSidecarRunView {
  runId: string;
  sidecarId: string;
  deployment: string;
  evalSessionId?: string;
  scenarioId?: string;
  testRunId?: string;
  status: ObserverEvalSidecarRunStatus;
  startedAtMs: number;
  completedAtMs?: number;
  retention: ObserverEvalSidecarRetentionMetadata;
  evalOwner: string;
  authoritative: false;
  nonAuthoritativeNotice: string;
}

export interface AdminObserverEvalSidecarObservationView {
  observationId: string;
  runId: string;
  turnId: string;
  capturedAtMs: number;
  observedAtMs: number;
  status: ObserverEvalSidecarObservationStatus;
  privacy: ObserverEvalPrivacyDecision;
  turn: ObserverEvalSanitizedTurnIdentity;
  source: ObserverEvalSanitizedSourceMetadata;
  emotion: ObserverEvalSanitizedEmotionSnapshot;
  metadata: ObserverEvalSanitizedTurnMetadata;
  provenance: ObserverEvalSanitizedProvenance;
  psfnEmotion: ObserverEvalPsfnEmotionReference;
  projection: AdminObserverEvalProjectionView | null;
  emosim: AdminObserverEvalEmoSimView | null;
  metrics: ObserverEvalComparisonSummary;
  error?: ObserverEvalSidecarErrorState;
  degradedState?: Record<string, unknown>;
  retention: ObserverEvalSidecarRetentionMetadata;
  evalOwner: string;
  authoritative: false;
  nonAuthoritativeNotice: string;
}

export interface AdminObserverEvalProjectionView {
  ok: boolean;
  projectionVersion: string;
  source: string;
  confidence: number;
  privacy: ObserverEvalPrivacyDecision;
  missingInputs: Array<{
    feature: string;
    reason: string;
    severity: string;
    detail: string;
  }>;
  caveats: readonly string[];
  projectedAppraisal?: {
    confidence: number;
    privacyClass: string;
    sensitivity: string | null;
    dimensions: Record<string, number>;
  };
  error?: {
    code: string;
    reason: string;
    message: string;
    recoverable: boolean;
    details?: Record<string, boolean | number | string | null>;
  };
}

export interface AdminObserverEvalEmoSimView {
  ok: boolean;
  adapterVersion?: string;
  runtime?: {
    integrationSurface: string;
    timestepPolicy: string;
    snapshotFormat: string;
  };
  dominantEmotion?: string;
  mood?: {
    valence: number;
    arousal: number;
  };
  topEmotions?: Array<{
    emotion: string;
    intensity: number;
  }>;
  error?: {
    code: string;
    reason: string;
    message: string;
    recoverable: boolean;
  };
}

const OBSERVER_EVAL_SIDECAR_BASE_PATH = '/api/admin/evals/observer-sidecar';

export function getObserverEvalSidecarHealth(): Promise<AdminObserverEvalSidecarHealthData> {
  return apiGet<AdminObserverEvalSidecarHealthData>(`${OBSERVER_EVAL_SIDECAR_BASE_PATH}/health`);
}

export function getObserverEvalSidecarLatest(
  filters: Omit<AdminObserverEvalSidecarObservationFilters, 'limit'> = {},
): Promise<AdminObserverEvalSidecarLatestData> {
  const suffix = buildObserverEvalSidecarObservationQuery(filters);
  return apiGet<AdminObserverEvalSidecarLatestData>(
    `${OBSERVER_EVAL_SIDECAR_BASE_PATH}/latest${suffix}`,
  );
}

export function queryObserverEvalSidecarObservations(
  filters: AdminObserverEvalSidecarObservationFilters = {},
): Promise<AdminObserverEvalSidecarObservationListData> {
  const suffix = buildObserverEvalSidecarObservationQuery(filters);
  return apiGet<AdminObserverEvalSidecarObservationListData>(
    `${OBSERVER_EVAL_SIDECAR_BASE_PATH}/observations${suffix}`,
  );
}

export function queryObserverEvalSidecarRuns(
  filters: AdminObserverEvalSidecarRunFilters = {},
): Promise<AdminObserverEvalSidecarRunListData> {
  const suffix = buildObserverEvalSidecarRunQuery(filters);
  return apiGet<AdminObserverEvalSidecarRunListData>(
    `${OBSERVER_EVAL_SIDECAR_BASE_PATH}/runs${suffix}`,
  );
}

export function queryObserverEvalSidecarLeverEvents(
  filters: AdminObserverEvalSidecarLeverEventFilters = {},
): Promise<AdminObserverEvalSidecarLeverEventListData> {
  const params = new URLSearchParams();
  appendString(params, 'lever', filters.lever);
  appendString(params, 'runId', filters.runId);
  appendNumber(params, 'sinceMs', filters.sinceMs);
  appendNumber(params, 'untilMs', filters.untilMs);
  appendNumber(params, 'limit', filters.limit);
  return apiGet<AdminObserverEvalSidecarLeverEventListData>(
    withQuery(`${OBSERVER_EVAL_SIDECAR_BASE_PATH}/lever-events`, params),
  );
}

export function buildObserverEvalSidecarExportPath(
  filters: AdminObserverEvalSidecarObservationFilters = {},
): string {
  return `${OBSERVER_EVAL_SIDECAR_BASE_PATH}/export${buildObserverEvalSidecarObservationQuery(filters)}`;
}

export function exportObserverEvalSidecarObservations(
  filters: AdminObserverEvalSidecarObservationFilters = {},
): Promise<AdminObserverEvalSidecarExportData> {
  return apiGet<AdminObserverEvalSidecarExportData>(buildObserverEvalSidecarExportPath(filters));
}

export function buildObserverEvalSidecarObservationQuery(
  filters: AdminObserverEvalSidecarObservationFilters = {},
): string {
  const params = new URLSearchParams();
  appendString(params, 'runId', filters.runId);
  appendString(params, 'evalSessionId', filters.evalSessionId);
  appendString(params, 'scenarioId', filters.scenarioId);
  appendString(params, 'testRunId', filters.testRunId);
  appendString(params, 'turnId', filters.turnId);
  appendString(params, 'privacyClass', filters.privacyClass);
  appendString(params, 'status', filters.status);
  appendNumber(params, 'minDivergenceScore', filters.minDivergenceScore);
  appendNumber(params, 'sinceMs', filters.sinceMs);
  appendNumber(params, 'untilMs', filters.untilMs);
  appendNumber(params, 'limit', filters.limit);
  return withQuery('', params);
}

export function buildObserverEvalSidecarRunQuery(
  filters: AdminObserverEvalSidecarRunFilters = {},
): string {
  const params = new URLSearchParams();
  appendString(params, 'evalSessionId', filters.evalSessionId);
  appendString(params, 'scenarioId', filters.scenarioId);
  appendString(params, 'testRunId', filters.testRunId);
  appendString(params, 'status', filters.status);
  appendNumber(params, 'sinceMs', filters.sinceMs);
  appendNumber(params, 'untilMs', filters.untilMs);
  appendNumber(params, 'limit', filters.limit);
  return withQuery('', params);
}

function appendString(params: URLSearchParams, key: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed) params.set(key, trimmed);
}

function appendNumber(params: URLSearchParams, key: string, value: number | undefined): void {
  if (value === undefined || !Number.isFinite(value)) return;
  params.set(key, String(value));
}
