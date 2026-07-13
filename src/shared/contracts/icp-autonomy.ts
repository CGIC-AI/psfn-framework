import { parseCompanionChannelId } from './companion-channels.js';
import {
  assertNoUnknownKeys,
  isRecord,
  isRfc4122Uuid,
} from '../utils/types.js';

// Content-free cross-companion control-plane vocabulary. Private motivation
// stays in core/icp/initiation-candidate.ts and never enters these contracts.

export const MAX_ICP_AVAILABILITY_LEASE_TTL_MS = 24 * 60 * 60_000;
export const MAX_ICP_PERMIT_TTL_MS = 15 * 60_000;

export const ICP_AVAILABILITY_STATES = [
  'available',
  'open_to_chat',
  'busy',
  'resting',
  'do_not_disturb',
] as const;
export type IcpAvailabilityState = typeof ICP_AVAILABILITY_STATES[number];

export const ICP_AVAILABILITY_SOURCES = ['companion', 'operator', 'runtime'] as const;
export type IcpAvailabilitySource = typeof ICP_AVAILABILITY_SOURCES[number];

export const ICP_INITIATION_SOURCES = [
  'free_time',
  'weighted_thought',
  'intention',
  'foreground',
] as const;
export type IcpInitiationSource = typeof ICP_INITIATION_SOURCES[number];

export const ICP_CONVERSATION_STATUSES = [
  'invited',
  'active',
  'declined',
  'deferred',
  'ended',
  'suppressed',
] as const;
export type IcpConversationStatus = typeof ICP_CONVERSATION_STATUSES[number];

export const ICP_PERMIT_STATUSES = ['issued', 'consumed', 'revoked', 'expired'] as const;
export type IcpPermitStatus = typeof ICP_PERMIT_STATUSES[number];

/** Stable machine-readable reasons shared by deterministic policy and stores. */
export const ICP_AUTONOMY_REASON_CODES = [
  'peer_offline',
  'availability_missing',
  'availability_expired',
  'peer_busy',
  'peer_resting',
  'peer_do_not_disturb',
  'quiet_hours',
  'charge_pressure',
  'fatigue_exhausted',
  'cost_hard_stop',
  'peer_blocked',
  'invalid_identity',
  'unknown_participant',
  'malformed_channel',
  'channel_mismatch',
  'stale_provenance',
  'recursive_trigger',
  'policy_denied',
  'invitation_outstanding',
  'candidate_expired',
  'candidate_declined',
  'candidate_deferred',
  'candidate_cancelled',
  'permit_expired',
  'permit_revoked',
  'permit_replayed',
  'permit_mismatch',
  'conversation_declined',
  'conversation_deferred',
  'conversation_ended',
  'conversation_suppressed',
  'operator_cancelled',
  'delivery_failed',
] as const;
export type IcpAutonomyReasonCode = typeof ICP_AUTONOMY_REASON_CODES[number];

export interface IcpAvailabilityLease {
  companionId: string;
  state: IcpAvailabilityState;
  issuedAtMs: number;
  expiresAtMs: number;
  source: IcpAvailabilitySource;
  revision: number;
}

export interface IcpConversationEpisode {
  /** Ephemeral autonomous episode; never a transcript/session key. */
  conversationId: string;
  /** Durable ordinary-channel identity that survives episode boundaries. */
  channelId: string;
  participantCompanionIds: string[];
  rootInitiationId: string;
  initiatedByCompanionId: string;
  initiationSource: IcpInitiationSource;
  provenanceRef: string;
  openedAtMs: number;
  lastActivityAtMs: number;
  status: IcpConversationStatus;
  closeReasonCode?: IcpAutonomyReasonCode;
  revision: number;
}

export interface IcpInitiationPermit {
  permitId: string;
  candidateId: string;
  conversationId: string;
  senderCompanionId: string;
  recipientCompanionId: string;
  channelId: string;
  provenanceRef: string;
  issuedAtMs: number;
  expiresAtMs: number;
  status: IcpPermitStatus;
  consumedAtMs?: number;
  revokedAtMs?: number;
  reasonCode?: IcpAutonomyReasonCode;
  revision: number;
}

