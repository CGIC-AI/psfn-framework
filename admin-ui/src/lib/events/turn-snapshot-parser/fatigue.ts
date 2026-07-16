import {
  FATIGUE_CONTINUATION_EVIDENCE_VALUES,
  FATIGUE_POLICY_CHANNEL_SETTING_VALUES,
  FATIGUE_POLICY_INTENT_VALUES,
  FATIGUE_POLICY_RELATIONSHIP_VALUES,
  FATIGUE_POLICY_STATE_VALUES,
  FATIGUE_REGULATION_STATE_VALUES,
} from '../../../../../src/shared/contracts/charge-policy.js';
import { assertFatigueEnforcementMetadataInvariants } from '../../../../../src/core/agent/fatigue/enforcement-invariants.js';
import type { AdminTurnSnapshotData } from '../../types';
import {
  optionalString,
  parseArray,
  parseStringArray,
  reject,
  requireBoolean,
  requireExactRecord,
  requireFiniteNumber,
  requireNonEmptyString,
  requireNonNegativeInteger,
  requireString,
} from './primitives';

type FatigueMetadata = NonNullable<AdminTurnSnapshotData['fatigue']>;

function requireOneOf<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  const result = requireString(value, path);
  if (!(allowed as readonly string[]).includes(result)) {
    reject(path, `contains unsupported value ${JSON.stringify(result)}`);
  }
  return result as T;
}

function requireNonNegativeNumber(value: unknown, path: string): number {
  const result = requireFiniteNumber(value, path);
  if (result < 0) reject(path, 'must be non-negative');
  return result;
}

