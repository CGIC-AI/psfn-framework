import { parseCompanionChannelId } from './companion-channels.js';
import {
  assertNoUnknownKeys,
  isRecord,
} from '../utils/types.js';
import { requireUuid } from '../utils/uuid.js';

// Content-free cross-companion control-plane vocabulary. Private motivation
// stays in core/icp/initiation-candidate.ts and never enters these contracts.

export const MAX_ICP_AVAILABILITY_LEASE_TTL_MS = 24 * 60 * 60_000;
export const MAX_ICP_PERMIT_TTL_MS = 15 * 60_000;
const ICP_PROVENANCE_HANDLE_PATTERN = /^icp-prov:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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
  // Affect-driven initiation (operator ruling D4, psfn-framework-hrmrq.34):
  // the companion-local EmoSim Proactivity Port's qualified source fire
  // creates the candidate, replacing any wall-clock initiating impulse.
  // Retry/TTL plumbing and every disposition/delivery authority are unchanged.
  'felt_impulse',
  // Authenticated Garden/harness initiation. This marks operator-driven test
  // traffic durably while the ordinary broker gates and one-use permit remain
  // authoritative for delivery.
  'operator_test',
] as const;
export type IcpInitiationSource = typeof ICP_INITIATION_SOURCES[number];

export const ICP_INITIATION_CANDIDATE_STATUSES = [
  'pending',
  'deferred',
  'declined',
  'rejected',
  'permitted',
  'consumed',
  'expired',
  'cancelled',
] as const;
export type IcpInitiationCandidateStatus = typeof ICP_INITIATION_CANDIDATE_STATUSES[number];

export const ICP_CONVERSATION_STATUSES = [
  'invited',
  'active',
  'declined',
  'deferred',
  'ended',
  'suppressed',
] as const;
export type IcpConversationStatus = typeof ICP_CONVERSATION_STATUSES[number];

const ICP_DYAD_STATUSES = ['open', 'paused', 'closed', 'blocked'] as const;
export type IcpDyadStatus = typeof ICP_DYAD_STATUSES[number];
export type IcpDyadSideAction = 'pause' | 'resume' | 'close' | 'block' | 'unblock';

const ICP_DYAD_RELATIONSHIP_STATES = ['open', 'paused', 'closed'] as const;
type IcpDyadRelationshipState = typeof ICP_DYAD_RELATIONSHIP_STATES[number];

export interface IcpDyadParticipantState {
  companionId: string;
  relationshipState: IcpDyadRelationshipState;
  blocked: boolean;
  updatedAtMs: number;
}

export const ICP_DYAD_DELIVERY_OUTCOMES = [
  'queued',
  'delayed',
  'delivered',
  'ignored',
  'declined',
  'failed',
  'retrying',
  'duplicate',
  'suppressed',
] as const;
export type IcpDyadDeliveryOutcome = typeof ICP_DYAD_DELIVERY_OUTCOMES[number];

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
  'inactivity_timeout',
  'dyad_not_found',
  'dyad_paused',
  'dyad_closed',
  'dyad_blocked',
  'dyad_stale_revision',
] as const;
export type IcpAutonomyReasonCode = typeof ICP_AUTONOMY_REASON_CODES[number];

export function icpDyadStatusReasonCode(status: IcpDyadStatus): Extract<
  IcpAutonomyReasonCode,
  'dyad_paused' | 'dyad_closed' | 'dyad_blocked' | 'dyad_stale_revision'
> {
  switch (status) {
    case 'paused': return 'dyad_paused';
    case 'closed': return 'dyad_closed';
    case 'blocked': return 'dyad_blocked';
    case 'open': return 'dyad_stale_revision';
  }
}

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