export interface IcpConversationCorrelation {
  conversationId: string;
  rootInitiationId: string;
  initiatedByCompanionId: string;
  localCompanionId: string;
  peerCompanionId: string;
  peerContactId: string;
  channelId: string;
  turnId: string;
  messageId: string;
  requestId: string;
  chargeLane: 'interactive' | 'companion_social';
  surface: 'companion_dm' | 'companion_room';
  costPurpose: 'conversation_turn' | 'tool' | 'summary' | 'extraction' | 'sidecar';
  costOriginStage: 'initiation' | 'reply' | 'post_turn' | 'maintenance';
  fatigueDecision: 'allow' | 'allow_overcharge' | 'suppress' | 'not_evaluated';
  fatigueReasonCode?: IcpAutonomyReasonCode;
}

export type RedactedIcpInitiationPermit = Omit<IcpInitiationPermit, 'permitId'> & {
  permitId: '[redacted]';
};

interface CurrentValidationOptions {
  nowMs?: number;
  requireCurrent?: boolean;
}

export interface IcpEpisodeValidationOptions {
  knownCompanionIds?: ReadonlySet<string>;
}

export interface IcpPermitValidationOptions {
  nowMs?: number;
  requireUsable?: boolean;
}

const AVAILABILITY_KEYS = [
  'companionId', 'state', 'issuedAtMs', 'expiresAtMs', 'source', 'revision',
] as const;
const EPISODE_KEYS = [
  'conversationId', 'channelId', 'participantCompanionIds', 'rootInitiationId',
  'initiatedByCompanionId', 'initiationSource', 'provenanceRef', 'openedAtMs',
  'lastActivityAtMs', 'status', 'closeReasonCode', 'revision',
] as const;
const PERMIT_KEYS = [
  'permitId', 'candidateId', 'conversationId', 'senderCompanionId',
  'recipientCompanionId', 'channelId', 'provenanceRef', 'issuedAtMs',
  'expiresAtMs', 'status', 'consumedAtMs', 'revokedAtMs', 'reasonCode', 'revision',
] as const;
const CORRELATION_KEYS = [
  'conversationId', 'rootInitiationId', 'initiatedByCompanionId',
  'localCompanionId', 'peerCompanionId', 'peerContactId', 'channelId',
  'turnId', 'messageId', 'requestId', 'chargeLane', 'surface', 'costPurpose',
  'costOriginStage', 'fatigueDecision', 'fatigueReasonCode',
] as const;

const CONVERSATION_TRANSITIONS: Readonly<Record<IcpConversationStatus, readonly IcpConversationStatus[]>> = {
  invited: ['active', 'declined', 'deferred', 'ended', 'suppressed'],
  active: ['ended', 'suppressed'],
  deferred: ['invited', 'ended', 'suppressed'],
  declined: [],
  ended: [],
  suppressed: [],
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireUuid(value: unknown, field: string): string {
  if (!isRfc4122Uuid(value)) {
    throw new Error(`${field} must be a lowercase RFC-4122 UUID`);
  }
  return value;
}

function requireString(value: unknown, field: string, maxLength = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} must be a non-empty trimmed string`);
  }
  if (value.length > maxLength) {
    throw new Error(`${field} must be ${maxLength} characters or fewer`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer timestamp`);
  }
  return value;
}

function requireRevision(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function requireEnum<T extends string>(
  value: unknown,
  values: readonly T[],
  field: string,
): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new Error(`${field} must be one of: ${values.join(', ')}`);
  }
  return value as T;
}

function requireOptionalReason(value: unknown, field: string): IcpAutonomyReasonCode | undefined {
  return value === undefined
    ? undefined
    : requireEnum(value, ICP_AUTONOMY_REASON_CODES, field);
}

function requireOptionalTimestamp(value: unknown, field: string): number | undefined {
  return value === undefined ? undefined : requireTimestamp(value, field);
}

function requireUuidArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error(`${field} must contain at least two companion UUIDs`);
  }
  const participants = value.map((entry, index) => requireUuid(entry, `${field}[${index}]`));
  if (new Set(participants).size !== participants.length) {
    throw new Error(`${field} must not contain duplicates`);
  }
  const sorted = [...participants].sort();
  if (participants.some((participant, index) => participant !== sorted[index])) {
    throw new Error(`${field} must be in canonical sorted order`);
  }
  return participants;
}

