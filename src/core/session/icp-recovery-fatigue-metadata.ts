import {
  FATIGUE_POLICY_CHANNEL_SETTING_VALUES,
  FATIGUE_POLICY_INTENT_VALUES,
  FATIGUE_POLICY_RELATIONSHIP_VALUES,
  FATIGUE_POLICY_STATE_VALUES,
  FATIGUE_CONTINUATION_EVIDENCE_VALUES,
  FATIGUE_REGULATION_STATE_VALUES,
} from '../../shared/contracts/charge-policy.js';
import { parseIcpConversationCorrelation } from '../../shared/contracts/icp-autonomy.js';
import type {
  CorrelationMetadata,
  FatigueBudgetActorSnapshot,
  FatigueBudgetPeerSnapshot,
  FatigueBudgetScopeSnapshot,
  FatigueEnforcementBudgetMetadata,
  FatigueEnforcementMetadata,
  FatiguePendingSpendMetadata,
  FatigueRecordedEventMetadata,
  FatigueSocialRegulationMetadata,
} from '../../shared/contracts/runtime.js';
import { parseTurnId } from '../turns/id.js';
import { isChannelPrivacy } from '../../system/trust/context-envelope.js';
import { TRUST_LEVELS } from '../../system/trust/types.js';
import {
  assertExactKeys,
  optionalString,
  parseStringArray,
  requireBoolean,
  requireEnum,
  requireFinite,
  requireRecord,
  requireString,
} from './icp-recovery-metadata-validation.js';

function parseScope(value: unknown, label: string): FatigueBudgetScopeSnapshot {
  const raw = requireRecord(value, label);
  assertExactKeys(raw, new Set([
    'localCompanionId', 'peerContactId', 'channelId', 'dayKey',
  ]), label);
  return {
    localCompanionId: requireString(raw.localCompanionId, `${label}.localCompanionId`),
    peerContactId: requireString(raw.peerContactId, `${label}.peerContactId`),
    channelId: requireString(raw.channelId, `${label}.channelId`),
    dayKey: requireString(raw.dayKey, `${label}.dayKey`),
  };
}

function parseSocialRegulation(
  value: unknown,
  label: string,
): FatigueSocialRegulationMetadata {
  const raw = requireRecord(value, label);
  assertExactKeys(raw, new Set([
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
  ]), label);
  const continuationEvidence = parseStringArray(
    raw.continuationEvidence,
    `${label}.continuationEvidence`,
  );
  for (const evidence of continuationEvidence) {
    if (!FATIGUE_CONTINUATION_EVIDENCE_VALUES.includes(
      evidence as typeof FATIGUE_CONTINUATION_EVIDENCE_VALUES[number],
    )) {
      throw new Error(`${label}.continuationEvidence contains an unknown value`);
    }
  }
  return {
    state: requireEnum(raw.state, FATIGUE_REGULATION_STATE_VALUES, `${label}.state`),
    chargeLane: requireEnum(
      raw.chargeLane,
      ['interactive', 'companion_social'],
      `${label}.chargeLane`,
    ),
    relationshipPressure: requireFinite(
      raw.relationshipPressure,
      `${label}.relationshipPressure`,
    ),
    rootNormalSpent: requireFinite(raw.rootNormalSpent, `${label}.rootNormalSpent`),
    rootOverchargeSpent: requireFinite(
      raw.rootOverchargeSpent,
      `${label}.rootOverchargeSpent`,
    ),
    contributingEventCount: requireFinite(
      raw.contributingEventCount,
      `${label}.contributingEventCount`,
    ),
    marginalChargeUnits: requireFinite(
      raw.marginalChargeUnits,
      `${label}.marginalChargeUnits`,
    ),
    closeoutReserveRemainingBefore: requireFinite(
      raw.closeoutReserveRemainingBefore,
      `${label}.closeoutReserveRemainingBefore`,
    ),
    closeoutReserveRemainingAfterProjected: requireFinite(
      raw.closeoutReserveRemainingAfterProjected,
      `${label}.closeoutReserveRemainingAfterProjected`,
    ),
    continuationEvidence: continuationEvidence as FatigueSocialRegulationMetadata['continuationEvidence'],
    ...(raw.rootInitiationId !== undefined
      ? { rootInitiationId: requireString(raw.rootInitiationId, `${label}.rootInitiationId`) }
      : {}),
  };
}
function parsePeer(value: unknown, label: string): FatigueBudgetPeerSnapshot {
  const raw = requireRecord(value, label);
  assertExactKeys(raw, new Set([
    'contactId', 'displayName', 'channelAuthorId', 'isMachineIntelligence',
  ]), label);
  const displayName = optionalString(raw.displayName, `${label}.displayName`);
  const channelAuthorId = optionalString(raw.channelAuthorId, `${label}.channelAuthorId`);
  return {
    contactId: requireString(raw.contactId, `${label}.contactId`),
    ...(displayName ? { displayName } : {}),
    ...(channelAuthorId ? { channelAuthorId } : {}),
    ...(raw.isMachineIntelligence !== undefined
      ? {
          isMachineIntelligence: requireBoolean(
            raw.isMachineIntelligence,
            `${label}.isMachineIntelligence`,
          ),
        }
      : {}),
  };
}
function parseActor(value: unknown, label: string): FatigueBudgetActorSnapshot {
  const raw = requireRecord(value, label);
  assertExactKeys(raw, new Set([
    'role', 'contactId', 'channelAuthorId', 'displayName', 'isMachineIntelligence',
  ]), label);
  const contactId = optionalString(raw.contactId, `${label}.contactId`);
  const channelAuthorId = optionalString(raw.channelAuthorId, `${label}.channelAuthorId`);
  const displayName = optionalString(raw.displayName, `${label}.displayName`);
  return {
    role: requireEnum(
      raw.role,
      ['human', 'machine_intelligence', 'system', 'unknown'],
      `${label}.role`,
    ),
    ...(contactId ? { contactId } : {}),
    ...(channelAuthorId ? { channelAuthorId } : {}),
    ...(displayName ? { displayName } : {}),
    ...(raw.isMachineIntelligence !== undefined
      ? {
          isMachineIntelligence: requireBoolean(
            raw.isMachineIntelligence,
            `${label}.isMachineIntelligence`,
          ),
        }
      : {}),
  };
}

