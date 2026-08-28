import { createHash } from 'node:crypto';

import {
  ICP_AUTONOMY_REASON_CODES,
  parseIcpInitiationPermit,
  parseIcpDyad,
  type IcpDyad,
  type IcpAutonomyReasonCode,
  type IcpInitiationPermit,
} from '../../shared/contracts/icp-autonomy.js';
import {
  assertNoUnknownKeys,
  isRecord,
} from '../../shared/utils/types.js';
import { requireUuid } from '../../shared/utils/uuid.js';
import {
  parseIcpInitiationCandidateSharedMetadata,
  type IcpInitiationCandidateSharedMetadata,
} from './initiation-candidate.js';

export type IcpLocalPolicyRole = 'sender' | 'recipient';

interface IcpLocalPolicyRequestBase {
  role: IcpLocalPolicyRole;
  senderCompanionId: string;
  recipientCompanionId: string;
  channelId: string;
  nowMs: number;
}

export type IcpLocalPolicyInspectParams =
  | (IcpLocalPolicyRequestBase & {
      role: 'sender';
      candidate: IcpInitiationCandidateSharedMetadata;
      relationshipPressure: number;
    })
  | (IcpLocalPolicyRequestBase & {
      role: 'recipient';
      dyad?: undefined;
    })
  | (IcpLocalPolicyRequestBase & {
      role: 'sender';
      dyad: IcpDyad;
      peerContactId?: string;
    })
  | (IcpLocalPolicyRequestBase & {
      role: 'recipient';
      dyad: IcpDyad;
    });

export type IcpLocalPolicyInspectResult =
  | { role: IcpLocalPolicyRole; ready: false }
  | {
      role: 'recipient';
      ready: true;
      canonicalPeerContact: boolean;
      trustAllows: boolean;
      blocksPeer: boolean;
    }
  | {
      role: 'sender';
      ready: true;
      canonicalPeerContact: boolean;
      trustAllows: boolean;
      blocksPeer: boolean;
      /** @deprecated Accepted for mixed-version RPC compatibility and ignored by the gateway. */
      quietHours: boolean;
      provenanceFresh: boolean;
      socialPressureAllows: boolean;
      chargeAllows: boolean;
      fatigueAllows: boolean;
      costAllows: boolean;
    };

export type IcpLocalPolicyAcquireParams = IcpLocalPolicyRequestBase & {
  phase: 'issue' | 'consume';
  payloadDigest: string;
  nonce: string;
  expiresAtMs: number;
  relationshipPressure?: number;
  candidate?: IcpInitiationCandidateSharedMetadata;
  permit?: IcpInitiationPermit;
  rootInitiationId?: string;
};

export type IcpLocalPolicyAcquireResult =
  | { acquired: true; holdId: string; expiresAtMs: number }
  | { acquired: false; reasonCode: IcpAutonomyReasonCode };

export interface IcpLocalPolicyReleaseParams {
  holdId: string;
  payloadDigest: string;
  nonce: string;
}

export interface IcpLocalPolicyReleaseResult {
  released: true;
}

/** Canonical exact-operation digest shared by the gateway coordinator and local authority. */
export function deriveIcpLocalPolicyAcquirePayloadDigest(
  input: Omit<IcpLocalPolicyAcquireParams, 'payloadDigest'>,
): string {
  const canonical = {
    role: input.role,
    phase: input.phase,
    senderCompanionId: input.senderCompanionId,
    recipientCompanionId: input.recipientCompanionId,
    channelId: input.channelId,
    nowMs: input.nowMs,
    expiresAtMs: input.expiresAtMs,
    nonce: input.nonce,
    relationshipPressure: input.relationshipPressure ?? null,
    candidate: input.candidate ?? null,
    permit: input.permit ?? null,
    rootInitiationId: input.rootInitiationId ?? null,
  };
  return createHash('sha256')
    .update(JSON.stringify(['icp-local-policy-acquire-v1', canonical]))
    .digest('hex');
}

const INSPECT_KEYS = [
  'role', 'senderCompanionId', 'recipientCompanionId', 'candidate', 'channelId', 'nowMs',
  'relationshipPressure', 'dyad', 'peerContactId',
] as const;
const ACQUIRE_KEYS = [
  'role', 'phase', 'senderCompanionId', 'recipientCompanionId', 'candidate', 'permit',
  'rootInitiationId', 'channelId', 'payloadDigest', 'nonce', 'nowMs', 'expiresAtMs',
  'relationshipPressure',
] as const;
const RELEASE_KEYS = ['holdId', 'payloadDigest', 'nonce'] as const;
const COMMON_RESULT_KEYS = [
  'role', 'ready', 'canonicalPeerContact', 'trustAllows', 'blocksPeer',
] as const;
const SENDER_RESULT_KEYS = [
  ...COMMON_RESULT_KEYS, 'quietHours', 'provenanceFresh', 'socialPressureAllows',
  'chargeAllows', 'fatigueAllows', 'costAllows',
] as const;

