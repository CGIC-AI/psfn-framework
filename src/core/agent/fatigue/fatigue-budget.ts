import type {
  CorrelationMetadata,
  FatigueBudgetActorSnapshot,
  FatigueBudgetDecision,
  FatigueBudgetEvent,
  FatigueBudgetHardState,
  FatigueBudgetPeerSnapshot,
  FatiguePendingSpendMetadata,
  FatigueBudgetReason,
  FatigueBudgetSoftState,
  RunChargeLineage,
} from '../../../shared/contracts/runtime.js';
import { isRecord } from '../../../shared/utils/types.js';

const FATIGUE_DECISIONS = new Set(['charged', 'free', 'overcharge']);
const FATIGUE_REASONS = new Set([
  'machine_intelligence_response',
  'overcharge_recent_human_participation',
  'overcharge_work_intent_wrapup',
  'peer_not_machine_intelligence',
  'triggering_author_not_machine_intelligence',
]);
const FATIGUE_ACTOR_ROLES = new Set(['human', 'machine_intelligence', 'system', 'unknown']);
const FATIGUE_DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export interface FatigueBudgetScope {
  localCompanionId: string;
  peerContactId: string;
  channelId: string;
  dayKey: string;
}

export interface FatigueBudgetLimits {
  softLimit: number;
  hardLimit: number;
  overchargeLimit?: number;
}

export interface FatigueBudgetState {
  scope: FatigueBudgetScope;
  spent: number;
  normalSpent: number;
  overchargeSpent: number;
  remainingAllowance: number;
  allowance: number;
  softLimit: number;
  overchargeAllowance: number;
  remainingOvercharge: number;
  softState: FatigueBudgetSoftState;
  hardState: FatigueBudgetHardState;
  lastEvent?: FatigueBudgetEvent;
}

export interface FatigueBudgetEvaluationInput {
  localCompanionId: string;
  channelId: string;
  peer: FatigueBudgetPeerSnapshot;
  triggeringAuthor: FatigueBudgetActorSnapshot;
  limits: FatigueBudgetLimits;
  timestampMs?: number;
  correlation?: Partial<CorrelationMetadata>;
  lineage?: RunChargeLineage;
  details?: Record<string, unknown>;
}

export interface FatigueBudgetRecordInput {
  correlation?: Partial<CorrelationMetadata>;
  details?: Record<string, unknown>;
  lineage?: RunChargeLineage;
}

export interface FatigueBudgetEvaluation {
  scope: FatigueBudgetScope;
  timestampMs: number;
  dayKey: string;
  decision: FatigueBudgetDecision;
  reason: FatigueBudgetReason;
  amount: number;
  stateBefore: FatigueBudgetState;
  stateAfter: FatigueBudgetState;
  triggeringAuthor: FatigueBudgetActorSnapshot;
  peer: FatigueBudgetPeerSnapshot;
  correlation?: Partial<CorrelationMetadata>;
  lineage?: RunChargeLineage;
  details?: Record<string, unknown>;
}

export interface FatigueBudgetEventQuery {
  localCompanionId?: string;
  peerContactId?: string;
  channelId?: string;
  dayKey?: string;
  decision?: FatigueBudgetDecision;
  limit?: number;
}

export interface FatigueBudgetHistoryPort {
  listFatigueEvents(query?: FatigueBudgetEventQuery): FatigueBudgetEvent[];
  recordFatigueEvent(event: FatigueBudgetEvent): unknown;
}

export interface FatigueBudgetPort {
  readState(scope: Omit<FatigueBudgetScope, 'dayKey'> & {
    dayKey?: string;
    limits: FatigueBudgetLimits;
  }): FatigueBudgetState;
  evaluate(input: FatigueBudgetEvaluationInput): FatigueBudgetEvaluation;
  recordFinalDecision(
    evaluation: FatigueBudgetEvaluation,
    input?: FatigueBudgetRecordInput,
  ): FatigueBudgetEvent;
  recordPendingSpend(
    pending: FatiguePendingSpendMetadata,
    input?: FatigueBudgetRecordInput,
  ): FatigueBudgetEvent;
}

export function makeFatigueDayKey(timestampMs: number): string {
  if (!Number.isFinite(timestampMs)) {
    throw new Error('Fatigue day key requires a finite timestamp');
  }
  return new Date(timestampMs).toISOString().slice(0, 10);
}

export function makeFatigueScopeKey(scope: FatigueBudgetScope): string {
  return JSON.stringify([
    scope.localCompanionId,
    scope.peerContactId,
    scope.channelId,
    scope.dayKey,
  ]);
}

