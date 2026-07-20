import type { FatigueBudgetEvent } from '../contracts/runtime.js';
import {
  CHARGE_POLICY_RUNTIME_LANE_VALUES,
  type ChargePolicyConfig,
} from '../contracts/charge-policy.js';
import { hasExactKeys, isRecord } from '../utils/types.js';
import type { RunChargeRollingWindowSnapshot } from './run-charge.js';
import type { CompanionId } from '../routing/companion-id.js';

export const FLEET_POSTURE_STALE_TIMEOUT_MS = 90_000;
export const FLEET_POSTURE_EXPIRY_TIMEOUT_MS = FLEET_POSTURE_STALE_TIMEOUT_MS * 2;
const FLEET_POSTURE_MAX_SERIALIZED_BYTES = 512;
const POSTURE_PERCENT_MAX = 100;

export const FLEET_POSTURE_STATE_VALUES = [
  'clear',
  'pressured',
  'exhausted',
] as const;

export type FleetChargePosture = (typeof FLEET_POSTURE_STATE_VALUES)[number];
export type FleetFatiguePosture = FleetChargePosture;

export interface FleetCompanionPostureSummary {
  readonly schemaVersion: 1;
  readonly updatedAt: number;
  readonly charge: Readonly<{
    state: FleetChargePosture;
    utilizationPercent: number;
  }>;
  readonly fatigue: Readonly<{
    state: FleetFatiguePosture;
    utilizationPercent: number;
  }>;
}

export interface BuildFleetCompanionPostureInput {
  readonly companionId: CompanionId;
  readonly chargePolicy: Pick<ChargePolicyConfig, 'runChargeQuotaByLane'>;
  readonly rollingCharge: RunChargeRollingWindowSnapshot;
  readonly fatigueEvents: readonly FatigueBudgetEvent[];
  readonly nowMs: number;
}

function cappedPercent(spent: number, allowance: number): number {
  if (!Number.isFinite(spent) || spent < 0 || !Number.isFinite(allowance) || allowance < 0) {
    throw new Error('Fleet posture requires finite non-negative budget values');
  }
  if (allowance === 0) {
    return spent > 0 ? POSTURE_PERCENT_MAX : 0;
  }
  return Math.min(POSTURE_PERCENT_MAX, Math.max(0, Math.round((spent / allowance) * 100)));
}

function postureFromPercent(percent: number): FleetChargePosture {
  if (percent >= POSTURE_PERCENT_MAX) return 'exhausted';
  if (percent > 0) return 'pressured';
  return 'clear';
}

function buildChargePosture(
  input: Pick<BuildFleetCompanionPostureInput, 'chargePolicy' | 'rollingCharge'>,
): FleetCompanionPostureSummary['charge'] {
  let utilizationPercent = 0;
  for (const lane of CHARGE_POLICY_RUNTIME_LANE_VALUES) {
    utilizationPercent = Math.max(
      utilizationPercent,
      cappedPercent(
        input.rollingCharge.spentByLane[lane] ?? 0,
        input.chargePolicy.runChargeQuotaByLane[lane],
      ),
    );
  }
  return Object.freeze({
    state: postureFromPercent(utilizationPercent),
    utilizationPercent,
  });
}

function fatigueScopeKey(event: FatigueBudgetEvent): string {
  return JSON.stringify([
    event.localCompanionId,
    event.peerContactId,
    event.channelId,
    event.dayKey,
  ]);
}

function fatigueEventSeverity(event: FatigueBudgetEvent): number {
  if (event.hardState === 'exhausted') return 2;
  if (event.softState === 'soft_limit_reached') return 1;
  return 0;
}

function shouldReplaceFatigueScopeEvent(
  current: FatigueBudgetEvent | undefined,
  candidate: FatigueBudgetEvent,
): boolean {
  if (!current || candidate.timestampMs > current.timestampMs) return true;
  if (candidate.timestampMs < current.timestampMs) return false;
  const severityDifference = fatigueEventSeverity(candidate) - fatigueEventSeverity(current);
  if (severityDifference !== 0) return severityDifference > 0;
  return cappedPercent(candidate.spentAfter, candidate.allowance)
    > cappedPercent(current.spentAfter, current.allowance);
}

