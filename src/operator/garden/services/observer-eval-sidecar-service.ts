import {
  createObserverEvalComparisonSummary,
  type ObserverEvalComparisonSummary,
} from '../../../core/eval/observer-sidecar/metrics.js';
import type {
  ObserverEvalSidecarLeverEventQuery,
  ObserverEvalSidecarLeverEventRecord,
  ObserverEvalSidecarLeverPersistencePort,
  ObserverEvalSidecarObservationQuery,
  ObserverEvalSidecarObservationRecord,
  ObserverEvalSidecarPersistencePort,
  ObserverEvalSidecarRunQuery,
  ObserverEvalSidecarRunRecord,
} from '../../../core/eval/observer-sidecar/persistence.js';
import type {
  ObserverEvalPrivacyDecision,
  ObserverEvalSanitizedEmotionSnapshot,
  ObserverEvalSanitizedProvenance,
  ObserverEvalSanitizedSourceMetadata,
  ObserverEvalSanitizedTurnIdentity,
  ObserverEvalSanitizedTurnMetadata,
} from '../../../core/eval/observer-sidecar/privacy.js';
import type { ObserverAppraisalProjectionResult } from '../../../core/eval/observer-sidecar/projection.js';
import type { EmoSimAdapterRunResult } from '../../../core/eval/observer-sidecar/emosim-adapter.js';
import type {
  ObserverEvalLifecycleState,
  ObserverEvalSidecarHealthSnapshot,
} from '../../../core/eval/observer-sidecar/types.js';

export const ADMIN_OBSERVER_EVAL_EXPORT_VERSION = 'garden.observer-eval-sidecar.export.v1' as const;

export interface AdminObserverEvalSidecarObservationFilters extends ObserverEvalSidecarObservationQuery {}
export interface AdminObserverEvalSidecarRunFilters extends ObserverEvalSidecarRunQuery {}
export interface AdminObserverEvalSidecarLeverEventFilters extends ObserverEvalSidecarLeverEventQuery {}

export interface AdminObserverEvalSidecarHealthData {
  status: ObserverEvalSidecarHealthSnapshot['status'] | 'unavailable';
  observedAt: number;
  runtime: ObserverEvalSidecarHealthSnapshot | null;
  persistence: {
    available: boolean;
    evalOwned: boolean;
    authoritative: false;
  };
  latestLifecycleState?: ObserverEvalLifecycleState;
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
  exportVersion: typeof ADMIN_OBSERVER_EVAL_EXPORT_VERSION;
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
  status: ObserverEvalSidecarRunRecord['status'];
  startedAtMs: number;
  completedAtMs?: number;
  retention: ObserverEvalSidecarRunRecord['retention'];
  evalOwner: ObserverEvalSidecarRunRecord['evalOwner'];
  authoritative: false;
  nonAuthoritativeNotice: ObserverEvalSidecarRunRecord['nonAuthoritativeNotice'];
}

export interface AdminObserverEvalSidecarObservationView {
  observationId: string;
  runId: string;
  turnId: string;
  capturedAtMs: number;
  observedAtMs: number;
  status: ObserverEvalSidecarObservationRecord['status'];
  privacy: ObserverEvalPrivacyDecision;
  turn: ObserverEvalSanitizedTurnIdentity;
  source: ObserverEvalSanitizedSourceMetadata;
  emotion: ObserverEvalSanitizedEmotionSnapshot;
  metadata: ObserverEvalSanitizedTurnMetadata;
  provenance: ObserverEvalSanitizedProvenance;
  psfnEmotion: ObserverEvalSidecarObservationRecord['psfnEmotion'];
  projection: AdminObserverEvalProjectionView | null;
  emosim: AdminObserverEvalEmoSimView | null;
  metrics: ObserverEvalComparisonSummary;
  error?: ObserverEvalSidecarObservationRecord['error'];
  degradedState?: ObserverEvalSidecarObservationRecord['degradedState'];
  retention: ObserverEvalSidecarObservationRecord['retention'];
  evalOwner: ObserverEvalSidecarObservationRecord['evalOwner'];
  authoritative: false;
  nonAuthoritativeNotice: ObserverEvalSidecarObservationRecord['nonAuthoritativeNotice'];
}