function normalizeRequiredString(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Fatigue budget ${label} is required`);
  }
  return trimmed;
}

function normalizeLimit(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Fatigue budget ${label} must be a non-negative number`);
  }
  return Math.trunc(value);
}

function normalizeLimits(limits: FatigueBudgetLimits): FatigueBudgetLimits {
  const softLimit = normalizeLimit(limits.softLimit, 'softLimit');
  const hardLimit = normalizeLimit(limits.hardLimit, 'hardLimit');
  const overchargeLimit = normalizeLimit(limits.overchargeLimit ?? 0, 'overchargeLimit');
  if (softLimit > hardLimit) {
    throw new Error('Fatigue budget softLimit must be less than or equal to hardLimit');
  }
  return { softLimit, hardLimit, overchargeLimit };
}

function cloneActor(actor: FatigueBudgetActorSnapshot): FatigueBudgetActorSnapshot {
  return {
    role: actor.role,
    ...(actor.contactId?.trim() ? { contactId: actor.contactId.trim() } : {}),
    ...(actor.channelAuthorId?.trim() ? { channelAuthorId: actor.channelAuthorId.trim() } : {}),
    ...(actor.displayName?.trim() ? { displayName: actor.displayName.trim() } : {}),
    ...(actor.isMachineIntelligence === true ? { isMachineIntelligence: true } : {}),
  };
}

function clonePeer(peer: FatigueBudgetPeerSnapshot): FatigueBudgetPeerSnapshot {
  return {
    contactId: normalizeRequiredString(peer.contactId, 'peerContactId'),
    ...(peer.channelAuthorId?.trim() ? { channelAuthorId: peer.channelAuthorId.trim() } : {}),
    ...(peer.displayName?.trim() ? { displayName: peer.displayName.trim() } : {}),
    ...(peer.isMachineIntelligence === true ? { isMachineIntelligence: true } : {}),
  };
}

function cloneEvent(event: FatigueBudgetEvent): FatigueBudgetEvent {
  return {
    ...event,
    triggeringAuthor: { ...event.triggeringAuthor },
    peer: { ...event.peer },
    ...(event.lineage ? { lineage: { ...event.lineage } } : {}),
    ...(event.details ? { details: { ...event.details } } : {}),
  };
}

function createState(input: {
  scope: FatigueBudgetScope;
  normalSpent: number;
  overchargeSpent?: number;
  limits: FatigueBudgetLimits;
  lastEvent?: FatigueBudgetEvent;
}): FatigueBudgetState {
  const allowance = input.limits.hardLimit;
  const overchargeAllowance = input.limits.overchargeLimit ?? 0;
  const overchargeSpent = input.overchargeSpent ?? 0;
  const spent = input.normalSpent + overchargeSpent;
  const softState: FatigueBudgetSoftState = input.normalSpent >= input.limits.softLimit
    ? 'soft_limit_reached'
    : 'clear';
  const hardState: FatigueBudgetHardState = input.normalSpent >= allowance
    ? 'exhausted'
    : 'available';
  return {
    scope: { ...input.scope },
    spent,
    normalSpent: input.normalSpent,
    overchargeSpent,
    remainingAllowance: Math.max(0, allowance - input.normalSpent),
    allowance,
    softLimit: input.limits.softLimit,
    overchargeAllowance,
    remainingOvercharge: Math.max(0, overchargeAllowance - overchargeSpent),
    softState,
    hardState,
    ...(input.lastEvent ? { lastEvent: cloneEvent(input.lastEvent) } : {}),
  };
}

function resolveDecision(input: {
  peer: FatigueBudgetPeerSnapshot;
  triggeringAuthor: FatigueBudgetActorSnapshot;
}): { decision: FatigueBudgetDecision; reason: FatigueBudgetReason; amount: number } {
  if (input.peer.isMachineIntelligence !== true) {
    return { decision: 'free', reason: 'peer_not_machine_intelligence', amount: 0 };
  }
  if (input.triggeringAuthor.isMachineIntelligence !== true) {
    return { decision: 'free', reason: 'triggering_author_not_machine_intelligence', amount: 0 };
  }
  return { decision: 'charged', reason: 'machine_intelligence_response', amount: 1 };
}

function cloneScope(scope: FatigueBudgetScope): FatigueBudgetScope {
  return { ...scope };
}

function sanitizeCorrelationMetadata(
  correlation: Partial<CorrelationMetadata>,
): Partial<CorrelationMetadata> {
  const safeCorrelation = { ...correlation };
  delete safeCorrelation.channelId;
  return safeCorrelation;
}

