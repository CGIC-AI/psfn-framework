import { createHash } from 'node:crypto';

import { MAX_ICP_PERMIT_TTL_MS } from '../../shared/contracts/icp-autonomy.js';
import { isRecord } from '../../shared/utils/types.js';
import { requireUuid } from '../../shared/utils/uuid.js';

export const HUMAN_RELAY_CAPSULE_SCHEMA_VERSION = 1 as const;

export type HumanRelayBoundary =
  | 'source_egress'
  | 'target_intake'
  | 'target_egress'
  | 'source_intake';

export type HumanRelayDisclosureCeiling =
  | 'stated_intent_only'
  | 'target_authorized_content_only';

export interface HumanRelayBoundaryDecision {
  readonly authorized: boolean;
  readonly boundary: HumanRelayBoundary;
  readonly bindingHash: string;
  readonly policyRef: string;
  readonly provenanceRefs: readonly string[];
  readonly disclosureCeiling: HumanRelayDisclosureCeiling;
  readonly decidedAtMs: number;
}

interface HumanRelayBindingBase {
  readonly boundary: HumanRelayBoundary;
  readonly bindingHash: string;
  readonly exactBytes: string;
  readonly exactBytesHash: string;
  readonly disclosureCeiling: HumanRelayDisclosureCeiling;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export interface HumanRelayIntentBinding extends HumanRelayBindingBase {
  readonly kind: 'human_relay_intent';
  readonly capsuleId: string;
  readonly source: HumanRelayIntentSource;
  readonly target: HumanRelayIntentTarget;
}

export interface HumanRelayResponseBinding extends HumanRelayBindingBase {
  readonly kind: 'human_relay_response';
  readonly responseId: string;
  readonly requestCapsuleId: string;
  readonly requestDigest: string;
  readonly disposition: HumanRelayReturnableDisposition;
  readonly response: HumanRelayResponseSource;
  readonly destination: HumanRelayResponseDestination;
}

export type HumanRelayBoundaryBinding = HumanRelayIntentBinding | HumanRelayResponseBinding;
export type HumanRelayBoundaryGate = (
  binding: HumanRelayBoundaryBinding,
) => Promise<HumanRelayBoundaryDecision> | HumanRelayBoundaryDecision;

export interface HumanRelayReplayGuard {
  claim(kind: 'intent' | 'response', id: string, digest: string): Promise<boolean> | boolean;
}

export interface HumanRelayIntentSource {
  readonly companionId: string;
  readonly channelId: string;
  readonly turnId: string;
  readonly requestId: string;
  readonly messageId: string;
  readonly humanParticipantId: string;
  readonly humanContactId: string;
  readonly requesterKind: 'human';
  /** Digest of the complete source message; the message itself never crosses the boundary. */
  readonly sourceTurnDigest: string;
}

export interface HumanRelayIntentTarget {
  readonly companionId: string;
  readonly peerContactId: string;
  readonly dyadId: string;
  readonly channelId: string;
  readonly participantCompanionIds: readonly [string, string];
}

export interface HumanRelayIntentCapsule {
  readonly schemaVersion: typeof HUMAN_RELAY_CAPSULE_SCHEMA_VERSION;
  readonly capsuleKind: 'human_relay_intent';
  readonly capsuleId: string;
  readonly intent: string;
  readonly intentHash: string;
  readonly source: HumanRelayIntentSource;
  readonly target: HumanRelayIntentTarget;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly disclosureCeiling: 'stated_intent_only';
  readonly bindingHash: string;
  readonly sourceAuthorization: HumanRelayBoundaryDecision;
  readonly digest: string;
}

export interface HumanRelayExpectedTarget {
  readonly companionId: string;
  readonly peerCompanionId: string;
  readonly dyadId: string;
  readonly channelId: string;
  readonly participantCompanionIds: readonly [string, string];
}

export interface OpenedHumanRelayIntent {
  readonly delivery: 'queued';
  readonly capsuleId: string;
  readonly capsuleDigest: string;
  readonly intent: string;
  readonly sourceCompanionId: string;
  readonly requestingHumanParticipantId: string;
  readonly targetCompanionId: string;
  readonly dyadId: string;
  readonly expiresAtMs: number;
  readonly sourceAuthorization: HumanRelayBoundaryDecision;
  readonly targetAuthorization: HumanRelayBoundaryDecision;
}

export type HumanRelayDisposition = 'answer' | 'decline' | 'defer' | 'ignore' | 'private';
export type HumanRelayReturnableDisposition = Exclude<HumanRelayDisposition, 'ignore' | 'private'>;

export interface HumanRelayResponseSource {
  readonly companionId: string;
  readonly dyadId: string;
  readonly channelId: string;
  readonly turnId: string;
  readonly requestId: string;
}

export interface HumanRelayResponseDestination {
  readonly companionId: string;
  readonly channelId: string;
  readonly humanParticipantId: string;
  readonly humanContactId: string;
}

export interface HumanRelayResponseCapsule {
  readonly schemaVersion: typeof HUMAN_RELAY_CAPSULE_SCHEMA_VERSION;
  readonly capsuleKind: 'human_relay_response';
  readonly responseId: string;
  readonly requestCapsuleId: string;
  readonly requestDigest: string;
  readonly disposition: HumanRelayReturnableDisposition;
  readonly content: string;
  readonly contentHash: string;
  readonly response: HumanRelayResponseSource;
  readonly destination: HumanRelayResponseDestination;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly disclosureCeiling: 'target_authorized_content_only';
  readonly bindingHash: string;
  readonly targetAuthorization: HumanRelayBoundaryDecision;
  readonly digest: string;
}

export type HumanRelayResponseCreationResult =
  | { readonly disposition: 'ignore' | 'private'; readonly delivery: 'withheld' }
  | {
      readonly disposition: HumanRelayReturnableDisposition;
      readonly delivery: 'queued';
      readonly capsule: HumanRelayResponseCapsule;
    };

const INTENT_CAPSULE_KEYS = [
  'schemaVersion', 'capsuleKind', 'capsuleId', 'intent', 'intentHash', 'source',
  'target', 'issuedAtMs', 'expiresAtMs', 'disclosureCeiling', 'bindingHash',
  'sourceAuthorization', 'digest',
] as const;
const INTENT_SOURCE_KEYS = [
  'companionId', 'channelId', 'turnId', 'requestId', 'messageId',
  'humanParticipantId', 'humanContactId', 'requesterKind', 'sourceTurnDigest',
] as const;
const INTENT_TARGET_KEYS = [
  'companionId', 'peerContactId', 'dyadId', 'channelId', 'participantCompanionIds',
] as const;
const RESPONSE_CAPSULE_KEYS = [
  'schemaVersion', 'capsuleKind', 'responseId', 'requestCapsuleId', 'requestDigest',
  'disposition', 'content', 'contentHash', 'response', 'destination', 'issuedAtMs',
  'expiresAtMs', 'disclosureCeiling', 'bindingHash', 'targetAuthorization', 'digest',
] as const;
const RESPONSE_SOURCE_KEYS = ['companionId', 'dyadId', 'channelId', 'turnId', 'requestId'] as const;
const RESPONSE_DESTINATION_KEYS = [
  'companionId', 'channelId', 'humanParticipantId', 'humanContactId',
] as const;
const DECISION_KEYS = [
  'authorized', 'boundary', 'bindingHash', 'policyRef', 'provenanceRefs',
  'disclosureCeiling', 'decidedAtMs',
] as const;

function hash(value: unknown): string {
  return createHash('sha256').update(
    typeof value === 'string' ? Buffer.from(value, 'utf8') : JSON.stringify(value),
  ).digest('hex');
}

function exactString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw new Error(`${field} must be an exact non-empty string`);
  }
  return value;
}