function assertChannelPairBinding(
  channelId: string,
  firstCompanionId: string,
  secondCompanionId: string,
  label: string,
): 'dm' | 'room' {
  const parsed = parseCompanionChannelId(channelId);
  if (!parsed) {
    throw new Error(`${label}.channelId must be a canonical companion channel`);
  }
  if (firstCompanionId === secondCompanionId) {
    throw new Error(`${label} must bind two distinct companions`);
  }
  if (parsed.kind === 'dm') {
    const expected = [firstCompanionId, secondCompanionId].sort();
    if (parsed.participants[0] !== expected[0] || parsed.participants[1] !== expected[1]) {
      throw new Error(`${label} must bind exactly to the DM channel participants`);
    }
  }
  return parsed.kind;
}

export function parseIcpAvailabilityLease(
  value: unknown,
  options: CurrentValidationOptions = {},
): IcpAvailabilityLease {
  const raw = requireRecord(value, 'ICP availability lease');
  assertNoUnknownKeys(raw, AVAILABILITY_KEYS, 'ICP availability lease');
  const issuedAtMs = requireTimestamp(raw.issuedAtMs, 'ICP availability lease.issuedAtMs');
  const expiresAtMs = requireTimestamp(raw.expiresAtMs, 'ICP availability lease.expiresAtMs');
  if (expiresAtMs <= issuedAtMs) {
    throw new Error('ICP availability lease.expiresAtMs must be later than issuedAtMs');
  }
  if (expiresAtMs - issuedAtMs > MAX_ICP_AVAILABILITY_LEASE_TTL_MS) {
    throw new Error(`ICP availability lease exceeds maximum TTL ${MAX_ICP_AVAILABILITY_LEASE_TTL_MS}ms`);
  }
  if (options.requireCurrent === true) {
    const nowMs = requireTimestamp(options.nowMs, 'ICP availability validation nowMs');
    if (issuedAtMs > nowMs) throw new Error('ICP availability lease is not yet valid');
    if (expiresAtMs <= nowMs) throw new Error('ICP availability lease is expired');
  }
  return {
    companionId: requireUuid(raw.companionId, 'ICP availability lease.companionId'),
    state: requireEnum(raw.state, ICP_AVAILABILITY_STATES, 'ICP availability lease.state'),
    issuedAtMs,
    expiresAtMs,
    source: requireEnum(raw.source, ICP_AVAILABILITY_SOURCES, 'ICP availability lease.source'),
    revision: requireRevision(raw.revision, 'ICP availability lease.revision'),
  };
}

export function parseIcpConversationEpisode(
  value: unknown,
  options: IcpEpisodeValidationOptions = {},
): IcpConversationEpisode {
  const raw = requireRecord(value, 'ICP conversation episode');
  assertNoUnknownKeys(raw, EPISODE_KEYS, 'ICP conversation episode');
  const channelId = requireString(raw.channelId, 'ICP conversation episode.channelId');
  const participants = requireUuidArray(
    raw.participantCompanionIds,
    'ICP conversation episode.participantCompanionIds',
  );
  const parsedChannel = parseCompanionChannelId(channelId);
  if (!parsedChannel) {
    throw new Error('ICP conversation episode.channelId must be a canonical companion channel');
  }
  if (parsedChannel.kind === 'dm' && (
    participants.length !== 2
    || participants[0] !== parsedChannel.participants[0]
    || participants[1] !== parsedChannel.participants[1]
  )) {
    throw new Error('ICP conversation participants must exactly match the DM channel participants');
  }
  if (options.knownCompanionIds) {
    for (const participant of participants) {
      if (!options.knownCompanionIds.has(participant)) {
        throw new Error(`ICP conversation has unknown participant ${participant}`);
      }
    }
  }
  const initiatedByCompanionId = requireUuid(
    raw.initiatedByCompanionId,
    'ICP conversation episode.initiatedByCompanionId',
  );
  if (!participants.includes(initiatedByCompanionId)) {
    throw new Error('ICP conversation initiatedByCompanionId must be a participant');
  }
  const openedAtMs = requireTimestamp(raw.openedAtMs, 'ICP conversation episode.openedAtMs');
  const lastActivityAtMs = requireTimestamp(
    raw.lastActivityAtMs,
    'ICP conversation episode.lastActivityAtMs',
  );
  if (lastActivityAtMs < openedAtMs) {
    throw new Error('ICP conversation lastActivityAtMs must not precede openedAtMs');
  }
  const closeReasonCode = requireOptionalReason(
    raw.closeReasonCode,
    'ICP conversation episode.closeReasonCode',
  );
  return {
    conversationId: requireUuid(raw.conversationId, 'ICP conversation episode.conversationId'),
    channelId,
    participantCompanionIds: participants,
    rootInitiationId: requireUuid(
      raw.rootInitiationId,
      'ICP conversation episode.rootInitiationId',
    ),
    initiatedByCompanionId,
    initiationSource: requireEnum(
      raw.initiationSource,
      ICP_INITIATION_SOURCES,
      'ICP conversation episode.initiationSource',
    ),
    provenanceRef: requireString(
      raw.provenanceRef,
      'ICP conversation episode.provenanceRef',
      1_024,
    ),
    openedAtMs,
    lastActivityAtMs,
    status: requireEnum(raw.status, ICP_CONVERSATION_STATUSES, 'ICP conversation episode.status'),
    ...(closeReasonCode !== undefined ? { closeReasonCode } : {}),
    revision: requireRevision(raw.revision, 'ICP conversation episode.revision'),
  };
}