export interface AdminObserverEvalProjectionView {
  ok: boolean;
  projectionVersion: ObserverAppraisalProjectionResult['projectionVersion'];
  source: ObserverAppraisalProjectionResult['source'];
  confidence: number;
  privacy: ObserverAppraisalProjectionResult['privacy'];
  missingInputs: ObserverAppraisalProjectionResult['missingInputs'];
  caveats: ObserverAppraisalProjectionResult['caveats'];
  projectedAppraisal?: {
    confidence: number;
    privacyClass: string;
    sensitivity: string | null;
    dimensions: Record<string, number>;
  };
  error?: Extract<ObserverAppraisalProjectionResult, { ok: false }>['error'];
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
  error?: Extract<EmoSimAdapterRunResult, { ok: false }>['error'];
}

export interface AdminObserverEvalSidecarLeverEventView {
  eventId: string;
  runId: string;
  lever: ObserverEvalSidecarLeverEventRecord['lever'];
  firedAtMs: number;
  observationId: string;
  detail: string;
  stateValues: Record<string, number | string | null>;
  sustainMs: number;
  firstCrossingMs: number;
  /** Actual sustained duration at fire time (firedAtMs - firstCrossingMs). */
  sustainedForMs: number;
  cooldown: ObserverEvalSidecarLeverEventRecord['cooldown'];
  retention: ObserverEvalSidecarLeverEventRecord['retention'];
  evalOwner: ObserverEvalSidecarLeverEventRecord['evalOwner'];
  authoritative: false;
  nonAuthoritativeNotice: ObserverEvalSidecarLeverEventRecord['nonAuthoritativeNotice'];
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

export interface AdminObserverEvalSidecarService {
  getHealth(): Promise<AdminObserverEvalSidecarHealthData>;
  getLatestObservation(
    filters?: Omit<AdminObserverEvalSidecarObservationFilters, 'limit'>,
  ): Promise<AdminObserverEvalSidecarLatestData>;
  queryObservations(
    filters?: AdminObserverEvalSidecarObservationFilters,
  ): Promise<AdminObserverEvalSidecarObservationListData>;
  queryRuns(filters?: AdminObserverEvalSidecarRunFilters): Promise<AdminObserverEvalSidecarRunListData>;
  exportObservations(
    filters?: AdminObserverEvalSidecarObservationFilters,
  ): Promise<AdminObserverEvalSidecarExportData>;
  queryLeverEvents(
    filters?: AdminObserverEvalSidecarLeverEventFilters,
  ): Promise<AdminObserverEvalSidecarLeverEventListData>;
}

export interface AdminObserverEvalSidecarDataServiceOptions {
  persistence?: ObserverEvalSidecarPersistencePort | null;
  leverEvents?: ObserverEvalSidecarLeverPersistencePort | null;
  getHealthSnapshot?: (() => ObserverEvalSidecarHealthSnapshot | null) | null;
  nowMs?: () => number;
}

export class AdminObserverEvalSidecarDataService implements AdminObserverEvalSidecarService {
  private readonly nowMs: () => number;

  constructor(private readonly options: AdminObserverEvalSidecarDataServiceOptions) {
    this.nowMs = options.nowMs ?? Date.now;
  }

  async getHealth(): Promise<AdminObserverEvalSidecarHealthData> {
    const runtime = this.options.getHealthSnapshot?.() ?? null;
    return {
      status: runtime?.status ?? 'unavailable',
      observedAt: runtime?.observedAt ?? this.nowMs(),
      runtime,
      persistence: {
        available: Boolean(this.options.persistence),
        evalOwned: Boolean(this.options.persistence),
        authoritative: false,
      },
      ...(runtime?.lastLifecycleState ? { latestLifecycleState: runtime.lastLifecycleState } : {}),
    };
  }

  async getLatestObservation(
    filters: Omit<AdminObserverEvalSidecarObservationFilters, 'limit'> = {},
  ): Promise<AdminObserverEvalSidecarLatestData> {
    const persistence = this.requirePersistence();
    const observation = await persistence.getLatestObservation(filters);
    return {
      observation: observation ? toObservationView(observation) : null,
      filters,
    };
  }

  async queryObservations(
    filters: AdminObserverEvalSidecarObservationFilters = {},
  ): Promise<AdminObserverEvalSidecarObservationListData> {
    const persistence = this.requirePersistence();
    const normalized = normalizeObservationFilters(filters);
    const rows = await persistence.queryObservations(normalized);
    return {
      observations: rows.slice(0, normalized.limit).map(toObservationView),
      filters: normalized,
      pagination: {
        limit: normalized.limit,
        count: Math.min(rows.length, normalized.limit),
        hasMore: rows.length > normalized.limit,
      },
    };
  }

