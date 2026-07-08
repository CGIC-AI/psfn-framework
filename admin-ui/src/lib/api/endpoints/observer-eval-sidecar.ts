import { apiGet } from '$lib/api/client';
import type { EmotionStateSnapshot } from '../../../../../src/core/emotion/state.js';

export type ObserverEvalSidecarHealthStatus = 'disabled' | 'enabled' | 'degraded' | 'unavailable';
export type ObserverEvalSidecarObservationStatus = 'ok' | 'degraded' | 'error';
export type ObserverEvalSidecarRunStatus = 'running' | 'completed' | 'degraded' | 'failed';
export type ObserverEvalPrivacyClass = 'public' | 'private' | 'restricted' | 'closed' | 'fail_closed';
export type ObserverEvalAgreementBand = 'aligned' | 'watch' | 'divergent' | 'unavailable';
export type ObserverEvalMetricsStatus = 'available' | 'partial' | 'unavailable';

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

export interface ObserverEvalPrivacyDecision {
  privacyClass: ObserverEvalPrivacyClass;
  sensitivity: string | null;
  channelVisibility: string | null;
  rawContentRedacted: true;
  sensitiveIdentifiersRedacted: true;
  derivedTelemetryPermitted: boolean;
  redactionReason: string;
}

export interface ObserverEvalSanitizedTurnIdentity {
  turnId: string;
  channelType: string;
  messageTimestampMs: number;
  taskKind?: string;
  redactedIdentifiers: readonly ['requestId', 'sourceMessageId', 'channelId'];
}

export interface ObserverEvalSanitizedSourceMetadata {
  routingSource: string;
  isDirectMessage: boolean;
  channelPrivacy: string | null;
}

export interface ObserverEvalSanitizedEmotionSnapshot {
  snapshot: EmotionStateSnapshot | null;
  appraisalEntryCount: number;
  snapshotRedacted: boolean;
}

export interface ObserverEvalSanitizedTurnMetadata {
  trustLevel: string;
  speakerRole: 'user' | 'system';
  contactResolved: boolean;
  contentLength: number;
  attachmentCount: number;
  hasVisionInput: boolean;
  sensitivity: string | null;
}

export interface ObserverEvalSanitizedProvenance {
  seam: string;
  capturedAt: number;
  emotionSnapshotSource: string;
  correlation: {
    callType: string;
    purposeRedacted: true;
  };
  redactedIdentifiers: readonly ['emotionSessionId'];
}

export interface ObserverEvalPsfnEmotionReference {
  snapshot: EmotionStateSnapshot | null;
  snapshotRef?: string;
  appraisalEntryCount: number;
  snapshotSource: string;
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

export interface ObserverEvalComparisonSummary {
  schemaVersion: 1;
  metricsVersion: string;
  status: ObserverEvalMetricsStatus;
  agreementBand: ObserverEvalAgreementBand;
  score: {
    rawDivergenceScore: number | null;
    confidenceWeightedDivergenceScore: number | null;
    confidenceWeight: number | null;
    components: readonly unknown[];
  };
  deltas: {
    valence: number | null;
    arousal: number | null;
    vadDistance: number | null;
    dominance: number | null;
    intensity: number | null;
  };
  familyConfusion: {
    psfnPrimaryFamily: string | null;
    emosimPrimaryFamily: string | null;
    familyMismatch: boolean | null;
    familyOverlap: number | null;
    psfnPrimaryLabel: string | null;
    emosimDominantEmotion: string | null;
    unmappedSignal: number | null;
  };
  direction: {
    psfnDirection: string | null;
    emosimDirection: string | null;
    directionMismatch: boolean | null;
    suppressionOrDecayMismatch: boolean | null;
  };
  projection: {
    projectionConfidence: number | null;
    lowConfidence: boolean;
    projectionAvailable: boolean;
    projectionFailed: boolean;
    confidenceWeight: number | null;
  };
  privacy: {
    privacyClass: ObserverEvalPrivacyClass | null;
    sensitivity: string | null;
    redactionReason: string | null;
    derivedTelemetryPermitted: boolean | null;
    redactedObservation: boolean;
  };
  reasons: Array<{
    code: string;
    severity: 'info' | 'warning' | 'blocking';
    detail: string;
  }>;
  persistence: {
    schemaVersion: 1;
    metricsVersion: string;
    divergenceScore: number | null;
    vadDistance: number | null;
    familyMismatch: boolean | null;
    directionMismatch: boolean | null;
    unmappedSignal: number | null;
    details?: Record<string, unknown>;
  };
}

export interface ObserverEvalSidecarErrorState {
  message: string;
  code?: string;
  recoverable: boolean;
  redacted: true;
  redactionReason: string;
  details?: Record<string, boolean | number | string | null>;
}

export interface ObserverEvalSidecarRetentionMetadata {
  retentionClass: string;
  policyId: string;
  capturedAtMs: number;
  retainUntilMs: number;
  reason: string;
  deleteAfterMs?: number;
  tags?: readonly string[];
  metadata?: Record<string, unknown>;
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
  const suffix = params.toString();
  return apiGet<AdminObserverEvalSidecarLeverEventListData>(
    `${OBSERVER_EVAL_SIDECAR_BASE_PATH}/lever-events${suffix ? `?${suffix}` : ''}`,
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
  const suffix = params.toString();
  return suffix ? `?${suffix}` : '';
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
  const suffix = params.toString();
  return suffix ? `?${suffix}` : '';
}

function appendString(params: URLSearchParams, key: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed) params.set(key, trimmed);
}

function appendNumber(params: URLSearchParams, key: string, value: number | undefined): void {
  if (value === undefined || !Number.isFinite(value)) return;
  params.set(key, String(value));
}