const FATIGUE_BUDGET_KEYS = [
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

function parseFatigueBudget(value: unknown, label: string): FatigueEnforcementBudgetMetadata {
  const raw = requireRecord(value, label);
  assertExactKeys(raw, new Set(FATIGUE_BUDGET_KEYS), label);
  return {
    spentBefore: requireFinite(raw.spentBefore, `${label}.spentBefore`),
    remainingBefore: requireFinite(raw.remainingBefore, `${label}.remainingBefore`),
    allowance: requireFinite(raw.allowance, `${label}.allowance`),
    softLimit: requireFinite(raw.softLimit, `${label}.softLimit`),
    hardLimit: requireFinite(raw.hardLimit, `${label}.hardLimit`),
    amount: requireFinite(raw.amount, `${label}.amount`),
    spentAfterProjected: requireFinite(
      raw.spentAfterProjected,
      `${label}.spentAfterProjected`,
    ),
    remainingAfterProjected: requireFinite(
      raw.remainingAfterProjected,
      `${label}.remainingAfterProjected`,
    ),
    normalSpentBefore: requireFinite(raw.normalSpentBefore, `${label}.normalSpentBefore`),
    normalSpentAfterProjected: requireFinite(
      raw.normalSpentAfterProjected,
      `${label}.normalSpentAfterProjected`,
    ),
    overchargeSpentBefore: requireFinite(
      raw.overchargeSpentBefore,
      `${label}.overchargeSpentBefore`,
    ),
    overchargeSpentAfterProjected: requireFinite(
      raw.overchargeSpentAfterProjected,
      `${label}.overchargeSpentAfterProjected`,
    ),
    overchargeAllowance: requireFinite(
      raw.overchargeAllowance,
      `${label}.overchargeAllowance`,
    ),
    overchargeRemainingBefore: requireFinite(
      raw.overchargeRemainingBefore,
      `${label}.overchargeRemainingBefore`,
    ),
    overchargeRemainingAfterProjected: requireFinite(
      raw.overchargeRemainingAfterProjected,
      `${label}.overchargeRemainingAfterProjected`,
    ),
  };
}

function parseRecordedEvent(value: unknown, label: string): FatigueRecordedEventMetadata {
  const raw = requireRecord(value, label);
  assertExactKeys(raw, new Set([
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
  ]), label);
  const normalSpentAfter = raw.normalSpentAfter === undefined
    ? undefined
    : requireFinite(raw.normalSpentAfter, `${label}.normalSpentAfter`);
  const overchargeSpentAfter = raw.overchargeSpentAfter === undefined
    ? undefined
    : requireFinite(raw.overchargeSpentAfter, `${label}.overchargeSpentAfter`);
  const overchargeAllowance = raw.overchargeAllowance === undefined
    ? undefined
    : requireFinite(raw.overchargeAllowance, `${label}.overchargeAllowance`);
  const remainingOvercharge = raw.remainingOvercharge === undefined
    ? undefined
    : requireFinite(raw.remainingOvercharge, `${label}.remainingOvercharge`);
  return {
    timestampMs: requireFinite(raw.timestampMs, `${label}.timestampMs`),
    amount: requireFinite(raw.amount, `${label}.amount`),
    decision: requireEnum(raw.decision, ['charged', 'free', 'overcharge'], `${label}.decision`),
    reason: requireEnum(raw.reason, [
      'machine_intelligence_response',
      'overcharge_recent_human_participation',
      'overcharge_work_intent_wrapup',
      'peer_not_machine_intelligence',
      'triggering_author_not_machine_intelligence',
    ], `${label}.reason`),
    spentAfter: requireFinite(raw.spentAfter, `${label}.spentAfter`),
    remainingAllowance: requireFinite(
      raw.remainingAllowance,
      `${label}.remainingAllowance`,
    ),
    ...(normalSpentAfter !== undefined ? { normalSpentAfter } : {}),
    ...(overchargeSpentAfter !== undefined ? { overchargeSpentAfter } : {}),
    ...(overchargeAllowance !== undefined ? { overchargeAllowance } : {}),
    ...(remainingOvercharge !== undefined ? { remainingOvercharge } : {}),
    softState: requireEnum(raw.softState, ['clear', 'soft_limit_reached'], `${label}.softState`),
    hardState: requireEnum(raw.hardState, ['available', 'exhausted'], `${label}.hardState`),
  };
}

export function parseFatigue(value: unknown, label: string): FatigueEnforcementMetadata {
  const raw = requireRecord(value, label);
  assertExactKeys(raw, new Set([
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
  ]), label);
  if (raw.schemaVersion !== 1) throw new Error(`${label}.schemaVersion must be 1`);
  const policyBaseState = requireEnum(
    raw.policyBaseState,
    FATIGUE_POLICY_STATE_VALUES,
    `${label}.policyBaseState`,
  );
  if (policyBaseState === 'overcharge_eligible') {
    throw new Error(`${label}.policyBaseState cannot be overcharge_eligible`);
  }
  return {
    schemaVersion: 1,
    decision: requireEnum(raw.decision, [
      'allowed_free',
      'allowed_charged',
      'wrap_up_charged',
      'overcharge_charged',
      'suppressed_hard_exhausted',
    ], `${label}.decision`),
    modelDisposition: requireEnum(
      raw.modelDisposition,
      ['allowed', 'suppressed'],
      `${label}.modelDisposition`,
    ),
    alertInjected: requireBoolean(raw.alertInjected, `${label}.alertInjected`),
    shouldRecordSpend: requireBoolean(raw.shouldRecordSpend, `${label}.shouldRecordSpend`),
    spendDecision: requireEnum(
      raw.spendDecision,
      ['charged', 'free', 'overcharge'],
      `${label}.spendDecision`,
    ),
    spendReason: requireEnum(raw.spendReason, [
      'machine_intelligence_response',
      'overcharge_recent_human_participation',
      'overcharge_work_intent_wrapup',
      'peer_not_machine_intelligence',
      'triggering_author_not_machine_intelligence',
    ], `${label}.spendReason`),
    policyState: requireEnum(
      raw.policyState,
      FATIGUE_POLICY_STATE_VALUES,
      `${label}.policyState`,
    ),
    policyBaseState,
    intent: requireEnum(raw.intent, FATIGUE_POLICY_INTENT_VALUES, `${label}.intent`),
    relationshipClass: requireEnum(
      raw.relationshipClass,
      FATIGUE_POLICY_RELATIONSHIP_VALUES,
      `${label}.relationshipClass`,
    ),
    channelSetting: requireEnum(
      raw.channelSetting,
      FATIGUE_POLICY_CHANNEL_SETTING_VALUES,
      `${label}.channelSetting`,
    ),
    overchargeEligible: requireBoolean(
      raw.overchargeEligible,
      `${label}.overchargeEligible`,
    ),
    overchargePermitted: requireBoolean(
      raw.overchargePermitted,
      `${label}.overchargePermitted`,
    ),
    overchargeBlockedReasons: parseStringArray(
      raw.overchargeBlockedReasons,
      `${label}.overchargeBlockedReasons`,
    ),
    overchargeReasons: parseStringArray(raw.overchargeReasons, `${label}.overchargeReasons`),
    scope: parseScope(raw.scope, `${label}.scope`),
    peer: parsePeer(raw.peer, `${label}.peer`),
    triggeringAuthor: parseActor(raw.triggeringAuthor, `${label}.triggeringAuthor`),
    budget: parseFatigueBudget(raw.budget, `${label}.budget`),
    socialRegulation: parseSocialRegulation(
      raw.socialRegulation,
      `${label}.socialRegulation`,
    ),
    ...(raw.recordedEvent !== undefined
      ? { recordedEvent: parseRecordedEvent(raw.recordedEvent, `${label}.recordedEvent`) }
      : {}),
  };
}

function parseEmbodimentContext(
  value: unknown,
  label: string,
): NonNullable<CorrelationMetadata['embodimentContext']> {
  const raw = requireRecord(value, label);
  assertExactKeys(raw, new Set([
    'kind',
    'embodimentId',
    'companionId',
    'siteId',
    'channelId',
    'channelPrivacy',
    'label',
    'isPrimary',
    'isActive',
    'satelliteId',
    'emanationId',
  ]), label);
  if (raw.kind !== 'embodiment') throw new Error(`${label}.kind must be embodiment`);
  const siteId = optionalString(raw.siteId, `${label}.siteId`);
  const channelId = optionalString(raw.channelId, `${label}.channelId`);
  const displayLabel = optionalString(raw.label, `${label}.label`);
  const satelliteId = optionalString(raw.satelliteId, `${label}.satelliteId`);
  const emanationId = optionalString(raw.emanationId, `${label}.emanationId`);
  if (raw.channelPrivacy !== undefined && !isChannelPrivacy(raw.channelPrivacy)) {
    throw new Error(`${label}.channelPrivacy is unsupported`);
  }
  return {
    kind: 'embodiment',
    embodimentId: requireString(raw.embodimentId, `${label}.embodimentId`),
    companionId: requireString(raw.companionId, `${label}.companionId`),
    ...(siteId ? { siteId } : {}),
    ...(channelId ? { channelId } : {}),
    ...(raw.channelPrivacy ? { channelPrivacy: raw.channelPrivacy } : {}),
    ...(displayLabel ? { label: displayLabel } : {}),
    ...(raw.isPrimary !== undefined
      ? { isPrimary: requireBoolean(raw.isPrimary, `${label}.isPrimary`) }
      : {}),
    ...(raw.isActive !== undefined
      ? { isActive: requireBoolean(raw.isActive, `${label}.isActive`) }
      : {}),
    ...(satelliteId ? { satelliteId } : {}),
    ...(emanationId ? { emanationId } : {}),
  };
}

function parseCorrelation(value: unknown, label: string): Partial<CorrelationMetadata> {
  const raw = requireRecord(value, label);
  assertExactKeys(raw, new Set([
    'turnId',
    'requestId',
    'channelId',
    'toolName',
    'toolCallId',
    'originType',
    'originStage',
    'callType',
    'purpose',
    'viewerTrustLevel',
    'requesterProvenance',
    'viewerChannelPrivacy',
    'viewerIsDirectMessage',
    'embodimentContext',
    'icpCorrelation',
  ]), label);
  const result: Partial<CorrelationMetadata> = {};
  if (raw.turnId !== undefined) {
    const turnId = parseTurnId(raw.turnId, `${label}.turnId`);
    if (!turnId) throw new Error(`${label}.turnId is required when present`);
    result.turnId = turnId;
  }
  for (const field of [
    'requestId', 'channelId', 'toolName', 'toolCallId', 'originStage', 'purpose',
  ] as const) {
    const parsed = optionalString(raw[field], `${label}.${field}`);
    if (parsed) result[field] = parsed;
  }
  if (raw.originType !== undefined) {
    result.originType = requireEnum(
      raw.originType,
      ['chat', 'tool', 'memory', 'summary', 'background', 'scheduled'],
      `${label}.originType`,
    );
  }
  if (raw.callType !== undefined) {
    result.callType = requireEnum(
      raw.callType,
      ['chat', 'tool', 'memory', 'summary', 'background', 'scheduled'],
      `${label}.callType`,
    );
  }
  if (raw.viewerTrustLevel !== undefined) {
    result.viewerTrustLevel = requireEnum(
      raw.viewerTrustLevel,
      TRUST_LEVELS,
      `${label}.viewerTrustLevel`,
    );
  }
  if (raw.requesterProvenance !== undefined) {
    result.requesterProvenance = requireEnum(
      raw.requesterProvenance,
      ['human', 'self_directed', 'system'],
      `${label}.requesterProvenance`,
    );
  }
  if (raw.viewerChannelPrivacy !== undefined) {
    if (!isChannelPrivacy(raw.viewerChannelPrivacy)) {
      throw new Error(`${label}.viewerChannelPrivacy is unsupported`);
    }
    result.viewerChannelPrivacy = raw.viewerChannelPrivacy;
  }
  if (raw.viewerIsDirectMessage !== undefined) {
    result.viewerIsDirectMessage = requireBoolean(
      raw.viewerIsDirectMessage,
      `${label}.viewerIsDirectMessage`,
    );
  }
  if (raw.embodimentContext !== undefined) {
    result.embodimentContext = parseEmbodimentContext(
      raw.embodimentContext,
      `${label}.embodimentContext`,
    );
  }
  if (raw.icpCorrelation !== undefined) {
    result.icpCorrelation = parseIcpConversationCorrelation(raw.icpCorrelation);
  }
  return result;
}

export function parsePendingSpend(value: unknown, label: string): FatiguePendingSpendMetadata {
  const raw = requireRecord(value, label);
  assertExactKeys(raw, new Set([
    'schemaVersion',
    'timestampMs',
    'decision',
    'reason',
    'amount',
    'scope',
    'peer',
    'triggeringAuthor',
    'limits',
    'correlation',
  ]), label);
  if (raw.schemaVersion !== 1) throw new Error(`${label}.schemaVersion must be 1`);
  const decision = requireEnum(raw.decision, ['charged', 'free', 'overcharge'], `${label}.decision`);
  const reason = requireEnum(raw.reason, [
    'machine_intelligence_response',
    'overcharge_recent_human_participation',
    'overcharge_work_intent_wrapup',
    'peer_not_machine_intelligence',
    'triggering_author_not_machine_intelligence',
  ], `${label}.reason`);
  const amount = requireFinite(raw.amount, `${label}.amount`);
  const timestampMs = requireFinite(raw.timestampMs, `${label}.timestampMs`);
  const scope = parseScope(raw.scope, `${label}.scope`);
  const peer = parsePeer(raw.peer, `${label}.peer`);
  const triggeringAuthor = parseActor(raw.triggeringAuthor, `${label}.triggeringAuthor`);
  const limitsRaw = requireRecord(raw.limits, `${label}.limits`);
  assertExactKeys(
    limitsRaw,
    new Set(['softLimit', 'hardLimit', 'overchargeLimit']),
    `${label}.limits`,
  );
  const limits = {
    softLimit: requireFinite(limitsRaw.softLimit, `${label}.limits.softLimit`),
    hardLimit: requireFinite(limitsRaw.hardLimit, `${label}.limits.hardLimit`),
    overchargeLimit: requireFinite(
      limitsRaw.overchargeLimit,
      `${label}.limits.overchargeLimit`,
    ),
  };
  const correlation = parseCorrelation(raw.correlation, `${label}.correlation`);
  if (!correlation.turnId
    || (correlation.channelId !== undefined && correlation.channelId !== scope.channelId)
    || scope.dayKey !== new Date(timestampMs).toISOString().slice(0, 10)
    || limits.softLimit > limits.hardLimit
    || (decision === 'free' && amount !== 0)
    || (decision !== 'free' && amount <= 0)) {
    throw new Error(`${label} has inconsistent spend invariants`);
  }
  const reasonMatches = (decision === 'charged' && reason === 'machine_intelligence_response')
    || (decision === 'overcharge'
      && (reason === 'overcharge_recent_human_participation'
        || reason === 'overcharge_work_intent_wrapup'))
    || (decision === 'free'
      && (reason === 'peer_not_machine_intelligence'
        || reason === 'triggering_author_not_machine_intelligence'));
  if (!reasonMatches) throw new Error(`${label}.reason does not match its decision`);
  return {
    schemaVersion: 1,
    timestampMs,
    decision,
    reason,
    amount,
    scope,
    peer,
    triggeringAuthor,
    limits,
    correlation,
  };
}
