import type { AgentResponse, SubstrateMessage } from '../../shared/contracts/runtime.js';
import { createHash } from 'node:crypto';
import type { DisclosureLineage } from '../../core/cogsec/disclosure/index.js';
import { sensitivityAtMost } from '../../system/trust/types.js';
import {
  createHumanRelayResponse,
  openHumanRelayIntentCapsule,
  openHumanRelayResponseCapsule,
  type HumanRelayBoundaryDecision,
  type HumanRelayIntentCapsule,
  type HumanRelayReplayGuard,
  type HumanRelayDisposition,
  type HumanRelayResponseCapsule,
} from '../../core/icp/human-relay-capsule.js';

export interface HumanRelayTransportCustody {
  requestCapsule: HumanRelayIntentCapsule;
  responseCapsule?: HumanRelayResponseCapsule;
  /** Process-local target intake proof. The gateway never accepts this from RPC. */
  targetAuthorization?: HumanRelayBoundaryDecision;
}

function requireCorrelation(message: SubstrateMessage) {
  const correlation = message.routing?.icpCorrelation;
  if (!correlation) throw new Error('Human relay transport is missing ICP correlation');
  return correlation;
}

function deterministicResponseId(seed: string): string {
  const digest = createHash('sha256').update(seed).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}`
    + `-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export async function openTargetHumanRelayRequest(input: {
  message: SubstrateMessage;
  localCompanionId: string;
  nowMs: number;
  replayGuard: HumanRelayReplayGuard;
}): Promise<HumanRelayBoundaryDecision> {
  const custody = input.message.routing?.humanRelay as HumanRelayTransportCustody | undefined;
  if (!custody || custody.responseCapsule) {
    throw new Error('Human relay target intake requires a request-only capsule');
  }
  const correlation = requireCorrelation(input.message);
  if (correlation.localCompanionId !== input.message.authorId
    || correlation.peerCompanionId !== input.localCompanionId
    || correlation.channelId !== input.message.channelId
    || custody.requestCapsule.source.companionId !== input.message.authorId
    || custody.requestCapsule.target.companionId !== input.localCompanionId
    || custody.requestCapsule.target.dyadId !== correlation.dyadId) {
    throw new Error('Human relay target intake has confused-deputy lineage');
  }
  const opened = await openHumanRelayIntentCapsule({
    capsule: custody.requestCapsule,
    nowMs: input.nowMs,
    expectedTarget: {
      companionId: input.localCompanionId,
      peerCompanionId: input.message.authorId,
      dyadId: correlation.dyadId,
      channelId: correlation.channelId,
      participantCompanionIds: [input.message.authorId, input.localCompanionId],
    },
    targetGate: binding => ({
      authorized: true,
      boundary: 'target_intake',
      bindingHash: binding.bindingHash,
      policyRef: `icp-human-relay:${correlation.dyadId}`,
      provenanceRefs: [
        ...custody.requestCapsule.sourceAuthorization.provenanceRefs,
        `icp-dyad:${correlation.dyadId}`,
        `icp-message:${input.message.id}`,
      ],
      disclosureCeiling: 'stated_intent_only',
      decidedAtMs: input.nowMs,
    }),
    replayGuard: input.replayGuard,
  });
  return opened.targetAuthorization;
}

function targetEgressEligible(lineage: DisclosureLineage | undefined): lineage is DisclosureLineage {
  return Boolean(lineage
    && lineage.sourceCount === 1
    && lineage.sourceSnapshots.length === 1
    && !lineage.hasUnclassifiedSource
    && lineage.subjectContactIds.length > 0
    && lineage.provenanceRefs.length > 0
    && sensitivityAtMost(lineage.effectiveSensitivity, 'personal'));
}