function requireRole(value: unknown, field: string): IcpLocalPolicyRole {
  if (value !== 'sender' && value !== 'recipient') {
    throw new Error(`${field} must be sender or recipient`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer timestamp`);
  }
  return value;
}

function requireTrimmedString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw new Error(`${field} must be a non-empty trimmed string`);
  }
  return value;
}

function requireDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error('ICP local policy payloadDigest must be a lowercase SHA-256 digest');
  }
  return value;
}

function requireRelationshipPressure(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
    || !Number.isSafeInteger(Math.ceil(value))) {
    throw new Error('ICP local policy relationshipPressure must be a bounded non-negative number');
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

function parseRequestBase(value: Record<string, unknown>): IcpLocalPolicyRequestBase {
  const role = requireRole(value.role, 'ICP local policy role');
  const senderCompanionId = requireUuid(
    value.senderCompanionId,
    'ICP local policy senderCompanionId',
  );
  const recipientCompanionId = requireUuid(
    value.recipientCompanionId,
    'ICP local policy recipientCompanionId',
  );
  if (senderCompanionId === recipientCompanionId) {
    throw new Error('ICP local policy requires different companions');
  }
  return {
    role,
    senderCompanionId,
    recipientCompanionId,
    channelId: requireTrimmedString(value.channelId, 'ICP local policy channelId'),
    nowMs: requireTimestamp(value.nowMs, 'ICP local policy nowMs'),
  };
}

export function parseIcpLocalPolicyInspectParams(value: unknown): IcpLocalPolicyInspectParams {
  if (!isRecord(value)) throw new Error('ICP local policy inspect params must be an object');
  assertNoUnknownKeys(value, INSPECT_KEYS, 'ICP local policy inspect params');
  const base = parseRequestBase(value);
  if (value.dyad !== undefined) {
    if (value.candidate !== undefined || value.relationshipPressure !== undefined) {
      throw new Error('ICP dyad policy inspection must not include initiation candidate facts');
    }
    const dyad = parseIcpDyad(value.dyad);
    if (dyad.status !== 'open' || dyad.channelId !== base.channelId
      || !dyad.participantCompanionIds.includes(base.senderCompanionId)
      || !dyad.participantCompanionIds.includes(base.recipientCompanionId)) {
      throw new Error('ICP dyad policy inspection binding mismatch');
    }
    if (base.role === 'sender') {
      const peerContactId = value.peerContactId === undefined
        ? undefined
        : requireTrimmedString(value.peerContactId, 'peerContactId');
      return { ...base, role: 'sender', dyad, ...(peerContactId ? { peerContactId } : {}) };
    }
    if (value.peerContactId !== undefined) {
      throw new Error('ICP recipient dyad inspection must not include peerContactId');
    }
    return { ...base, role: 'recipient', dyad };
  }
  if (base.role === 'sender') {
    const candidate = parseIcpInitiationCandidateSharedMetadata(value.candidate);
    if (candidate.localCompanionId !== base.senderCompanionId
      || candidate.peerCompanionId !== base.recipientCompanionId) {
      throw new Error('ICP local policy sender inspection candidate participant mismatch');
    }
    return {
      ...base,
      role: 'sender',
      candidate,
      relationshipPressure: requireRelationshipPressure(value.relationshipPressure),
    };
  }
  if (value.candidate !== undefined || value.relationshipPressure !== undefined
    || value.peerContactId !== undefined) {
    throw new Error('ICP local policy recipient inspection must not include candidate or pressure');
  }
  return { ...base, role: 'recipient' };
}

export function parseIcpLocalPolicyInspectResult(value: unknown): IcpLocalPolicyInspectResult {
  if (!isRecord(value)) throw new Error('ICP local policy inspect result must be an object');
  const role = requireRole(value.role, 'ICP local policy result role');
  const ready = requireBoolean(value.ready, 'ICP local policy result ready');
  const keys = role === 'sender' ? SENDER_RESULT_KEYS : COMMON_RESULT_KEYS;
  assertNoUnknownKeys(value, keys, 'ICP local policy inspect result');
  if (!ready) {
    if (Object.keys(value).length !== 2) {
      throw new Error('Unready ICP local policy result must not include policy facts');
    }
    return { role, ready: false };
  }
  const common = {
    canonicalPeerContact: requireBoolean(value.canonicalPeerContact, 'canonicalPeerContact'),
    trustAllows: requireBoolean(value.trustAllows, 'trustAllows'),
    blocksPeer: requireBoolean(value.blocksPeer, 'blocksPeer'),
  };
  if (role === 'recipient') return { role, ready: true, ...common };
  return {
    role,
    ready: true,
    ...common,
    quietHours: requireBoolean(value.quietHours, 'quietHours'),
    provenanceFresh: requireBoolean(value.provenanceFresh, 'provenanceFresh'),
    socialPressureAllows: requireBoolean(value.socialPressureAllows, 'socialPressureAllows'),
    chargeAllows: requireBoolean(value.chargeAllows, 'chargeAllows'),
    fatigueAllows: requireBoolean(value.fatigueAllows, 'fatigueAllows'),
    costAllows: requireBoolean(value.costAllows, 'costAllows'),
  };
}

export function parseIcpLocalPolicyAcquireParams(value: unknown): IcpLocalPolicyAcquireParams {
  if (!isRecord(value)) throw new Error('ICP local policy acquire params must be an object');
  assertNoUnknownKeys(value, ACQUIRE_KEYS, 'ICP local policy acquire params');
  const base = parseRequestBase(value);
  if (value.phase !== 'issue' && value.phase !== 'consume') {
    throw new Error('ICP local policy acquire phase must be issue or consume');
  }
  const expiresAtMs = requireTimestamp(value.expiresAtMs, 'ICP local policy expiresAtMs');
  if (expiresAtMs <= base.nowMs) {
    throw new Error('ICP local policy expiresAtMs must be later than nowMs');
  }
  const common = {
    ...base,
    phase: value.phase,
    payloadDigest: requireDigest(value.payloadDigest),
    nonce: requireUuid(value.nonce, 'ICP local policy nonce'),
    expiresAtMs,
  };
  const relationshipPressure = base.role === 'sender'
    ? requireRelationshipPressure(value.relationshipPressure)
    : undefined;
  if (base.role === 'recipient' && value.relationshipPressure !== undefined) {
    throw new Error('ICP local policy recipient acquire must not include pressure');
  }
  if (value.phase === 'issue') {
    if (value.permit !== undefined || value.rootInitiationId !== undefined) {
      throw new Error('ICP local policy issue acquire must not include permit fields');
    }
    const candidate = parseIcpInitiationCandidateSharedMetadata(value.candidate);
    if (candidate.localCompanionId !== base.senderCompanionId
      || candidate.peerCompanionId !== base.recipientCompanionId) {
      throw new Error('ICP local policy issue candidate participant mismatch');
    }
    return {
      ...common,
      phase: 'issue',
      candidate,
      ...(relationshipPressure !== undefined ? { relationshipPressure } : {}),
    };
  }
  if (value.candidate !== undefined) {
    throw new Error('ICP local policy consume acquire must not include candidate');
  }
  const permit = parseIcpInitiationPermit(value.permit);
  const rootInitiationId = requireUuid(
    value.rootInitiationId,
    'ICP local policy rootInitiationId',
  );
  if (permit.senderCompanionId !== base.senderCompanionId
    || permit.recipientCompanionId !== base.recipientCompanionId
    || permit.channelId !== base.channelId) {
    throw new Error('ICP local policy consume permit participant/channel mismatch');
  }
  return {
    ...common,
    phase: 'consume',
    permit,
    rootInitiationId,
    ...(relationshipPressure !== undefined ? { relationshipPressure } : {}),
  };
}

export function parseIcpLocalPolicyAcquireResult(value: unknown): IcpLocalPolicyAcquireResult {
  if (!isRecord(value)) throw new Error('ICP local policy acquire result must be an object');
  if (value.acquired === true) {
    assertNoUnknownKeys(value, ['acquired', 'holdId', 'expiresAtMs'], 'ICP local policy acquire result');
    return {
      acquired: true,
      holdId: requireUuid(value.holdId, 'ICP local policy holdId'),
      expiresAtMs: requireTimestamp(value.expiresAtMs, 'ICP local policy hold expiresAtMs'),
    };
  }
  if (value.acquired !== false) throw new Error('ICP local policy acquired must be a boolean');
  assertNoUnknownKeys(value, ['acquired', 'reasonCode'], 'ICP local policy acquire result');
  if (typeof value.reasonCode !== 'string'
    || !ICP_AUTONOMY_REASON_CODES.includes(value.reasonCode as IcpAutonomyReasonCode)) {
    throw new Error('ICP local policy acquire reasonCode is invalid');
  }
  return { acquired: false, reasonCode: value.reasonCode as IcpAutonomyReasonCode };
}

export function parseIcpLocalPolicyReleaseParams(value: unknown): IcpLocalPolicyReleaseParams {
  if (!isRecord(value)) throw new Error('ICP local policy release params must be an object');
  assertNoUnknownKeys(value, RELEASE_KEYS, 'ICP local policy release params');
  return {
    holdId: requireUuid(value.holdId, 'ICP local policy holdId'),
    payloadDigest: requireDigest(value.payloadDigest),
    nonce: requireUuid(value.nonce, 'ICP local policy nonce'),
  };
}

export function parseIcpLocalPolicyReleaseResult(value: unknown): IcpLocalPolicyReleaseResult {
  if (!isRecord(value)) throw new Error('ICP local policy release result must be an object');
  assertNoUnknownKeys(value, ['released'], 'ICP local policy release result');
  if (value.released !== true) throw new Error('ICP local policy release result must be true');
  return { released: true };
}