  async queryRuns(filters: AdminObserverEvalSidecarRunFilters = {}): Promise<AdminObserverEvalSidecarRunListData> {
    const persistence = this.requirePersistence();
    const normalized = normalizeRunFilters(filters);
    const rows = await persistence.queryRuns(normalized);
    return {
      runs: rows.slice(0, normalized.limit).map(toRunView),
      filters: normalized,
      pagination: {
        limit: normalized.limit,
        count: Math.min(rows.length, normalized.limit),
        hasMore: rows.length > normalized.limit,
      },
    };
  }

  async exportObservations(
    filters: AdminObserverEvalSidecarObservationFilters = {},
  ): Promise<AdminObserverEvalSidecarExportData> {
    const list = await this.queryObservations(filters);
    return {
      exportVersion: ADMIN_OBSERVER_EVAL_EXPORT_VERSION,
      generatedAtMs: this.nowMs(),
      redacted: true,
      filters: list.filters,
      observations: list.observations,
    };
  }

  async queryLeverEvents(
    filters: AdminObserverEvalSidecarLeverEventFilters = {},
  ): Promise<AdminObserverEvalSidecarLeverEventListData> {
    const leverEvents = this.requireLeverPersistence();
    const normalized = normalizeLeverEventFilters(filters);
    const rows = await leverEvents.queryLeverEvents(normalized);
    return {
      events: rows.slice(0, normalized.limit).map(toLeverEventView),
      filters: normalized,
      pagination: {
        limit: normalized.limit,
        count: Math.min(rows.length, normalized.limit),
        hasMore: rows.length > normalized.limit,
      },
    };
  }

  private requirePersistence(): ObserverEvalSidecarPersistencePort {
    if (!this.options.persistence) {
      throw new ObserverEvalSidecarApiUnavailableError('Observer eval sidecar persistence unavailable');
    }
    return this.options.persistence;
  }

  private requireLeverPersistence(): ObserverEvalSidecarLeverPersistencePort {
    if (!this.options.leverEvents) {
      throw new ObserverEvalSidecarApiUnavailableError('Observer eval sidecar lever persistence unavailable');
    }
    return this.options.leverEvents;
  }
}

export class ObserverEvalSidecarApiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObserverEvalSidecarApiUnavailableError';
  }
}

export function isObserverEvalSidecarApiUnavailableError(
  error: unknown,
): error is ObserverEvalSidecarApiUnavailableError {
  return error instanceof ObserverEvalSidecarApiUnavailableError;
}

function toObservationView(record: ObserverEvalSidecarObservationRecord): AdminObserverEvalSidecarObservationView {
  return {
    observationId: record.observationId,
    runId: record.runId,
    turnId: record.turnId,
    capturedAtMs: record.capturedAtMs,
    observedAtMs: record.observedAtMs,
    status: record.status,
    privacy: structuredClone(record.privacy),
    turn: structuredClone(record.sanitizedInput.turn),
    source: structuredClone(record.sanitizedInput.source),
    emotion: structuredClone(record.sanitizedInput.emotion),
    metadata: structuredClone(record.sanitizedInput.metadata),
    provenance: structuredClone(record.sanitizedInput.provenance),
    psfnEmotion: structuredClone(record.psfnEmotion),
    projection: record.projection ? toProjectionView(record.projection) : null,
    emosim: record.emosim ? toEmoSimView(record.emosim) : null,
    metrics: createObserverEvalComparisonSummary({
      crosswalk: record.crosswalk,
      projection: record.projection,
      privacy: record.privacy,
      details: record.comparisonMetrics.details,
    }),
    ...(record.error ? { error: structuredClone(record.error) } : {}),
    ...(record.degradedState ? { degradedState: structuredClone(record.degradedState) } : {}),
    retention: structuredClone(record.retention),
    evalOwner: record.evalOwner,
    authoritative: false,
    nonAuthoritativeNotice: record.nonAuthoritativeNotice,
  };
}

