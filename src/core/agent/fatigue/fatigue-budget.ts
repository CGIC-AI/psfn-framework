import type {
  CorrelationMetadata,
  FatigueBudgetActorSnapshot,
  FatigueBudgetDecision,
  FatigueBudgetEvent,
  FatigueBudgetHardState,
  FatigueBudgetPeerSnapshot,
  FatigueBudgetReason,
  FatigueBudgetSoftState,
  RunChargeLineage,
} from '../../../shared/contracts/runtime.js';

export interface FatigueBudgetScope {
  localCompanionId: string;
  peerContactId: string;
  channelId: string;
  dayKey: string;
}

export interface FatigueBudgetLimits {
  softLimit: number;
  hardLimit: number;
}

export interface FatigueBudgetState {
  scope: FatigueBudgetScope;
  spent: number;
  remainingAllowance: number;
  allowance: number;
  softLimit: number;
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
  if (softLimit > hardLimit) {
    throw new Error('Fatigue budget softLimit must be less than or equal to hardLimit');
  }
  return { softLimit, hardLimit };
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
  spent: number;
  limits: FatigueBudgetLimits;
  lastEvent?: FatigueBudgetEvent;
}): FatigueBudgetState {
  const allowance = input.limits.hardLimit;
  const softState: FatigueBudgetSoftState = input.spent >= input.limits.softLimit
    ? 'soft_limit_reached'
    : 'clear';
  const hardState: FatigueBudgetHardState = input.spent >= allowance
    ? 'exhausted'
    : 'available';
  return {
    scope: { ...input.scope },
    spent: input.spent,
    remainingAllowance: Math.max(0, allowance - input.spent),
    allowance,
    softLimit: input.limits.softLimit,
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
    const spent = events.reduce((total, event) => total + event.amount, 0);
    const lastEvent = events
      .sort((left, right) => right.timestampMs - left.timestampMs)[0];
    return createState({ scope, spent, limits, lastEvent });
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
      spent: stateBefore.spent + decision.amount,
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
    const currentState = this.readState({
      localCompanionId: evaluation.scope.localCompanionId,
      peerContactId: evaluation.scope.peerContactId,
      channelId: evaluation.scope.channelId,
      dayKey: evaluation.scope.dayKey,
      limits: {
        softLimit: evaluation.stateAfter.softLimit,
        hardLimit: evaluation.stateAfter.allowance,
      },
    });
    const recordedStateAfter = createState({
      scope: cloneScope(currentState.scope),
      spent: currentState.spent + evaluation.amount,
      limits: {
        softLimit: evaluation.stateAfter.softLimit,
        hardLimit: evaluation.stateAfter.allowance,
      },
      lastEvent: currentState.lastEvent,
    });
    const correlation = {
      ...(evaluation.correlation ?? {}),
      ...(input.correlation ?? {}),
    };
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
      softState: recordedStateAfter.softState,
      hardState: recordedStateAfter.hardState,
      ...(Object.keys(correlation).length > 0 ? correlation : {}),
      ...(lineage ? { lineage: { ...lineage } } : {}),
      ...(Object.keys(details).length > 0 ? { details } : {}),
    };
    this.history.recordFatigueEvent(event);
    return cloneEvent(event);
  }
}