export async function createTargetHumanRelayReturn(input: {
  message: SubstrateMessage;
  response: AgentResponse;
  localCompanionId: string;
  lineage: DisclosureLineage | undefined;
  nowMs: number;
  disposition?: HumanRelayDisposition;
}): Promise<{ delivery: 'withheld' } | {
  delivery: 'queued';
  custody: HumanRelayTransportCustody;
}> {
  const custody = input.message.routing?.humanRelay as HumanRelayTransportCustody | undefined;
  if (!custody || custody.responseCapsule || !custody.targetAuthorization) {
    throw new Error('Human relay response is missing target intake custody');
  }
  if (input.disposition === 'ignore' || input.disposition === 'private'
    || !input.response.content.trim()) return { delivery: 'withheld' };
  const correlation = requireCorrelation(input.message);
  const dyadId = correlation.dyadId;
  const lineage = input.lineage;
  const turnId = input.response.metadata.turnId;
  const requestId = input.response.metadata.requestId;
  if (!turnId || !requestId || !dyadId || !targetEgressEligible(lineage)) {
    return { delivery: 'withheld' };
  }
  const created = await createHumanRelayResponse({
    request: custody.requestCapsule,
    responseId: deterministicResponseId(JSON.stringify([
      'human-relay-response', custody.requestCapsule.digest, turnId, requestId,
      input.response.content,
    ])),
    disposition: input.disposition ?? 'answer',
    content: input.response.content,
    response: {
      companionId: input.localCompanionId,
      dyadId,
      channelId: correlation.channelId,
      turnId,
      requestId,
    },
    issuedAtMs: input.nowMs,
    expiresAtMs: custody.requestCapsule.expiresAtMs,
    targetEgressGate: binding => ({
      authorized: true,
      boundary: 'target_egress',
      bindingHash: binding.bindingHash,
      policyRef: 'cogsec:human-relay:single-attributed-source',
      provenanceRefs: [
        ...custody.targetAuthorization!.provenanceRefs,
        lineage.generationContextRef,
        ...lineage.provenanceRefs,
        ...lineage.sourceSnapshots.map(source => source.ref),
      ],
      disclosureCeiling: 'target_authorized_content_only',
      decidedAtMs: input.nowMs,
    }),
  });
  if (created.delivery !== 'queued') return { delivery: 'withheld' };
  return {
    delivery: 'queued',
    custody: { requestCapsule: custody.requestCapsule, responseCapsule: created.capsule },
  };
}

export async function openSourceHumanRelayReturn(input: {
  message: SubstrateMessage;
  localCompanionId: string;
  nowMs: number;
  replayGuard: HumanRelayReplayGuard;
  deliver(channelId: string, exactContent: string): Promise<void>;
}): Promise<void> {
  const custody = input.message.routing?.humanRelay as HumanRelayTransportCustody | undefined;
  if (!custody?.responseCapsule) throw new Error('Human relay return capsule is missing');
  const correlation = requireCorrelation(input.message);
  const response = custody.responseCapsule;
  const request = custody.requestCapsule;
  if (correlation.localCompanionId !== input.message.authorId
    || correlation.peerCompanionId !== input.localCompanionId
    || correlation.channelId !== input.message.channelId
    || response.response.companionId !== input.message.authorId
    || response.destination.companionId !== input.localCompanionId
    || response.response.dyadId !== correlation.dyadId
    || input.message.content !== response.content) {
    throw new Error('Human relay return has confused-deputy or altered-byte lineage');
  }
  const opened = await openHumanRelayResponseCapsule({
    capsule: response,
    request,
    nowMs: input.nowMs,
    expectedDestination: {
      companionId: input.localCompanionId,
      channelId: request.source.channelId,
      humanParticipantId: request.source.humanParticipantId,
      humanContactId: request.source.humanContactId,
    },
    sourceIntakeGate: binding => ({
      authorized: true,
      boundary: 'source_intake',
      bindingHash: binding.bindingHash,
      policyRef: `icp-human-relay-return:${correlation.dyadId}`,
      provenanceRefs: [
        ...response.targetAuthorization.provenanceRefs,
        `icp-dyad:${correlation.dyadId}`,
        `icp-message:${input.message.id}`,
        `human-relay-request:${request.digest}`,
      ],
      disclosureCeiling: 'target_authorized_content_only',
      decidedAtMs: input.nowMs,
    }),
    replayGuard: input.replayGuard,
  });
  await input.deliver(opened.destinationChannelId, opened.content);
}