function buildFatiguePosture(
  input: Pick<BuildFleetCompanionPostureInput, 'companionId' | 'fatigueEvents' | 'nowMs'>,
): FleetCompanionPostureSummary['fatigue'] {
  const dayKey = new Date(input.nowMs).toISOString().slice(0, 10);
  const latestByScope = new Map<string, FatigueBudgetEvent>();
  for (const event of input.fatigueEvents) {
    if (event.localCompanionId !== input.companionId || event.dayKey !== dayKey) continue;
    const key = fatigueScopeKey(event);
    const current = latestByScope.get(key);
    if (shouldReplaceFatigueScopeEvent(current, event)) {
      latestByScope.set(key, event);
    }
  }

  let utilizationPercent = 0;
  let state: FleetFatiguePosture = 'clear';
  for (const event of latestByScope.values()) {
    utilizationPercent = Math.max(
      utilizationPercent,
      cappedPercent(event.spentAfter, event.allowance),
    );
    if (event.hardState === 'exhausted') {
      state = 'exhausted';
    } else if (state === 'clear' && event.softState === 'soft_limit_reached') {
      state = 'pressured';
    }
  }
  return Object.freeze({ state, utilizationPercent });
}

export function buildFleetCompanionPosture(
  input: BuildFleetCompanionPostureInput,
): FleetCompanionPostureSummary {
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) {
    throw new Error('Fleet posture requires a non-negative safe timestamp');
  }
  return Object.freeze({
    schemaVersion: 1,
    updatedAt: input.nowMs,
    charge: buildChargePosture(input),
    fatigue: buildFatiguePosture(input),
  });
}

function parsePercent(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > POSTURE_PERCENT_MAX) {
    throw new Error(`Fleet posture ${label} must be an integer from 0 through 100`);
  }
  return value as number;
}

function serializedByteLength(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    throw new Error('Fleet posture must be JSON serializable');
  }
}

export function parseFleetCompanionPosture(
  value: unknown,
  nowMs = Date.now(),
): FleetCompanionPostureSummary {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error('Fleet posture validator clock is invalid');
  }
  if (!isRecord(value)
    || !hasExactKeys(value, ['schemaVersion', 'updatedAt', 'charge', 'fatigue'])
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.updatedAt)
    || (value.updatedAt as number) < 0
    || (value.updatedAt as number) > nowMs
    || !isRecord(value.charge)
    || !hasExactKeys(value.charge, ['state', 'utilizationPercent'])
    || !FLEET_POSTURE_STATE_VALUES.includes(value.charge.state as FleetChargePosture)
    || !isRecord(value.fatigue)
    || !hasExactKeys(value.fatigue, ['state', 'utilizationPercent'])
    || !FLEET_POSTURE_STATE_VALUES.includes(value.fatigue.state as FleetFatiguePosture)) {
    throw new Error('Fleet posture envelope is invalid or widened');
  }
  if (serializedByteLength(value) > FLEET_POSTURE_MAX_SERIALIZED_BYTES) {
    throw new Error('Fleet posture envelope exceeds its byte bound');
  }
  return Object.freeze({
    schemaVersion: 1,
    updatedAt: value.updatedAt as number,
    charge: Object.freeze({
      state: value.charge.state as FleetChargePosture,
      utilizationPercent: parsePercent(
        value.charge.utilizationPercent,
        'charge.utilizationPercent',
      ),
    }),
    fatigue: Object.freeze({
      state: value.fatigue.state as FleetFatiguePosture,
      utilizationPercent: parsePercent(
        value.fatigue.utilizationPercent,
        'fatigue.utilizationPercent',
      ),
    }),
  });
}