function parseActor(value: unknown, path: string): FatigueMetadata['triggeringAuthor'] {
  const source = requireExactRecord(value, path, [
    'role', 'contactId', 'channelAuthorId', 'displayName', 'isMachineIntelligence',
  ]);
  const contactId = optionalString(source, 'contactId', path);
  const channelAuthorId = optionalString(source, 'channelAuthorId', path);
  const displayName = optionalString(source, 'displayName', path);
  const isMachineIntelligence = source.isMachineIntelligence === undefined
    ? undefined
    : requireBoolean(source.isMachineIntelligence, `${path}.isMachineIntelligence`);
  return {
    role: requireOneOf(source.role, `${path}.role`, [
      'human', 'machine_intelligence', 'system', 'unknown',
    ] as const),
    ...(contactId !== undefined ? { contactId } : {}),
    ...(channelAuthorId !== undefined ? { channelAuthorId } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
    ...(isMachineIntelligence !== undefined ? { isMachineIntelligence } : {}),
  };
}

function parsePeer(value: unknown, path: string): FatigueMetadata['peer'] {
  const source = requireExactRecord(value, path, [
    'contactId', 'displayName', 'channelAuthorId', 'isMachineIntelligence',
  ]);
  const displayName = optionalString(source, 'displayName', path);
  const channelAuthorId = optionalString(source, 'channelAuthorId', path);
  const isMachineIntelligence = source.isMachineIntelligence === undefined
    ? undefined
    : requireBoolean(source.isMachineIntelligence, `${path}.isMachineIntelligence`);
  return {
    contactId: requireNonEmptyString(source.contactId, `${path}.contactId`),
    ...(displayName !== undefined ? { displayName } : {}),
    ...(channelAuthorId !== undefined ? { channelAuthorId } : {}),
    ...(isMachineIntelligence !== undefined ? { isMachineIntelligence } : {}),
  };
}

function parseScope(value: unknown, path: string): FatigueMetadata['scope'] {
  const source = requireExactRecord(value, path, [
    'localCompanionId', 'peerContactId', 'channelId', 'dayKey',
  ]);
  const dayKey = requireNonEmptyString(source.dayKey, `${path}.dayKey`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(dayKey)) reject(`${path}.dayKey`, 'must be YYYY-MM-DD');
  return {
    localCompanionId: requireNonEmptyString(source.localCompanionId, `${path}.localCompanionId`),
    peerContactId: requireNonEmptyString(source.peerContactId, `${path}.peerContactId`),
    channelId: requireNonEmptyString(source.channelId, `${path}.channelId`),
    dayKey,
  };
}

const BUDGET_KEYS = [
  'spentBefore',
  'remainingBefore',
  'allowance',
  'softLimit',
  'hardLimit',
  'amount',
  'spentAfterProjected',
  'remainingAfterProjected',
  'normalSpentBefore',
  'normalSpentAfterProjected',
  'overchargeSpentBefore',
  'overchargeSpentAfterProjected',
  'overchargeAllowance',
  'overchargeRemainingBefore',
  'overchargeRemainingAfterProjected',
] as const;

function parseBudget(value: unknown, path: string): FatigueMetadata['budget'] {
  const source = requireExactRecord(value, path, BUDGET_KEYS);
  return {
    spentBefore: requireNonNegativeInteger(source.spentBefore, `${path}.spentBefore`),
    remainingBefore: requireNonNegativeInteger(source.remainingBefore, `${path}.remainingBefore`),
    allowance: requireNonNegativeInteger(source.allowance, `${path}.allowance`),
    softLimit: requireNonNegativeInteger(source.softLimit, `${path}.softLimit`),
    hardLimit: requireNonNegativeInteger(source.hardLimit, `${path}.hardLimit`),
    amount: requireNonNegativeInteger(source.amount, `${path}.amount`),
    spentAfterProjected: requireNonNegativeInteger(
      source.spentAfterProjected,
      `${path}.spentAfterProjected`,
    ),
    remainingAfterProjected: requireNonNegativeInteger(
      source.remainingAfterProjected,
      `${path}.remainingAfterProjected`,
    ),
    normalSpentBefore: requireNonNegativeInteger(
      source.normalSpentBefore,
      `${path}.normalSpentBefore`,
    ),
    normalSpentAfterProjected: requireNonNegativeInteger(
      source.normalSpentAfterProjected,
      `${path}.normalSpentAfterProjected`,
    ),
    overchargeSpentBefore: requireNonNegativeInteger(
      source.overchargeSpentBefore,
      `${path}.overchargeSpentBefore`,
    ),
    overchargeSpentAfterProjected: requireNonNegativeInteger(
      source.overchargeSpentAfterProjected,
      `${path}.overchargeSpentAfterProjected`,
    ),
    overchargeAllowance: requireNonNegativeInteger(
      source.overchargeAllowance,
      `${path}.overchargeAllowance`,
    ),
    overchargeRemainingBefore: requireNonNegativeInteger(
      source.overchargeRemainingBefore,
      `${path}.overchargeRemainingBefore`,
    ),
    overchargeRemainingAfterProjected: requireNonNegativeInteger(
      source.overchargeRemainingAfterProjected,
      `${path}.overchargeRemainingAfterProjected`,
    ),
  };
}

function parseSocialRegulation(
  value: unknown,
  path: string,
): FatigueMetadata['socialRegulation'] {
  const source = requireExactRecord(value, path, [
    'state',
    'chargeLane',
    'relationshipPressure',
    'rootNormalSpent',
    'rootOverchargeSpent',
    'contributingEventCount',
    'marginalChargeUnits',
    'closeoutReserveRemainingBefore',
    'closeoutReserveRemainingAfterProjected',
    'continuationEvidence',
    'rootInitiationId',
  ]);
  const rootInitiationId = optionalString(source, 'rootInitiationId', path);
  return {
    state: requireOneOf(source.state, `${path}.state`, FATIGUE_REGULATION_STATE_VALUES),
    chargeLane: requireOneOf(
      source.chargeLane,
      `${path}.chargeLane`,
      ['interactive', 'companion_social'] as const,
    ),
    relationshipPressure: requireNonNegativeNumber(
      source.relationshipPressure,
      `${path}.relationshipPressure`,
    ),
    rootNormalSpent: requireNonNegativeInteger(source.rootNormalSpent, `${path}.rootNormalSpent`),
    rootOverchargeSpent: requireNonNegativeInteger(
      source.rootOverchargeSpent,
      `${path}.rootOverchargeSpent`,
    ),
    contributingEventCount: requireNonNegativeInteger(
      source.contributingEventCount,
      `${path}.contributingEventCount`,
    ),
    marginalChargeUnits: requireNonNegativeInteger(
      source.marginalChargeUnits,
      `${path}.marginalChargeUnits`,
    ),
    closeoutReserveRemainingBefore: requireNonNegativeInteger(
      source.closeoutReserveRemainingBefore,
      `${path}.closeoutReserveRemainingBefore`,
    ),
    closeoutReserveRemainingAfterProjected: requireNonNegativeInteger(
      source.closeoutReserveRemainingAfterProjected,
      `${path}.closeoutReserveRemainingAfterProjected`,
    ),
    continuationEvidence: parseArray(
      source.continuationEvidence,
      `${path}.continuationEvidence`,
      (item, itemPath) => requireOneOf(item, itemPath, FATIGUE_CONTINUATION_EVIDENCE_VALUES),
    ),
    ...(rootInitiationId !== undefined ? { rootInitiationId } : {}),
  };
}

function parseRecordedEvent(
  value: unknown,
  path: string,
): NonNullable<FatigueMetadata['recordedEvent']> {
  const source = requireExactRecord(value, path, [
    'timestampMs',
    'amount',
    'decision',
    'reason',
    'spentAfter',
    'remainingAllowance',
    'normalSpentAfter',
    'overchargeSpentAfter',
    'overchargeAllowance',
    'remainingOvercharge',
    'softState',
    'hardState',
  ]);
  const normalSpentAfter = source.normalSpentAfter === undefined
    ? undefined
    : requireNonNegativeInteger(source.normalSpentAfter, `${path}.normalSpentAfter`);
  const overchargeSpentAfter = source.overchargeSpentAfter === undefined
    ? undefined
    : requireNonNegativeInteger(source.overchargeSpentAfter, `${path}.overchargeSpentAfter`);
  const overchargeAllowance = source.overchargeAllowance === undefined
    ? undefined
    : requireNonNegativeInteger(source.overchargeAllowance, `${path}.overchargeAllowance`);
  const remainingOvercharge = source.remainingOvercharge === undefined
    ? undefined
    : requireNonNegativeInteger(source.remainingOvercharge, `${path}.remainingOvercharge`);
  return {
    timestampMs: requireNonNegativeInteger(source.timestampMs, `${path}.timestampMs`),
    amount: requireNonNegativeInteger(source.amount, `${path}.amount`),
    decision: requireOneOf(source.decision, `${path}.decision`, [
      'charged', 'free', 'overcharge',
    ] as const),
    reason: requireOneOf(source.reason, `${path}.reason`, [
      'machine_intelligence_response',
      'overcharge_recent_human_participation',
      'overcharge_work_intent_wrapup',
      'overcharge_explicit_peer_invitation',
      'peer_not_machine_intelligence',
      'triggering_author_not_machine_intelligence',
    ] as const),
    spentAfter: requireNonNegativeInteger(source.spentAfter, `${path}.spentAfter`),
    remainingAllowance: requireNonNegativeInteger(
      source.remainingAllowance,
      `${path}.remainingAllowance`,
    ),
    ...(normalSpentAfter !== undefined ? { normalSpentAfter } : {}),
    ...(overchargeSpentAfter !== undefined ? { overchargeSpentAfter } : {}),
    ...(overchargeAllowance !== undefined ? { overchargeAllowance } : {}),
    ...(remainingOvercharge !== undefined ? { remainingOvercharge } : {}),
    softState: requireOneOf(source.softState, `${path}.softState`, [
      'clear', 'soft_limit_reached',
    ] as const),
    hardState: requireOneOf(source.hardState, `${path}.hardState`, [
      'available', 'exhausted',
    ] as const),
  };
}

export function parseFatigue(value: unknown, path: string): FatigueMetadata {
  const source = requireExactRecord(value, path, [
    'schemaVersion',
    'decision',
    'modelDisposition',
    'alertInjected',
    'shouldRecordSpend',
    'spendDecision',
    'spendReason',
    'policyState',
    'policyBaseState',
    'intent',
    'relationshipClass',
    'channelSetting',
    'overchargeEligible',
    'overchargePermitted',
    'overchargeBlockedReasons',
    'overchargeReasons',
    'scope',
    'peer',
    'triggeringAuthor',
    'budget',
    'socialRegulation',
    'recordedEvent',
  ]);
  if (source.schemaVersion !== 1) reject(`${path}.schemaVersion`, 'must equal 1');
  const recordedEvent = source.recordedEvent === undefined
    ? undefined
    : parseRecordedEvent(source.recordedEvent, `${path}.recordedEvent`);
  const result: FatigueMetadata = {
    schemaVersion: 1,
    decision: requireOneOf(source.decision, `${path}.decision`, [
      'allowed_free',
      'allowed_charged',
      'wrap_up_charged',
      'overcharge_charged',
      'suppressed_hard_exhausted',
    ] as const),
    modelDisposition: requireOneOf(source.modelDisposition, `${path}.modelDisposition`, [
      'allowed', 'suppressed',
    ] as const),
    alertInjected: requireBoolean(source.alertInjected, `${path}.alertInjected`),
    shouldRecordSpend: requireBoolean(source.shouldRecordSpend, `${path}.shouldRecordSpend`),
    spendDecision: requireOneOf(source.spendDecision, `${path}.spendDecision`, [
      'charged', 'free', 'overcharge',
    ] as const),
    spendReason: requireOneOf(source.spendReason, `${path}.spendReason`, [
      'machine_intelligence_response',
      'overcharge_recent_human_participation',
      'overcharge_work_intent_wrapup',
      'overcharge_explicit_peer_invitation',
      'peer_not_machine_intelligence',
      'triggering_author_not_machine_intelligence',
    ] as const),
    policyState: requireOneOf(source.policyState, `${path}.policyState`, FATIGUE_POLICY_STATE_VALUES),
    policyBaseState: requireOneOf(source.policyBaseState, `${path}.policyBaseState`, [
      'normal', 'nearing_limit', 'soft_exhausted', 'wrap_up_allowed', 'hard_exhausted',
    ] as const),
    intent: requireOneOf(source.intent, `${path}.intent`, FATIGUE_POLICY_INTENT_VALUES),
    relationshipClass: requireOneOf(
      source.relationshipClass,
      `${path}.relationshipClass`,
      FATIGUE_POLICY_RELATIONSHIP_VALUES,
    ),
    channelSetting: requireOneOf(
      source.channelSetting,
      `${path}.channelSetting`,
      FATIGUE_POLICY_CHANNEL_SETTING_VALUES,
    ),
    overchargeEligible: requireBoolean(source.overchargeEligible, `${path}.overchargeEligible`),
    overchargePermitted: requireBoolean(source.overchargePermitted, `${path}.overchargePermitted`),
    overchargeBlockedReasons: parseStringArray(
      source.overchargeBlockedReasons,
      `${path}.overchargeBlockedReasons`,
    ),
    overchargeReasons: parseStringArray(source.overchargeReasons, `${path}.overchargeReasons`),
    scope: parseScope(source.scope, `${path}.scope`),
    peer: parsePeer(source.peer, `${path}.peer`),
    triggeringAuthor: parseActor(source.triggeringAuthor, `${path}.triggeringAuthor`),
    budget: parseBudget(source.budget, `${path}.budget`),
    socialRegulation: parseSocialRegulation(
      source.socialRegulation,
      `${path}.socialRegulation`,
    ),
    ...(recordedEvent !== undefined ? { recordedEvent } : {}),
  };
  assertFatigueEnforcementMetadataInvariants(result);
  return result;
}
