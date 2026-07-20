import type { TurnID } from './turn-contracts.js';
import { isRecord } from '../utils/types.js';

export const CONTEXT_COHERENCE_SIGNALS = [
  'confusion_ask',
  'looping',
  'confabulation_self_report',
  'concern_rumination',
  'operator_intervention',
] as const;

export type ContextCoherenceSignal = typeof CONTEXT_COHERENCE_SIGNALS[number];

export type ContextCoherenceOperatorLabel =
  | 'confusion'
  | 'looping'
  | 'confabulation'
  | 'temporal_coherence';

const CONTEXT_COHERENCE_OPERATOR_LABELS: readonly ContextCoherenceOperatorLabel[] = [
  'confusion',
  'looping',
  'confabulation',
  'temporal_coherence',
];

export interface ContextCoherenceSessionContext {
  recentMirrorNoteCount: number | null;
  timeGapMs: number | null;
  activeConcernCount: number | null;
}

export interface ContextCoherenceCorrelation {
  kind: 'missing_turn';
  healed: boolean;
  expectedMinEntryId: number;
  observedMaxEntryId: number | null;
}

/**
 * Privacy-safe context-coherence canary event. It deliberately carries no
 * transcript or concern text and is not an emotion-appraisal or memory input.
 */
export interface ContextCoherenceEvent {
  schemaVersion: 1;
  id: string;
  signal: ContextCoherenceSignal;
  source: 'turn_end' | 'observer_eval';
  timestamp: number;
  channelId: string;
  sessionId?: string;
  turnId?: TurnID;
  requestId?: string;
  detail: string;
  groundTruth: boolean;
  operatorLabel?: ContextCoherenceOperatorLabel;
  context: ContextCoherenceSessionContext;
  correlations: ContextCoherenceCorrelation[];
  eligibleForEmotionAppraisal: false;
  eligibleForMemoryCandidacy: false;
}

const EVENT_KEYS = new Set([
  'schemaVersion',
  'id',
  'signal',
  'source',
  'timestamp',
  'channelId',
  'sessionId',
  'turnId',
  'requestId',
  'detail',
  'groundTruth',
  'operatorLabel',
  'context',
  'correlations',
  'eligibleForEmotionAppraisal',
  'eligibleForMemoryCandidacy',
]);
const CONTEXT_KEYS = new Set([
  'recentMirrorNoteCount',
  'timeGapMs',
  'activeConcernCount',
]);
const CORRELATION_KEYS = new Set([
  'kind',
  'healed',
  'expectedMinEntryId',
  'observedMaxEntryId',
]);

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every(key => keys.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null
    || (typeof value === 'number' && Number.isInteger(value) && value >= 0);
}

export function isContextCoherenceSignal(value: unknown): value is ContextCoherenceSignal {
  return typeof value === 'string'
    && (CONTEXT_COHERENCE_SIGNALS as readonly string[]).includes(value);
}

function isContextCoherenceOperatorLabel(value: unknown): value is ContextCoherenceOperatorLabel {
  return typeof value === 'string'
    && (CONTEXT_COHERENCE_OPERATOR_LABELS as readonly string[]).includes(value);
}

function parseSessionContext(value: unknown): ContextCoherenceSessionContext | null {
  if (!isRecord(value) || !hasOnlyKeys(value, CONTEXT_KEYS)) return null;
  if (
    !isNullableNonNegativeInteger(value.recentMirrorNoteCount)
    || !isNullableNonNegativeInteger(value.timeGapMs)
    || !isNullableNonNegativeInteger(value.activeConcernCount)
  ) {
    return null;
  }
  return {
    recentMirrorNoteCount: value.recentMirrorNoteCount,
    timeGapMs: value.timeGapMs,
    activeConcernCount: value.activeConcernCount,
  };
}

function parseCorrelation(value: unknown): ContextCoherenceCorrelation | null {
  if (!isRecord(value) || !hasOnlyKeys(value, CORRELATION_KEYS)) return null;
  if (
    value.kind !== 'missing_turn'
    || typeof value.healed !== 'boolean'
    || !isNullableNonNegativeInteger(value.expectedMinEntryId)
    || value.expectedMinEntryId === null
    || !isNullableNonNegativeInteger(value.observedMaxEntryId)
  ) {
    return null;
  }
  return {
    kind: 'missing_turn',
    healed: value.healed,
    expectedMinEntryId: value.expectedMinEntryId,
    observedMaxEntryId: value.observedMaxEntryId,
  };
}

/** Strict decoder for the versioned, privacy-safe telemetry boundary. */
export function parseContextCoherenceEvent(value: unknown): ContextCoherenceEvent | null {
  if (!isRecord(value) || !hasOnlyKeys(value, EVENT_KEYS)) return null;
  const context = parseSessionContext(value.context);
  const correlations = Array.isArray(value.correlations)
    ? value.correlations.map(parseCorrelation)
    : null;
  const operatorLabel = value.operatorLabel;
  if (
    value.schemaVersion !== 1
    || !isNonEmptyString(value.id)
    || !isContextCoherenceSignal(value.signal)
    || (value.source !== 'turn_end' && value.source !== 'observer_eval')
    || !isNullableNonNegativeInteger(value.timestamp)
    || value.timestamp === null
    || !isNonEmptyString(value.channelId)
    || (value.sessionId !== undefined && !isNonEmptyString(value.sessionId))
    || (value.turnId !== undefined && !isNonEmptyString(value.turnId))
    || (value.requestId !== undefined && !isNonEmptyString(value.requestId))
    || !isNonEmptyString(value.detail)
    || typeof value.groundTruth !== 'boolean'
    || !context
    || !correlations
    || correlations.some(correlation => correlation === null)
    || value.eligibleForEmotionAppraisal !== false
    || value.eligibleForMemoryCandidacy !== false
  ) {
    return null;
  }
  const isOperatorIntervention = value.signal === 'operator_intervention';
  if (isOperatorIntervention !== value.groundTruth) {
    return null;
  }
  let parsedOperatorLabel: ContextCoherenceOperatorLabel | undefined;
  if (isOperatorIntervention) {
    if (!isContextCoherenceOperatorLabel(operatorLabel)) return null;
    parsedOperatorLabel = operatorLabel;
  } else if (operatorLabel !== undefined) {
    return null;
  }
  return {
    schemaVersion: 1,
    id: value.id,
    signal: value.signal,
    source: value.source,
    timestamp: value.timestamp,
    channelId: value.channelId,
    ...(value.sessionId !== undefined ? { sessionId: value.sessionId } : {}),
    ...(value.turnId !== undefined ? { turnId: value.turnId as TurnID } : {}),
    ...(value.requestId !== undefined ? { requestId: value.requestId } : {}),
    detail: value.detail,
    groundTruth: value.groundTruth,
    ...(parsedOperatorLabel ? { operatorLabel: parsedOperatorLabel } : {}),
    context,
    correlations: correlations as ContextCoherenceCorrelation[],
    eligibleForEmotionAppraisal: false,
    eligibleForMemoryCandidacy: false,
  };
}
