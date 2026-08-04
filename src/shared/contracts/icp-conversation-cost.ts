import { ICP_COST_PURPOSE_VALUES } from './charge-policy.js';
import type {
  IcpConversationCostBreakerDecisionReason,
  IcpConversationCostBreakerEvent,
  IcpConversationCostEnforcementState,
  IcpConversationCostProjection,
} from '../telemetry/model-usage.js';
import { isRecord } from '../utils/types.js';

const DECISION_REASONS = [
  'below_warning',
  'final_closeout_reserve',
  'warning_closeout_reserve_only',
  'hard_limit_exceeded',
  'unknown_historical_cost',
  'attempt_already_settled',
  'missing_cost_metadata',
  'accounting_unavailable',
] as const satisfies readonly IcpConversationCostBreakerDecisionReason[];
const ENFORCEMENT_STATES = [
  'normal', 'warning', 'hard_stop', 'unknown_cost',
] as const satisfies readonly IcpConversationCostEnforcementState[];
const EVENT_KEYS = new Set([
  'timestampMs', 'outcome', 'reason', 'logicalCallId', 'attempt',
  'conversationId', 'rootInitiationId', 'localCompanionId', 'costPurpose',
  'costOriginStage', 'provider', 'model', 'slotKey', 'routingPurpose',
  'projectedRequestCostUsd', 'replayed', 'projection',
]);
const PROJECTION_KEYS = new Set([
  'conversationId', 'rootInitiationId', 'actualCostUsd', 'pendingProjectedCostUsd',
  'projectedTotalCostUsd', 'warningThresholdUsd', 'hardLimitUsd',
  'remainingToHardLimitUsd', 'actualAttemptCount', 'unknownCostAttemptCount',
  'pendingReservationCount', 'staleReservationCount', 'settledReservationCount',
  'attributedCompanionCount', 'enforcementState',
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown fields: ${unknown.sort().join(', ')}`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function choice<T extends string>(value: unknown, values: readonly T[], label: string): T {
  const match = typeof value === 'string' ? values.find(candidate => candidate === value) : undefined;
  if (!match) throw new Error(`${label} is unsupported: ${String(value)}`);
  return match;
}

export function parseIcpConversationCostBreakerDecisionReason(
  value: unknown,
): IcpConversationCostBreakerDecisionReason {
  return choice(value, DECISION_REASONS, 'ICP conversation cost decision.reason');
}

function parseProjection(value: unknown): IcpConversationCostProjection {
  const projection = record(value, 'ICP conversation cost event.projection');
  exactKeys(projection, PROJECTION_KEYS, 'ICP conversation cost event.projection');
  return {
    conversationId: text(projection.conversationId, 'projection.conversationId'),
    rootInitiationId: text(projection.rootInitiationId, 'projection.rootInitiationId'),
    actualCostUsd: number(projection.actualCostUsd, 'projection.actualCostUsd'),
    pendingProjectedCostUsd: number(
      projection.pendingProjectedCostUsd,
      'projection.pendingProjectedCostUsd',
    ),
    projectedTotalCostUsd: number(projection.projectedTotalCostUsd, 'projection.projectedTotalCostUsd'),
    warningThresholdUsd: number(projection.warningThresholdUsd, 'projection.warningThresholdUsd'),
    hardLimitUsd: number(projection.hardLimitUsd, 'projection.hardLimitUsd'),
    remainingToHardLimitUsd: number(
      projection.remainingToHardLimitUsd,
      'projection.remainingToHardLimitUsd',
    ),
    actualAttemptCount: integer(projection.actualAttemptCount, 'projection.actualAttemptCount'),
    unknownCostAttemptCount: integer(
      projection.unknownCostAttemptCount,
      'projection.unknownCostAttemptCount',
    ),
    pendingReservationCount: integer(
      projection.pendingReservationCount,
      'projection.pendingReservationCount',
    ),
    staleReservationCount: integer(
      projection.staleReservationCount,
      'projection.staleReservationCount',
    ),
    settledReservationCount: integer(
      projection.settledReservationCount,
      'projection.settledReservationCount',
    ),
    attributedCompanionCount: integer(
      projection.attributedCompanionCount,
      'projection.attributedCompanionCount',
    ),
    enforcementState: choice(
      projection.enforcementState,
      ENFORCEMENT_STATES,
      'projection.enforcementState',
    ),
  };
}

/** Strict JSON-RPC decoder; rejects malformed or partner-identifying extensions. */
export function parseIcpConversationCostBreakerEvent(
  value: unknown,
): IcpConversationCostBreakerEvent {
  const event = record(value, 'ICP conversation cost breaker event');
  exactKeys(event, EVENT_KEYS, 'ICP conversation cost breaker event');
  const projection = event.projection === undefined ? undefined : parseProjection(event.projection);
  const conversationId = text(event.conversationId, 'event.conversationId');
  const rootInitiationId = text(event.rootInitiationId, 'event.rootInitiationId');
  if (
    projection
    && (
      projection.conversationId !== conversationId
      || projection.rootInitiationId !== rootInitiationId
    )
  ) {
    throw new Error('ICP conversation cost event projection correlation does not match the event');
  }
  const projectedRequestCostUsd = event.projectedRequestCostUsd === undefined
    ? undefined
    : number(event.projectedRequestCostUsd, 'event.projectedRequestCostUsd');
  const slotKey = event.slotKey === undefined ? undefined : text(event.slotKey, 'event.slotKey');
  if (typeof event.replayed !== 'boolean') throw new Error('event.replayed must be boolean');
  return {
    timestampMs: integer(event.timestampMs, 'event.timestampMs'),
    outcome: choice(event.outcome, ['reserved', 'warning', 'blocked'] as const, 'event.outcome'),
    reason: choice(event.reason, DECISION_REASONS, 'event.reason'),
    logicalCallId: text(event.logicalCallId, 'event.logicalCallId'),
    attempt: integer(event.attempt, 'event.attempt'),
    conversationId,
    rootInitiationId,
    localCompanionId: text(event.localCompanionId, 'event.localCompanionId'),
    costPurpose: choice(event.costPurpose, ICP_COST_PURPOSE_VALUES, 'event.costPurpose'),
    costOriginStage: choice(
      event.costOriginStage,
      ['initiation', 'reply', 'post_turn', 'maintenance'] as const,
      'event.costOriginStage',
    ),
    provider: text(event.provider, 'event.provider'),
    model: text(event.model, 'event.model'),
    ...(slotKey ? { slotKey } : {}),
    routingPurpose: text(event.routingPurpose, 'event.routingPurpose'),
    ...(projectedRequestCostUsd !== undefined ? { projectedRequestCostUsd } : {}),
    replayed: event.replayed,
    ...(projection ? { projection } : {}),
  };
}