function assertOptionalString(value: unknown, label: string): void {
  if (value !== undefined && (typeof value !== 'string' || !value.trim())) {
    throw new Error(`Pending fatigue spend ${label} must be a non-empty string`);
  }
}

function assertRequiredString(value: unknown, label: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Pending fatigue spend ${label} must be a non-empty string`);
  }
}

function assertActorSnapshot(value: unknown, label: string): void {
  if (!isRecord(value)
    || typeof value.role !== 'string'
    || !FATIGUE_ACTOR_ROLES.has(value.role)
    || (value.isMachineIntelligence !== undefined
      && typeof value.isMachineIntelligence !== 'boolean')) {
    throw new Error(`Pending fatigue spend ${label} is malformed`);
  }
  assertOptionalString(value.contactId, `${label}.contactId`);
  assertOptionalString(value.channelAuthorId, `${label}.channelAuthorId`);
  assertOptionalString(value.displayName, `${label}.displayName`);
}

function assertPendingSpend(pending: FatiguePendingSpendMetadata): void {
  const value: unknown = pending;
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.timestampMs !== 'number'
    || !Number.isFinite(value.timestampMs)
    || value.timestampMs < 0
    || typeof value.amount !== 'number'
    || !Number.isFinite(value.amount)
    || value.amount < 0
    || typeof value.decision !== 'string'
    || !FATIGUE_DECISIONS.has(value.decision)
    || typeof value.reason !== 'string'
    || !FATIGUE_REASONS.has(value.reason)
    || !isRecord(value.scope)
    || !isRecord(value.peer)
    || !isRecord(value.limits)
    || !isRecord(value.correlation)
    || typeof value.limits.softLimit !== 'number'
    || typeof value.limits.hardLimit !== 'number'
    || typeof value.limits.overchargeLimit !== 'number') {
    throw new Error('Pending fatigue spend is malformed');
  }
  for (const [key, label] of [
    ['localCompanionId', 'scope.localCompanionId'],
    ['peerContactId', 'scope.peerContactId'],
    ['channelId', 'scope.channelId'],
    ['dayKey', 'scope.dayKey'],
  ] as const) {
    assertRequiredString(value.scope[key], label);
  }
  if (typeof value.scope.dayKey !== 'string'
    || !FATIGUE_DAY_KEY_PATTERN.test(value.scope.dayKey)
    || value.scope.dayKey !== makeFatigueDayKey(value.timestampMs)) {
    throw new Error('Pending fatigue spend scope.dayKey does not match timestampMs');
  }
  if (typeof value.peer.contactId !== 'string'
    || value.peer.contactId !== value.scope.peerContactId) {
    throw new Error('Pending fatigue spend peer does not match its scope');
  }
  assertOptionalString(value.peer.channelAuthorId, 'peer.channelAuthorId');
  assertOptionalString(value.peer.displayName, 'peer.displayName');
  if (value.peer.isMachineIntelligence !== undefined
    && typeof value.peer.isMachineIntelligence !== 'boolean') {
    throw new Error('Pending fatigue spend peer.isMachineIntelligence must be boolean');
  }
  assertActorSnapshot(value.triggeringAuthor, 'triggeringAuthor');
  normalizeLimits({
    softLimit: value.limits.softLimit,
    hardLimit: value.limits.hardLimit,
    overchargeLimit: value.limits.overchargeLimit,
  });
  if (typeof value.correlation.turnId !== 'string' || !value.correlation.turnId.trim()) {
    throw new Error('Pending fatigue spend requires a stable correlation.turnId');
  }
  if (value.correlation.channelId !== undefined
    && value.correlation.channelId !== value.scope.channelId) {
    throw new Error('Pending fatigue spend correlation channel does not match its scope');
  }
  if ((value.decision === 'free' && value.amount !== 0)
    || (value.decision !== 'free' && value.amount <= 0)) {
    throw new Error('Pending fatigue spend amount does not match its decision');
  }
  const validDecisionReason = (value.decision === 'charged'
      && value.reason === 'machine_intelligence_response')
    || (value.decision === 'overcharge'
      && (value.reason === 'overcharge_recent_human_participation'
        || value.reason === 'overcharge_work_intent_wrapup'))
    || (value.decision === 'free'
      && (value.reason === 'peer_not_machine_intelligence'
        || value.reason === 'triggering_author_not_machine_intelligence'));
  if (!validDecisionReason) {
    throw new Error('Pending fatigue spend reason does not match its decision');
  }
}

export class DeterministicFatigueBudgetPort implements FatigueBudgetPort {
  constructor(
    private readonly history: FatigueBudgetHistoryPort,
    private readonly options: { now?: () => number } = {},
  ) {}

  readState(input: Omit<FatigueBudgetScope, 'dayKey'> & {
    dayKey?: string;
    limits: FatigueBudgetLimits;
  }): FatigueBudgetState {
    const limits = normalizeLimits(input.limits);
    const scope = {
      localCompanionId: normalizeRequiredString(input.localCompanionId, 'localCompanionId'),
      peerContactId: normalizeRequiredString(input.peerContactId, 'peerContactId'),
      channelId: normalizeRequiredString(input.channelId, 'channelId'),
      dayKey: input.dayKey?.trim() || makeFatigueDayKey(this.options.now?.() ?? Date.now()),
    };
    const events = this.history.listFatigueEvents({
      localCompanionId: scope.localCompanionId,
      peerContactId: scope.peerContactId,
      channelId: scope.channelId,
      dayKey: scope.dayKey,
    });
    const normalSpent = events
      .filter(event => event.decision === 'charged')
      .reduce((total, event) => total + event.amount, 0);
    const overchargeSpent = events
      .filter(event => event.decision === 'overcharge')
      .reduce((total, event) => total + event.amount, 0);
    const lastEvent = events
      .sort((left, right) => right.timestampMs - left.timestampMs)[0];
    return createState({ scope, normalSpent, overchargeSpent, limits, lastEvent });
  }

  evaluate(input: FatigueBudgetEvaluationInput): FatigueBudgetEvaluation {
    const timestampMs = input.timestampMs ?? this.options.now?.() ?? Date.now();
    const peer = clonePeer(input.peer);
    const triggeringAuthor = cloneActor(input.triggeringAuthor);
    const dayKey = makeFatigueDayKey(timestampMs);
    const limits = normalizeLimits(input.limits);
    const stateBefore = this.readState({
      localCompanionId: input.localCompanionId,
      peerContactId: peer.contactId,
      channelId: input.channelId,
      dayKey,
      limits,
    });
    const decision = resolveDecision({ peer, triggeringAuthor });
    const stateAfter = createState({
      scope: cloneScope(stateBefore.scope),
      normalSpent: stateBefore.normalSpent + decision.amount,
      overchargeSpent: stateBefore.overchargeSpent,
      limits,
      lastEvent: stateBefore.lastEvent,
    });

    return {
      scope: cloneScope(stateBefore.scope),
      timestampMs,
      dayKey,
      decision: decision.decision,
      reason: decision.reason,
      amount: decision.amount,
      stateBefore,
      stateAfter,
      triggeringAuthor,
      peer,
      ...(input.correlation ? { correlation: { ...input.correlation } } : {}),
      ...(input.lineage ? { lineage: { ...input.lineage } } : {}),
      ...(input.details ? { details: { ...input.details } } : {}),
    };
  }

  recordFinalDecision(
    evaluation: FatigueBudgetEvaluation,
    input: FatigueBudgetRecordInput = {},
  ): FatigueBudgetEvent {
    const correlation = sanitizeCorrelationMetadata({
      ...(evaluation.correlation ?? {}),
      ...(input.correlation ?? {}),
    });
    const existing = correlation.turnId
      ? this.history.listFatigueEvents({
          localCompanionId: evaluation.scope.localCompanionId,
          peerContactId: evaluation.scope.peerContactId,
          channelId: evaluation.scope.channelId,
          dayKey: evaluation.scope.dayKey,
        }).find(event => event.turnId === correlation.turnId)
      : undefined;
    if (existing) {
      if (existing.decision !== evaluation.decision
        || existing.reason !== evaluation.reason
        || existing.amount !== evaluation.amount) {
        throw new Error(`Fatigue spend replay mismatch for turn ${correlation.turnId}`);
      }
      return cloneEvent(existing);
    }
    const currentState = this.readState({
      localCompanionId: evaluation.scope.localCompanionId,
      peerContactId: evaluation.scope.peerContactId,
      channelId: evaluation.scope.channelId,
      dayKey: evaluation.scope.dayKey,
      limits: {
        softLimit: evaluation.stateAfter.softLimit,
        hardLimit: evaluation.stateAfter.allowance,
        overchargeLimit: evaluation.stateAfter.overchargeAllowance,
      },
    });
    const recordedStateAfter = createState({
      scope: cloneScope(currentState.scope),
      normalSpent: currentState.normalSpent + (evaluation.decision === 'charged' ? evaluation.amount : 0),
      overchargeSpent: currentState.overchargeSpent + (evaluation.decision === 'overcharge' ? evaluation.amount : 0),
      limits: {
        softLimit: evaluation.stateAfter.softLimit,
        hardLimit: evaluation.stateAfter.allowance,
        overchargeLimit: evaluation.stateAfter.overchargeAllowance,
      },
      lastEvent: currentState.lastEvent,
    });
    const details = {
      ...(evaluation.details ?? {}),
      ...(input.details ?? {}),
    };
    const lineage = input.lineage ?? evaluation.lineage;
    const event: FatigueBudgetEvent = {
      timestampMs: evaluation.timestampMs,
      dayKey: evaluation.dayKey,
      localCompanionId: evaluation.scope.localCompanionId,
      peerContactId: evaluation.scope.peerContactId,
      channelId: evaluation.scope.channelId,
      triggeringAuthor: { ...evaluation.triggeringAuthor },
      peer: { ...evaluation.peer },
      amount: evaluation.amount,
      decision: evaluation.decision,
      reason: evaluation.reason,
      spentAfter: recordedStateAfter.spent,
      remainingAllowance: recordedStateAfter.remainingAllowance,
      allowance: recordedStateAfter.allowance,
      softLimit: recordedStateAfter.softLimit,
      normalSpentAfter: recordedStateAfter.normalSpent,
      overchargeSpentAfter: recordedStateAfter.overchargeSpent,
      overchargeAllowance: recordedStateAfter.overchargeAllowance,
      remainingOvercharge: recordedStateAfter.remainingOvercharge,
      softState: recordedStateAfter.softState,
      hardState: recordedStateAfter.hardState,
      ...(Object.keys(correlation).length > 0 ? correlation : {}),
      ...(lineage ? { lineage: { ...lineage } } : {}),
      ...(Object.keys(details).length > 0 ? { details } : {}),
    };
    this.history.recordFatigueEvent(event);
    return cloneEvent(event);
  }

  recordPendingSpend(
    pending: FatiguePendingSpendMetadata,
    input: FatigueBudgetRecordInput = {},
  ): FatigueBudgetEvent {
    assertPendingSpend(pending);
    const stateBefore = this.readState({
      ...pending.scope,
      limits: pending.limits,
    });
    const stateAfter = createState({
      scope: cloneScope(stateBefore.scope),
      normalSpent: stateBefore.normalSpent + (pending.decision === 'charged' ? pending.amount : 0),
      overchargeSpent: stateBefore.overchargeSpent + (pending.decision === 'overcharge' ? pending.amount : 0),
      limits: pending.limits,
      lastEvent: stateBefore.lastEvent,
    });
    return this.recordFinalDecision({
      scope: cloneScope(pending.scope),
      timestampMs: pending.timestampMs,
      dayKey: pending.scope.dayKey,
      decision: pending.decision,
      reason: pending.reason,
      amount: pending.amount,
      stateBefore,
      stateAfter,
      triggeringAuthor: { ...pending.triggeringAuthor },
      peer: { ...pending.peer },
      correlation: { ...pending.correlation },
    }, input);
  }
}

export function createOverchargeFatigueEvaluation(
  evaluation: FatigueBudgetEvaluation,
  reason: Extract<FatigueBudgetReason, 'overcharge_recent_human_participation' | 'overcharge_work_intent_wrapup'>,
): FatigueBudgetEvaluation {
  const amount = evaluation.amount > 0 ? evaluation.amount : 0;
  return {
    ...evaluation,
    decision: 'overcharge',
    reason,
    stateBefore: {
      ...evaluation.stateBefore,
      scope: { ...evaluation.stateBefore.scope },
      ...(evaluation.stateBefore.lastEvent ? { lastEvent: cloneEvent(evaluation.stateBefore.lastEvent) } : {}),
    },
    stateAfter: createState({
      scope: cloneScope(evaluation.stateBefore.scope),
      normalSpent: evaluation.stateBefore.normalSpent,
      overchargeSpent: evaluation.stateBefore.overchargeSpent + amount,
      limits: {
        softLimit: evaluation.stateBefore.softLimit,
        hardLimit: evaluation.stateBefore.allowance,
        overchargeLimit: evaluation.stateBefore.overchargeAllowance,
      },
      lastEvent: evaluation.stateBefore.lastEvent,
    }),
    ...(evaluation.details ? {
      details: {
        ...evaluation.details,
        overchargeReason: reason,
        overchargePermitted: true,
      },
    } : {
      details: {
        overchargeReason: reason,
        overchargePermitted: true,
      },
    }),
  };
}