/** Durable relationship authority for one canonical companion DM pair. */
export interface IcpDyad {
  dyadId: string;
  channelId: string;
  participantCompanionIds: [string, string];
  status: IcpDyadStatus;
  /** Pair-canonical, reason-free state owned independently by each participant. */
  participantStates: [IcpDyadParticipantState, IcpDyadParticipantState];
  createdAtMs: number;
  /** Episode conversation IDs retained as content-free historical provenance. */
  provenanceConversationIds: string[];
  lifecycleRevision: number;
  revision: number;
}

/** Content-free delivery lifecycle for an established dyad continuation. */
export interface IcpDyadDelivery {
  deliveryId: string;
  dyadId: string;
  conversationId: string;
  senderCompanionId: string;
  recipientCompanionId: string;
  outcome: IcpDyadDeliveryOutcome;
  createdAtMs: number;
  updatedAtMs: number;
  attempt: number;
  gatewayMessageId?: string;
  reasonCode?: IcpAutonomyReasonCode;
  /** Relationship fence captured before content generation. */
  dyadLifecycleRevision: number;
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
  /** Durable relationship identity. Present for open-dyad continuation traffic. */
  dyadId?: string;
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

/**
 * Stable gateway envelope identity for one authored ICP turn. Transport
 * retries and lost RPC acknowledgements must reuse this exact id.
 */
export function deriveIcpTransportMessageId(
  value: IcpConversationCorrelation,
): string {
  const correlation = parseIcpConversationCorrelation(value);
  if (correlation.costOriginStage === 'initiation') {
    const prefix = correlation.messageId.startsWith('icp-initiation:')
      ? 'icp-initiation:'
      : correlation.messageId.startsWith('icp-continuation:')
        ? 'icp-continuation:'
        : null;
    if (!prefix) throw new Error('ICP initiation correlation messageId is not authority-bound');
    const candidateId = correlation.messageId.slice(prefix.length).trim();
    if (!candidateId) {
      throw new Error('ICP initiation correlation is missing candidate identity');
    }
    return prefix === 'icp-initiation:'
      ? `companion-initiation-${candidateId}`
      : `companion-continuation-${candidateId}`;
  }
  if (correlation.costOriginStage !== 'reply') {
    throw new Error('Only initiation and reply ICP correlations can be transported');
  }
  return `companion-reply-${correlation.localCompanionId}-${correlation.turnId}`;
}

export function deriveChildIcpConversationCostCorrelation(
  value: IcpConversationCorrelation,
  child: Pick<IcpConversationCorrelation, 'requestId' | 'costPurpose' | 'costOriginStage'>,
): IcpConversationCorrelation {
  const correlation = parseIcpConversationCorrelation(value);
  return parseIcpConversationCorrelation({
    ...correlation,
    requestId: child.requestId,
    costPurpose: child.costPurpose,
    costOriginStage: child.costOriginStage,
  });
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
const DYAD_KEYS = [
  'dyadId', 'channelId', 'participantCompanionIds', 'status', 'participantStates',
  'createdAtMs', 'provenanceConversationIds', 'revision',
  'lifecycleRevision',
] as const;
const PERMIT_KEYS = [
  'permitId', 'candidateId', 'conversationId', 'senderCompanionId',
  'recipientCompanionId', 'channelId', 'provenanceRef', 'issuedAtMs',
  'expiresAtMs', 'status', 'consumedAtMs', 'revokedAtMs', 'reasonCode', 'revision',
] as const;
const CORRELATION_KEYS = [
  'dyadId', 'conversationId', 'rootInitiationId', 'initiatedByCompanionId',
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
const DYAD_TRANSITIONS: Readonly<Record<IcpDyadStatus, readonly IcpDyadStatus[]>> = {
  open: ['paused', 'closed', 'blocked'],
  paused: ['open', 'closed', 'blocked'],
  closed: ['open', 'blocked'],
  blocked: ['open', 'paused', 'closed'],
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
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

/** Opaque content-free handle; descriptive provenance remains companion-local. */
export function parseIcpProvenanceHandle(value: unknown, field = 'provenanceRef'): string {
  if (typeof value !== 'string' || !ICP_PROVENANCE_HANDLE_PATTERN.test(value)) {
    throw new Error(`${field} must be an opaque provenance handle (icp-prov:<lowercase RFC-4122 UUID>)`);
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

function requireUuidArray(value: unknown, field: string, minimumLength = 2): string[] {
  if (!Array.isArray(value) || value.length < minimumLength) {
    throw new Error(`${field} must contain at least ${minimumLength} UUIDs`);
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
    provenanceRef: parseIcpProvenanceHandle(
      raw.provenanceRef,
      'ICP conversation episode.provenanceRef',
    ),
    openedAtMs,
    lastActivityAtMs,
    status: requireEnum(raw.status, ICP_CONVERSATION_STATUSES, 'ICP conversation episode.status'),
    ...(closeReasonCode !== undefined ? { closeReasonCode } : {}),
    revision: requireRevision(raw.revision, 'ICP conversation episode.revision'),
  };
}

export function parseIcpDyad(
  value: unknown,
  options: IcpEpisodeValidationOptions = {},
): IcpDyad {
  const raw = requireRecord(value, 'ICP dyad');
  assertNoUnknownKeys(raw, DYAD_KEYS, 'ICP dyad');
  const participants = requireUuidArray(raw.participantCompanionIds, 'ICP dyad.participantCompanionIds');
  if (participants.length !== 2) throw new Error('ICP dyad must contain exactly two companions');
  const channelId = requireString(raw.channelId, 'ICP dyad.channelId');
  const channelKind = assertChannelPairBinding(channelId, participants[0]!, participants[1]!, 'ICP dyad');
  if (channelKind !== 'dm') throw new Error('ICP dyad.channelId must be a companion DM');
  if (options.knownCompanionIds) {
    for (const participant of participants) {
      if (!options.knownCompanionIds.has(participant)) {
        throw new Error(`ICP dyad has unknown participant ${participant}`);
      }
    }
  }
  const status = requireEnum(raw.status, ICP_DYAD_STATUSES, 'ICP dyad.status');
  const createdAtMs = requireTimestamp(raw.createdAtMs, 'ICP dyad.createdAtMs');
  if (!Array.isArray(raw.participantStates) || raw.participantStates.length !== 2) {
    throw new Error('ICP dyad.participantStates must contain exactly two participant states');
  }
  const participantStates = raw.participantStates.map((value, index) => {
    const state = requireRecord(value, `ICP dyad.participantStates[${index}]`);
    assertNoUnknownKeys(
      state,
      ['companionId', 'relationshipState', 'blocked', 'updatedAtMs'],
      `ICP dyad.participantStates[${index}]`,
    );
    const companionId = requireUuid(
      state.companionId,
      `ICP dyad.participantStates[${index}].companionId`,
    );
    if (companionId !== participants[index]) {
      throw new Error('ICP dyad.participantStates must match canonical participant order');
    }
    const updatedAtMs = requireTimestamp(
      state.updatedAtMs,
      `ICP dyad.participantStates[${index}].updatedAtMs`,
    );
    if (updatedAtMs < createdAtMs) {
      throw new Error('ICP dyad participant state cannot predate dyad creation');
    }
    if (typeof state.blocked !== 'boolean') {
      throw new Error(`ICP dyad.participantStates[${index}].blocked must be a boolean`);
    }
    return {
      companionId,
      relationshipState: requireEnum(
        state.relationshipState,
        ICP_DYAD_RELATIONSHIP_STATES,
        `ICP dyad.participantStates[${index}].relationshipState`,
      ),
      blocked: state.blocked,
      updatedAtMs,
    };
  }) as [IcpDyadParticipantState, IcpDyadParticipantState];
  if (resolveIcpDyadStatus(participantStates) !== status) {
    throw new Error('ICP dyad status does not match its effective status');
  }
  const provenanceConversationIds = requireUuidArray(
    raw.provenanceConversationIds,
    'ICP dyad.provenanceConversationIds',
    1,
  );
  return {
    dyadId: requireUuid(raw.dyadId, 'ICP dyad.dyadId'),
    channelId,
    participantCompanionIds: [participants[0]!, participants[1]!],
    status,
    participantStates,
    createdAtMs,
    provenanceConversationIds,
    lifecycleRevision: requireRevision(raw.lifecycleRevision, 'ICP dyad.lifecycleRevision'),
    revision: requireRevision(raw.revision, 'ICP dyad.revision'),
  };
}

/** Effective sendability is the intersection of both reason-free grants. */
export function resolveIcpDyadStatus(
  participantStates: readonly IcpDyadParticipantState[],
): IcpDyadStatus {
  if (participantStates.some(state => state.blocked)) return 'blocked';
  if (participantStates.some(state => state.relationshipState === 'closed')) return 'closed';
  if (participantStates.some(state => state.relationshipState === 'paused')) return 'paused';
  return 'open';
}

export function assertIcpDyadStatusTransition(from: IcpDyadStatus, to: IcpDyadStatus): void {
  if (!DYAD_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid ICP dyad status transition: ${from} -> ${to}`);
  }
}

export function assertIcpConversationStatusTransition(
  from: IcpConversationStatus,
  to: IcpConversationStatus,
): void {
  if (!CONVERSATION_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid ICP conversation status transition: ${from} -> ${to}`);
  }
}

export function assertIcpConversationActivityTransition(
  previousLastActivityAtMs: number,
  nextLastActivityAtMs: number,
): void {
  const previous = requireTimestamp(
    previousLastActivityAtMs,
    'ICP conversation previousLastActivityAtMs',
  );
  const next = requireTimestamp(nextLastActivityAtMs, 'ICP conversation nextLastActivityAtMs');
  if (next < previous) {
    throw new Error('ICP conversation lastActivityAtMs must not regress');
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
  if (consumedAtMs !== undefined && consumedAtMs < issuedAtMs) {
    throw new Error('ICP initiation permit.consumedAtMs must not predate issuedAtMs');
  }
  if (consumedAtMs !== undefined && consumedAtMs >= expiresAtMs) {
    throw new Error('ICP initiation permit.consumedAtMs must precede expiresAtMs');
  }
  if (revokedAtMs !== undefined && revokedAtMs < issuedAtMs) {
    throw new Error('ICP initiation permit.revokedAtMs must not predate issuedAtMs');
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
    provenanceRef: parseIcpProvenanceHandle(raw.provenanceRef, 'ICP initiation permit.provenanceRef'),
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
  if (raw.dyadId !== undefined && channelKind !== 'dm') {
    throw new Error('ICP conversation correlation.dyadId is restricted to companion DM traffic');
  }
  const fatigueReasonCode = requireOptionalReason(
    raw.fatigueReasonCode,
    'ICP conversation correlation.fatigueReasonCode',
  );
  const initiatedByCompanionId = requireUuid(
    raw.initiatedByCompanionId,
    'ICP conversation correlation.initiatedByCompanionId',
  );
  if (initiatedByCompanionId !== localCompanionId && initiatedByCompanionId !== peerCompanionId) {
    throw new Error(
      'ICP conversation correlation.initiatedByCompanionId must be the local or peer companion',
    );
  }
  return {
    ...(raw.dyadId !== undefined
      ? { dyadId: requireUuid(raw.dyadId, 'ICP conversation correlation.dyadId') }
      : {}),
    conversationId: requireUuid(raw.conversationId, 'ICP conversation correlation.conversationId'),
    rootInitiationId: requireUuid(
      raw.rootInitiationId,
      'ICP conversation correlation.rootInitiationId',
    ),
    initiatedByCompanionId,
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