export function assertIcpConversationStatusTransition(
  from: IcpConversationStatus,
  to: IcpConversationStatus,
): void {
  if (!CONVERSATION_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid ICP conversation status transition: ${from} -> ${to}`);
  }
}

export function parseIcpInitiationPermit(
  value: unknown,
  options: IcpPermitValidationOptions = {},
): IcpInitiationPermit {
  const raw = requireRecord(value, 'ICP initiation permit');
  assertNoUnknownKeys(raw, PERMIT_KEYS, 'ICP initiation permit');
  const senderCompanionId = requireUuid(
    raw.senderCompanionId,
    'ICP initiation permit.senderCompanionId',
  );
  const recipientCompanionId = requireUuid(
    raw.recipientCompanionId,
    'ICP initiation permit.recipientCompanionId',
  );
  const channelId = requireString(raw.channelId, 'ICP initiation permit.channelId');
  assertChannelPairBinding(channelId, senderCompanionId, recipientCompanionId, 'ICP initiation permit');
  const issuedAtMs = requireTimestamp(raw.issuedAtMs, 'ICP initiation permit.issuedAtMs');
  const expiresAtMs = requireTimestamp(raw.expiresAtMs, 'ICP initiation permit.expiresAtMs');
  if (expiresAtMs <= issuedAtMs) {
    throw new Error('ICP initiation permit.expiresAtMs must be later than issuedAtMs');
  }
  if (expiresAtMs - issuedAtMs > MAX_ICP_PERMIT_TTL_MS) {
    throw new Error(`ICP initiation permit exceeds maximum TTL ${MAX_ICP_PERMIT_TTL_MS}ms`);
  }
  const status = requireEnum(raw.status, ICP_PERMIT_STATUSES, 'ICP initiation permit.status');
  const consumedAtMs = requireOptionalTimestamp(
    raw.consumedAtMs,
    'ICP initiation permit.consumedAtMs',
  );
  const revokedAtMs = requireOptionalTimestamp(raw.revokedAtMs, 'ICP initiation permit.revokedAtMs');
  if (status === 'consumed' && consumedAtMs === undefined) {
    throw new Error('Consumed ICP initiation permit requires consumedAtMs');
  }
  if (status !== 'consumed' && consumedAtMs !== undefined) {
    throw new Error('Only a consumed ICP initiation permit may carry consumedAtMs');
  }
  if (status === 'revoked' && revokedAtMs === undefined) {
    throw new Error('Revoked ICP initiation permit requires revokedAtMs');
  }
  if (status !== 'revoked' && revokedAtMs !== undefined) {
    throw new Error('Only a revoked ICP initiation permit may carry revokedAtMs');
  }
  if (options.requireUsable === true) {
    const nowMs = requireTimestamp(options.nowMs, 'ICP permit validation nowMs');
    if (status !== 'issued') throw new Error(`ICP initiation permit is not usable: ${status}`);
    if (issuedAtMs > nowMs) throw new Error('ICP initiation permit is not yet valid');
    if (expiresAtMs <= nowMs) throw new Error('ICP initiation permit is expired');
  }
  const reasonCode = requireOptionalReason(raw.reasonCode, 'ICP initiation permit.reasonCode');
  return {
    permitId: requireUuid(raw.permitId, 'ICP initiation permit.permitId'),
    candidateId: requireUuid(raw.candidateId, 'ICP initiation permit.candidateId'),
    conversationId: requireUuid(raw.conversationId, 'ICP initiation permit.conversationId'),
    senderCompanionId,
    recipientCompanionId,
    channelId,
    provenanceRef: requireString(raw.provenanceRef, 'ICP initiation permit.provenanceRef', 1_024),
    issuedAtMs,
    expiresAtMs,
    status,
    ...(consumedAtMs !== undefined ? { consumedAtMs } : {}),
    ...(revokedAtMs !== undefined ? { revokedAtMs } : {}),
    ...(reasonCode !== undefined ? { reasonCode } : {}),
    revision: requireRevision(raw.revision, 'ICP initiation permit.revision'),
  };
}

export function redactIcpInitiationPermit(
  permit: IcpInitiationPermit,
): RedactedIcpInitiationPermit {
  return { ...permit, permitId: '[redacted]' };
}

export function parseIcpConversationCorrelation(value: unknown): IcpConversationCorrelation {
  const raw = requireRecord(value, 'ICP conversation correlation');
  assertNoUnknownKeys(raw, CORRELATION_KEYS, 'ICP conversation correlation');
  const localCompanionId = requireUuid(
    raw.localCompanionId,
    'ICP conversation correlation.localCompanionId',
  );
  const peerCompanionId = requireUuid(
    raw.peerCompanionId,
    'ICP conversation correlation.peerCompanionId',
  );
  const channelId = requireString(raw.channelId, 'ICP conversation correlation.channelId');
  const channelKind = assertChannelPairBinding(
    channelId,
    localCompanionId,
    peerCompanionId,
    'ICP conversation correlation',
  );
  const surface = requireEnum(
    raw.surface,
    ['companion_dm', 'companion_room'] as const,
    'ICP conversation correlation.surface',
  );
  if ((channelKind === 'dm' && surface !== 'companion_dm')
    || (channelKind === 'room' && surface !== 'companion_room')) {
    throw new Error('ICP conversation correlation.surface does not match channelId');
  }
  const fatigueReasonCode = requireOptionalReason(
    raw.fatigueReasonCode,
    'ICP conversation correlation.fatigueReasonCode',
  );
  return {
    conversationId: requireUuid(raw.conversationId, 'ICP conversation correlation.conversationId'),
    rootInitiationId: requireUuid(
      raw.rootInitiationId,
      'ICP conversation correlation.rootInitiationId',
    ),
    initiatedByCompanionId: requireUuid(
      raw.initiatedByCompanionId,
      'ICP conversation correlation.initiatedByCompanionId',
    ),
    localCompanionId,
    peerCompanionId,
    peerContactId: requireString(raw.peerContactId, 'ICP conversation correlation.peerContactId'),
    channelId,
    turnId: requireString(raw.turnId, 'ICP conversation correlation.turnId'),
    messageId: requireString(raw.messageId, 'ICP conversation correlation.messageId'),
    requestId: requireString(raw.requestId, 'ICP conversation correlation.requestId'),
    chargeLane: requireEnum(
      raw.chargeLane,
      ['interactive', 'companion_social'] as const,
      'ICP conversation correlation.chargeLane',
    ),
    surface,
    costPurpose: requireEnum(
      raw.costPurpose,
      ['conversation_turn', 'tool', 'summary', 'extraction', 'sidecar'] as const,
      'ICP conversation correlation.costPurpose',
    ),
    costOriginStage: requireEnum(
      raw.costOriginStage,
      ['initiation', 'reply', 'post_turn', 'maintenance'] as const,
      'ICP conversation correlation.costOriginStage',
    ),
    fatigueDecision: requireEnum(
      raw.fatigueDecision,
      ['allow', 'allow_overcharge', 'suppress', 'not_evaluated'] as const,
      'ICP conversation correlation.fatigueDecision',
    ),
    ...(fatigueReasonCode !== undefined ? { fatigueReasonCode } : {}),
  };
}