function exactText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must contain non-whitespace bytes`);
  }
  return value;
}

function timestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer timestamp`);
  }
  return value;
}

function assertExactKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is ambiguous or malformed`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) {
    throw new Error(`${label} contains ambiguous fields`);
  }
}

function validateWindow(issuedAtMs: number, expiresAtMs: number): void {
  if (expiresAtMs <= issuedAtMs) throw new Error('Human relay capsule expiry must follow issuance');
  if (expiresAtMs - issuedAtMs > MAX_ICP_PERMIT_TTL_MS) {
    throw new Error('Human relay capsule exceeds the bounded authority window');
  }
}

function validatePair(
  participants: readonly unknown[],
  sourceCompanionId: string,
  targetCompanionId: string,
): asserts participants is readonly [string, string] {
  if (participants.length !== 2
    || participants[0] !== sourceCompanionId
    || participants[1] !== targetCompanionId
    || sourceCompanionId === targetCompanionId) {
    throw new Error('Human relay participants are ambiguous');
  }
}

function intentBindingMaterial(input: {
  capsuleId: string;
  intent: string;
  intentHash: string;
  source: HumanRelayIntentSource;
  target: HumanRelayIntentTarget;
  issuedAtMs: number;
  expiresAtMs: number;
}) {
  return {
    schemaVersion: HUMAN_RELAY_CAPSULE_SCHEMA_VERSION,
    capsuleKind: 'human_relay_intent',
    capsuleId: input.capsuleId,
    intent: input.intent,
    intentHash: input.intentHash,
    source: input.source,
    target: input.target,
    issuedAtMs: input.issuedAtMs,
    expiresAtMs: input.expiresAtMs,
    disclosureCeiling: 'stated_intent_only',
  } as const;
}

function intentBinding(
  material: ReturnType<typeof intentBindingMaterial>,
  boundary: 'source_egress' | 'target_intake',
): HumanRelayIntentBinding {
  const bindingHash = hash(material);
  return {
    kind: 'human_relay_intent',
    boundary,
    bindingHash,
    capsuleId: material.capsuleId,
    exactBytes: material.intent,
    exactBytesHash: material.intentHash,
    source: material.source,
    target: material.target,
    disclosureCeiling: 'stated_intent_only',
    issuedAtMs: material.issuedAtMs,
    expiresAtMs: material.expiresAtMs,
  };
}

function responseBindingMaterial(input: {
  responseId: string;
  requestCapsuleId: string;
  requestDigest: string;
  disposition: HumanRelayReturnableDisposition;
  content: string;
  contentHash: string;
  response: HumanRelayResponseSource;
  destination: HumanRelayResponseDestination;
  issuedAtMs: number;
  expiresAtMs: number;
}) {
  return {
    schemaVersion: HUMAN_RELAY_CAPSULE_SCHEMA_VERSION,
    capsuleKind: 'human_relay_response',
    ...input,
    disclosureCeiling: 'target_authorized_content_only',
  } as const;
}

function responseBinding(
  material: ReturnType<typeof responseBindingMaterial>,
  boundary: 'target_egress' | 'source_intake',
): HumanRelayResponseBinding {
  const bindingHash = hash(material);
  return {
    kind: 'human_relay_response',
    boundary,
    bindingHash,
    responseId: material.responseId,
    requestCapsuleId: material.requestCapsuleId,
    requestDigest: material.requestDigest,
    disposition: material.disposition,
    exactBytes: material.content,
    exactBytesHash: material.contentHash,
    response: material.response,
    destination: material.destination,
    disclosureCeiling: 'target_authorized_content_only',
    issuedAtMs: material.issuedAtMs,
    expiresAtMs: material.expiresAtMs,
  };
}

function validateDecision(
  value: unknown,
  binding: HumanRelayBoundaryBinding,
): HumanRelayBoundaryDecision {
  assertExactKeys(value, DECISION_KEYS, 'Human relay boundary decision');
  if (value.authorized !== true) throw new Error(`Human relay ${binding.boundary} denied`);
  if (value.boundary !== binding.boundary
    || value.bindingHash !== binding.bindingHash
    || value.disclosureCeiling !== binding.disclosureCeiling) {
    throw new Error(`Human relay ${binding.boundary} decision does not bind the exact capsule bytes`);
  }
  const policyRef = exactString(value.policyRef, 'Human relay policyRef');
  if (!Array.isArray(value.provenanceRefs) || value.provenanceRefs.length === 0) {
    throw new Error('Human relay decision requires complete provenance lineage');
  }
  const provenanceRefs = value.provenanceRefs.map((ref, index) => (
    exactString(ref, `Human relay provenanceRefs[${index}]`)
  ));
  return {
    authorized: true,
    boundary: binding.boundary,
    bindingHash: binding.bindingHash,
    policyRef,
    provenanceRefs,
    disclosureCeiling: binding.disclosureCeiling,
    decidedAtMs: timestamp(value.decidedAtMs, 'Human relay decidedAtMs'),
  };
}

function parseIntentCapsule(value: unknown): HumanRelayIntentCapsule {
  assertExactKeys(value, INTENT_CAPSULE_KEYS, 'Human relay intent capsule');
  if (value.schemaVersion !== HUMAN_RELAY_CAPSULE_SCHEMA_VERSION
    || value.capsuleKind !== 'human_relay_intent'
    || value.disclosureCeiling !== 'stated_intent_only') {
    throw new Error('Human relay intent capsule is malformed');
  }
  const capsuleId = requireUuid(value.capsuleId, 'humanRelay.capsuleId');
  const intent = exactText(value.intent, 'humanRelay.intent');
  const intentHash = exactString(value.intentHash, 'humanRelay.intentHash');
  assertExactKeys(value.source, INTENT_SOURCE_KEYS, 'Human relay intent source');
  assertExactKeys(value.target, INTENT_TARGET_KEYS, 'Human relay intent target');
  const source: HumanRelayIntentSource = {
    companionId: requireUuid(value.source.companionId, 'humanRelay.source.companionId'),
    channelId: exactString(value.source.channelId, 'humanRelay.source.channelId'),
    turnId: exactString(value.source.turnId, 'humanRelay.source.turnId'),
    requestId: exactString(value.source.requestId, 'humanRelay.source.requestId'),
    messageId: exactString(value.source.messageId, 'humanRelay.source.messageId'),
    humanParticipantId: exactString(value.source.humanParticipantId, 'humanRelay.source.humanParticipantId'),
    humanContactId: exactString(value.source.humanContactId, 'humanRelay.source.humanContactId'),
    requesterKind: value.source.requesterKind === 'human'
      ? 'human'
      : (() => { throw new Error('Human relay requires an explicit human requester'); })(),
    sourceTurnDigest: exactString(value.source.sourceTurnDigest, 'humanRelay.source.sourceTurnDigest'),
  };
  const targetCompanionId = requireUuid(value.target.companionId, 'humanRelay.target.companionId');
  if (!Array.isArray(value.target.participantCompanionIds)) {
    throw new Error('Human relay participants are ambiguous');
  }
  validatePair(value.target.participantCompanionIds, source.companionId, targetCompanionId);
  const target: HumanRelayIntentTarget = {
    companionId: targetCompanionId,
    peerContactId: exactString(value.target.peerContactId, 'humanRelay.target.peerContactId'),
    dyadId: requireUuid(value.target.dyadId, 'humanRelay.target.dyadId'),
    channelId: exactString(value.target.channelId, 'humanRelay.target.channelId'),
    participantCompanionIds: [source.companionId, targetCompanionId],
  };
  const issuedAtMs = timestamp(value.issuedAtMs, 'humanRelay.issuedAtMs');
  const expiresAtMs = timestamp(value.expiresAtMs, 'humanRelay.expiresAtMs');
  validateWindow(issuedAtMs, expiresAtMs);
  const material = intentBindingMaterial({
    capsuleId, intent, intentHash, source, target, issuedAtMs, expiresAtMs,
  });
  const binding = intentBinding(material, 'source_egress');
  const sourceAuthorization = validateDecision(value.sourceAuthorization, binding);
  const digest = exactString(value.digest, 'humanRelay.digest');
  if (intentHash !== hash(intent)
    || value.bindingHash !== binding.bindingHash
    || digest !== hash({ ...material, bindingHash: binding.bindingHash, sourceAuthorization })) {
    throw new Error('Human relay intent capsule integrity check failed');
  }
  return { ...material, bindingHash: binding.bindingHash, sourceAuthorization, digest };
}

function parseResponseCapsule(value: unknown): HumanRelayResponseCapsule {
  assertExactKeys(value, RESPONSE_CAPSULE_KEYS, 'Human relay response capsule');
  if (value.schemaVersion !== HUMAN_RELAY_CAPSULE_SCHEMA_VERSION
    || value.capsuleKind !== 'human_relay_response'
    || value.disclosureCeiling !== 'target_authorized_content_only'
    || (value.disposition !== 'answer' && value.disposition !== 'decline' && value.disposition !== 'defer')) {
    throw new Error('Human relay response capsule is malformed');
  }
  assertExactKeys(value.response, RESPONSE_SOURCE_KEYS, 'Human relay response source');
  assertExactKeys(value.destination, RESPONSE_DESTINATION_KEYS, 'Human relay response destination');
  const responseId = requireUuid(value.responseId, 'humanRelay.responseId');
  const requestCapsuleId = requireUuid(value.requestCapsuleId, 'humanRelay.requestCapsuleId');
  const requestDigest = exactString(value.requestDigest, 'humanRelay.requestDigest');
  const content = exactText(value.content, 'humanRelay.content');
  const contentHash = exactString(value.contentHash, 'humanRelay.contentHash');
  const response: HumanRelayResponseSource = {
    companionId: requireUuid(value.response.companionId, 'humanRelay.response.companionId'),
    dyadId: requireUuid(value.response.dyadId, 'humanRelay.response.dyadId'),
    channelId: exactString(value.response.channelId, 'humanRelay.response.channelId'),
    turnId: exactString(value.response.turnId, 'humanRelay.response.turnId'),
    requestId: exactString(value.response.requestId, 'humanRelay.response.requestId'),
  };
  const destination: HumanRelayResponseDestination = {
    companionId: requireUuid(value.destination.companionId, 'humanRelay.destination.companionId'),
    channelId: exactString(value.destination.channelId, 'humanRelay.destination.channelId'),
    humanParticipantId: exactString(value.destination.humanParticipantId, 'humanRelay.destination.humanParticipantId'),
    humanContactId: exactString(value.destination.humanContactId, 'humanRelay.destination.humanContactId'),
  };
  const issuedAtMs = timestamp(value.issuedAtMs, 'humanRelay.issuedAtMs');
  const expiresAtMs = timestamp(value.expiresAtMs, 'humanRelay.expiresAtMs');
  validateWindow(issuedAtMs, expiresAtMs);
  const material = responseBindingMaterial({
    responseId,
    requestCapsuleId,
    requestDigest,
    disposition: value.disposition,
    content,
    contentHash,
    response,
    destination,
    issuedAtMs,
    expiresAtMs,
  });
  const binding = responseBinding(material, 'target_egress');
  const targetAuthorization = validateDecision(value.targetAuthorization, binding);
  const digest = exactString(value.digest, 'humanRelay.digest');
  if (contentHash !== hash(content)
    || value.bindingHash !== binding.bindingHash
    || digest !== hash({ ...material, bindingHash: binding.bindingHash, targetAuthorization })) {
    throw new Error('Human relay response capsule integrity check failed');
  }
  return { ...material, bindingHash: binding.bindingHash, targetAuthorization, digest };
}

export function createInMemoryHumanRelayReplayGuard(): HumanRelayReplayGuard {
  const claimed = new Map<string, string>();
  return {
    claim(kind, id, digest) {
      const key = `${kind}:${id}`;
      if (claimed.has(key)) return false;
      claimed.set(key, digest);
      return true;
    },
  };
}

export async function createHumanRelayIntentCapsule(input: {
  capsuleId: string;
  intent: string;
  sourceMessage: string;
  source: Omit<HumanRelayIntentSource, 'sourceTurnDigest'> & { requesterKind: 'human' | 'system' | 'self_directed' };
  target: HumanRelayIntentTarget;
  issuedAtMs: number;
  expiresAtMs: number;
  sourceGate: HumanRelayBoundaryGate;
}): Promise<HumanRelayIntentCapsule> {
  const capsuleId = requireUuid(input.capsuleId, 'humanRelay.capsuleId');
  const intent = exactText(input.intent, 'humanRelay.intent');
  const sourceMessage = exactText(input.sourceMessage, 'humanRelay.sourceMessage');
  if (input.source.requesterKind !== 'human') {
    throw new Error('Human relay requires an explicit human requester');
  }
  if (!sourceMessage.includes(intent)) {
    throw new Error('Human relay intent must be exact bytes stated in the source human turn');
  }
  const sourceCompanionId = requireUuid(input.source.companionId, 'humanRelay.source.companionId');
  const targetCompanionId = requireUuid(input.target.companionId, 'humanRelay.target.companionId');
  validatePair(input.target.participantCompanionIds, sourceCompanionId, targetCompanionId);
  const issuedAtMs = timestamp(input.issuedAtMs, 'humanRelay.issuedAtMs');
  const expiresAtMs = timestamp(input.expiresAtMs, 'humanRelay.expiresAtMs');
  validateWindow(issuedAtMs, expiresAtMs);
  const source: HumanRelayIntentSource = {
    companionId: sourceCompanionId,
    channelId: exactString(input.source.channelId, 'humanRelay.source.channelId'),
    turnId: exactString(input.source.turnId, 'humanRelay.source.turnId'),
    requestId: exactString(input.source.requestId, 'humanRelay.source.requestId'),
    messageId: exactString(input.source.messageId, 'humanRelay.source.messageId'),
    humanParticipantId: exactString(input.source.humanParticipantId, 'humanRelay.source.humanParticipantId'),
    humanContactId: exactString(input.source.humanContactId, 'humanRelay.source.humanContactId'),
    requesterKind: 'human',
    sourceTurnDigest: hash(sourceMessage),
  };
  const target: HumanRelayIntentTarget = {
    companionId: targetCompanionId,
    peerContactId: exactString(input.target.peerContactId, 'humanRelay.target.peerContactId'),
    dyadId: requireUuid(input.target.dyadId, 'humanRelay.target.dyadId'),
    channelId: exactString(input.target.channelId, 'humanRelay.target.channelId'),
    participantCompanionIds: [sourceCompanionId, targetCompanionId],
  };
  const material = intentBindingMaterial({
    capsuleId,
    intent,
    intentHash: hash(intent),
    source,
    target,
    issuedAtMs,
    expiresAtMs,
  });
  const binding = intentBinding(material, 'source_egress');
  const sourceAuthorization = validateDecision(await input.sourceGate(binding), binding);
  const digest = hash({ ...material, bindingHash: binding.bindingHash, sourceAuthorization });
  return { ...material, bindingHash: binding.bindingHash, sourceAuthorization, digest };
}

export async function openHumanRelayIntentCapsule(input: {
  capsule: unknown;
  nowMs: number;
  expectedTarget: HumanRelayExpectedTarget;
  targetGate: HumanRelayBoundaryGate;
  replayGuard: HumanRelayReplayGuard;
}): Promise<OpenedHumanRelayIntent> {
  const capsule = parseIntentCapsule(input.capsule);
  const nowMs = timestamp(input.nowMs, 'humanRelay.nowMs');
  if (nowMs >= capsule.expiresAtMs) throw new Error('Human relay intent capsule expired');
  const expected = input.expectedTarget;
  if (capsule.target.companionId !== expected.companionId
    || capsule.source.companionId !== expected.peerCompanionId
    || capsule.target.dyadId !== expected.dyadId
    || capsule.target.channelId !== expected.channelId
    || JSON.stringify(capsule.target.participantCompanionIds)
      !== JSON.stringify(expected.participantCompanionIds)) {
    throw new Error('Human relay intent capsule destination binding mismatch');
  }
  const material = intentBindingMaterial(capsule);
  const targetBinding = intentBinding(material, 'target_intake');
  const targetAuthorization = validateDecision(await input.targetGate(targetBinding), targetBinding);
  if (!await input.replayGuard.claim('intent', capsule.capsuleId, capsule.digest)) {
    throw new Error('Human relay intent capsule replay rejected');
  }
  return {
    delivery: 'queued',
    capsuleId: capsule.capsuleId,
    capsuleDigest: capsule.digest,
    intent: capsule.intent,
    sourceCompanionId: capsule.source.companionId,
    requestingHumanParticipantId: capsule.source.humanParticipantId,
    targetCompanionId: capsule.target.companionId,
    dyadId: capsule.target.dyadId,
    expiresAtMs: capsule.expiresAtMs,
    sourceAuthorization: capsule.sourceAuthorization,
    targetAuthorization,
  };
}

export async function createHumanRelayResponse(input: {
  request: unknown;
  responseId?: string;
  disposition: HumanRelayDisposition;
  content?: string;
  response: HumanRelayResponseSource;
  issuedAtMs: number;
  expiresAtMs: number;
  targetEgressGate?: HumanRelayBoundaryGate;
}): Promise<HumanRelayResponseCreationResult> {
  const request = parseIntentCapsule(input.request);
  if (input.disposition === 'ignore' || input.disposition === 'private') {
    if (input.content !== undefined) {
      throw new Error('Ignored or private human relay responses cannot carry return content');
    }
    return { disposition: input.disposition, delivery: 'withheld' };
  }
  if (!input.targetEgressGate) {
    throw new Error('Human relay response has no target disclosure authorization');
  }
  if (!input.responseId) throw new Error('Human relay returnable response requires a responseId');
  const responseId = requireUuid(input.responseId, 'humanRelay.responseId');
  const content = exactText(input.content, 'humanRelay.content');
  const response: HumanRelayResponseSource = {
    companionId: requireUuid(input.response.companionId, 'humanRelay.response.companionId'),
    dyadId: requireUuid(input.response.dyadId, 'humanRelay.response.dyadId'),
    channelId: exactString(input.response.channelId, 'humanRelay.response.channelId'),
    turnId: exactString(input.response.turnId, 'humanRelay.response.turnId'),
    requestId: exactString(input.response.requestId, 'humanRelay.response.requestId'),
  };
  if (response.companionId !== request.target.companionId
    || response.dyadId !== request.target.dyadId
    || response.channelId !== request.target.channelId) {
    throw new Error('Human relay response source does not match the target dyad');
  }
  const issuedAtMs = timestamp(input.issuedAtMs, 'humanRelay.issuedAtMs');
  const expiresAtMs = timestamp(input.expiresAtMs, 'humanRelay.expiresAtMs');
  validateWindow(issuedAtMs, expiresAtMs);
  if (issuedAtMs >= request.expiresAtMs || expiresAtMs > request.expiresAtMs) {
    throw new Error('Human relay response cannot outlive its request authority');
  }
  const destination: HumanRelayResponseDestination = {
    companionId: request.source.companionId,
    channelId: request.source.channelId,
    humanParticipantId: request.source.humanParticipantId,
    humanContactId: request.source.humanContactId,
  };
  const material = responseBindingMaterial({
    responseId,
    requestCapsuleId: request.capsuleId,
    requestDigest: request.digest,
    disposition: input.disposition,
    content,
    contentHash: hash(content),
    response,
    destination,
    issuedAtMs,
    expiresAtMs,
  });
  const binding = responseBinding(material, 'target_egress');
  const targetAuthorization = validateDecision(await input.targetEgressGate(binding), binding);
  const digest = hash({ ...material, bindingHash: binding.bindingHash, targetAuthorization });
  return {
    disposition: input.disposition,
    delivery: 'queued',
    capsule: { ...material, bindingHash: binding.bindingHash, targetAuthorization, digest },
  };
}

export async function openHumanRelayResponseCapsule(input: {
  capsule: unknown;
  request: unknown;
  nowMs: number;
  expectedDestination: HumanRelayResponseDestination;
  sourceIntakeGate: HumanRelayBoundaryGate;
  replayGuard: HumanRelayReplayGuard;
}) {
  const capsule = parseResponseCapsule(input.capsule);
  const request = parseIntentCapsule(input.request);
  const nowMs = timestamp(input.nowMs, 'humanRelay.nowMs');
  if (nowMs >= capsule.expiresAtMs) throw new Error('Human relay response capsule expired');
  if (capsule.requestCapsuleId !== request.capsuleId
    || capsule.requestDigest !== request.digest
    || capsule.response.companionId !== request.target.companionId
    || capsule.response.dyadId !== request.target.dyadId
    || capsule.response.channelId !== request.target.channelId) {
    throw new Error('Human relay response request lineage mismatch');
  }
  if (JSON.stringify(capsule.destination) !== JSON.stringify(input.expectedDestination)) {
    throw new Error('Human relay response destination binding mismatch');
  }
  const material = responseBindingMaterial(capsule);
  const sourceBinding = responseBinding(material, 'source_intake');
  const sourceAuthorization = validateDecision(await input.sourceIntakeGate(sourceBinding), sourceBinding);
  if (!await input.replayGuard.claim('response', capsule.responseId, capsule.digest)) {
    throw new Error('Human relay response capsule replay rejected');
  }
  return {
    disposition: capsule.disposition,
    content: capsule.content,
    destinationChannelId: capsule.destination.channelId,
    destinationHumanParticipantId: capsule.destination.humanParticipantId,
    requestCapsuleId: capsule.requestCapsuleId,
    requestDigest: capsule.requestDigest,
    responseDigest: capsule.digest,
    targetAuthorization: capsule.targetAuthorization,
    sourceAuthorization,
  } as const;
}
