import type { IcpConversationCorrelation } from '../../shared/contracts/icp-autonomy.js';
import type {
  FatigueEnforcementMetadata,
  FatiguePendingSpendMetadata,
} from '../../shared/contracts/runtime.js';

export const LOCAL = '11111111-1111-4111-8111-111111111111';
export const PEER = '22222222-2222-4222-8222-222222222222';
export const CHANNEL = `companion-dm:${LOCAL}:${PEER}`;
export const SOURCE = 'companion-initiation-33333333-3333-4333-8333-333333333333';
export const FATIGUE_TIMESTAMP_MS = Date.parse('2026-03-02T00:00:00.000Z');

export const correlation = {
  conversationId: '44444444-4444-4444-8444-444444444444',
  rootInitiationId: '99999999-9999-4999-8999-999999999999',
  initiatedByCompanionId: PEER,
  localCompanionId: LOCAL,
  peerCompanionId: PEER,
  peerContactId: 'contact-peer',
  channelId: CHANNEL,
  turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7081',
  messageId: SOURCE,
  requestId: SOURCE,
  chargeLane: 'companion_social' as const,
  surface: 'companion_dm' as const,
  costPurpose: 'conversation_turn' as const,
  costOriginStage: 'reply' as const,
  fatigueDecision: 'not_evaluated' as const,
} satisfies IcpConversationCorrelation;

export const chargedCorrelation = {
  ...correlation,
  fatigueDecision: 'allow' as const,
} satisfies IcpConversationCorrelation;

export const recoveryResponse = {
  content: 'Durable reply',
  channelId: CHANNEL,
  metadata: {
    model: 'strict-codec-test',
    inputTokens: 3,
    outputTokens: 2,
    durationMs: 5,
    turnId: correlation.turnId,
    requestId: correlation.requestId,
    icpCorrelation: correlation,
  },
};

export const fatigueScope = {
  localCompanionId: LOCAL,
  peerContactId: correlation.peerContactId,
  channelId: CHANNEL,
  dayKey: '2026-03-02',
};

export const fatiguePeer = {
  contactId: correlation.peerContactId,
  channelAuthorId: PEER,
  isMachineIntelligence: true,
};

export const fatigueActor = {
  role: 'machine_intelligence' as const,
  contactId: correlation.peerContactId,
  channelAuthorId: PEER,
  isMachineIntelligence: true,
};

export const fatigueBudget = {
  spentBefore: 0,
  remainingBefore: 8,
  allowance: 8,
  softLimit: 6,
  hardLimit: 8,
  amount: 1,
  spentAfterProjected: 1,
  remainingAfterProjected: 7,
  normalSpentBefore: 0,
  normalSpentAfterProjected: 1,
  overchargeSpentBefore: 0,
  overchargeSpentAfterProjected: 0,
  overchargeAllowance: 2,
  overchargeRemainingBefore: 2,
  overchargeRemainingAfterProjected: 2,
};

export const fatigueMetadata = {
  schemaVersion: 1,
  decision: 'allowed_charged',
  modelDisposition: 'allowed',
  alertInjected: false,
  shouldRecordSpend: true,
  spendDecision: 'charged',
  spendReason: 'machine_intelligence_response',
  policyState: 'normal',
  policyBaseState: 'normal',
  intent: 'social',
  relationshipClass: 'known_mi',
  channelSetting: 'dm',
  overchargeEligible: false,
  overchargePermitted: false,
  overchargeBlockedReasons: [
    'normal_allowance_not_exhausted',
    'no_qualifying_overcharge_trigger',
  ],
  overchargeReasons: [],
  scope: fatigueScope,
  peer: fatiguePeer,
  triggeringAuthor: fatigueActor,
  budget: fatigueBudget,
} satisfies FatigueEnforcementMetadata;

export const fatiguePendingSpend = {
  schemaVersion: 1,
  timestampMs: FATIGUE_TIMESTAMP_MS,
  decision: 'charged',
  reason: 'machine_intelligence_response',
  amount: 1,
  scope: fatigueScope,
  peer: fatiguePeer,
  triggeringAuthor: fatigueActor,
  limits: {
    softLimit: 6,
    hardLimit: 8,
    overchargeLimit: 2,
  },
  correlation: {
    turnId: correlation.turnId,
    requestId: correlation.requestId,
    channelId: CHANNEL,
    callType: 'chat',
    purpose: 'agent.fatigue.record',
    originType: 'chat',
    originStage: 'agent.fatigue.record',
    icpCorrelation: chargedCorrelation,
  },
} satisfies FatiguePendingSpendMetadata;

export const fatigueRecordedEvent = {
  timestampMs: FATIGUE_TIMESTAMP_MS,
  amount: 1,
  decision: 'charged',
  reason: 'machine_intelligence_response',
  spentAfter: 1,
  remainingAllowance: 7,
  normalSpentAfter: 1,
  overchargeSpentAfter: 0,
  overchargeAllowance: 2,
  remainingOvercharge: 2,
  softState: 'clear',
  hardState: 'available',
} satisfies NonNullable<FatigueEnforcementMetadata['recordedEvent']>;

export function recoveryWithFatigue(overrides: Record<string, unknown> = {}) {
  return {
    ...recoveryResponse,
    metadata: {
      ...recoveryResponse.metadata,
      icpCorrelation: chargedCorrelation,
      fatigue: fatigueMetadata,
      fatiguePendingSpend,
      ...overrides,
    },
  };
}