function toRunView(record: ObserverEvalSidecarRunRecord): AdminObserverEvalSidecarRunView {
  return {
    runId: record.runId,
    sidecarId: record.sidecarId,
    deployment: record.deployment,
    ...(record.evalSessionId ? { evalSessionId: record.evalSessionId } : {}),
    ...(record.scenarioId ? { scenarioId: record.scenarioId } : {}),
    ...(record.testRunId ? { testRunId: record.testRunId } : {}),
    status: record.status,
    startedAtMs: record.startedAtMs,
    ...(record.completedAtMs !== undefined ? { completedAtMs: record.completedAtMs } : {}),
    retention: structuredClone(record.retention),
    evalOwner: record.evalOwner,
    authoritative: false,
    nonAuthoritativeNotice: record.nonAuthoritativeNotice,
  };
}

function toProjectionView(projection: ObserverAppraisalProjectionResult): AdminObserverEvalProjectionView {
  const base = {
    ok: projection.ok,
    projectionVersion: projection.projectionVersion,
    source: projection.source,
    confidence: projection.confidence,
    privacy: structuredClone(projection.privacy),
    missingInputs: structuredClone(projection.missingInputs),
    caveats: structuredClone(projection.caveats),
  };
  if (!projection.ok) {
    return {
      ...base,
      error: structuredClone(projection.error),
    };
  }
  return {
    ...base,
    projectedAppraisal: {
      confidence: projection.projectedAppraisal.confidence,
      privacyClass: projection.projectedAppraisal.privacyClass,
      sensitivity: projection.projectedAppraisal.sensitivity,
      dimensions: structuredClone(projection.projectedAppraisal.dimensions),
    },
  };
}

function toEmoSimView(result: EmoSimAdapterRunResult): AdminObserverEvalEmoSimView {
  if (!result.ok) {
    return {
      ok: false,
      error: structuredClone(result.error),
    };
  }
  const snapshot = result.output.snapshots.afterTick;
  return {
    ok: true,
    adapterVersion: result.output.adapterVersion,
    runtime: {
      integrationSurface: result.output.runtime.integrationSurface,
      timestepPolicy: result.output.runtime.timestepPolicy,
      snapshotFormat: result.output.runtime.snapshotFormat,
    },
    dominantEmotion: snapshot.dominant,
    mood: {
      valence: snapshot.mood.valence,
      arousal: snapshot.mood.arousal,
    },
    topEmotions: Object.entries(snapshot.emotions)
      .filter(([, intensity]) => intensity > 0)
      .sort(([, left], [, right]) => right - left)
      .slice(0, 8)
      .map(([emotion, intensity]) => ({ emotion, intensity })),
  };
}

function normalizeObservationFilters(
  filters: AdminObserverEvalSidecarObservationFilters,
): Required<Pick<AdminObserverEvalSidecarObservationFilters, 'limit'>> & AdminObserverEvalSidecarObservationFilters {
  return {
    ...filters,
    limit: normalizeLimit(filters.limit),
  };
}

function normalizeRunFilters(
  filters: AdminObserverEvalSidecarRunFilters,
): Required<Pick<AdminObserverEvalSidecarRunFilters, 'limit'>> & AdminObserverEvalSidecarRunFilters {
  return {
    ...filters,
    limit: normalizeLimit(filters.limit),
  };
}

function normalizeLeverEventFilters(
  filters: AdminObserverEvalSidecarLeverEventFilters,
): Required<Pick<AdminObserverEvalSidecarLeverEventFilters, 'limit'>> & AdminObserverEvalSidecarLeverEventFilters {
  return {
    ...filters,
    limit: normalizeLimit(filters.limit),
  };
}

function toLeverEventView(record: ObserverEvalSidecarLeverEventRecord): AdminObserverEvalSidecarLeverEventView {
  return {
    eventId: record.eventId,
    runId: record.runId,
    lever: record.lever,
    firedAtMs: record.firedAtMs,
    observationId: record.observationId,
    detail: record.detail,
    stateValues: structuredClone(record.stateValues),
    sustainMs: record.sustainMs,
    firstCrossingMs: record.firstCrossingMs,
    sustainedForMs: Math.max(0, record.firedAtMs - record.firstCrossingMs),
    cooldown: structuredClone(record.cooldown),
    retention: structuredClone(record.retention),
    evalOwner: record.evalOwner,
    authoritative: false,
    nonAuthoritativeNotice: record.nonAuthoritativeNotice,
  };
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isInteger(limit) || limit < 1) return 100;
  return Math.min(limit, 1_000);
}
