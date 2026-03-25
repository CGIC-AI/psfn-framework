import { createHash } from 'node:crypto';
import { CHANNEL_TYPES, type ChannelType } from '../types.js';

export const INTERNAL_ROLE_ENVELOPE_SCHEMA_VERSION = 1 as const;
export const INTERNAL_ROLE_ENVELOPE_KINDS = [
  'internal_thought',
  'self_reflection',
  'values_reflection',
  'concern_candidate',
  'outreach_candidate',
  'outreach_handoff',
  'outreach_result',
] as const;
export const INTERNAL_ROLE_ENVELOPE_VISIBILITIES = [
  'companion_private',
  'operator_summary',
  'operator_forensic',
  'promoted_context',
  'user_visible',
] as const;
export const INTERNAL_ROLE_ENVELOPE_SOURCE_STAGES = [
  'turn_execution',
  'post_turn_appraisal',
  'heartbeat',
  'scheduler',
  'replay',
  'operator',
] as const;
export const INTERNAL_ROLE_ENVELOPE_PROMOTION_TARGETS = [
  'none',
  'turn_record_summary',
  'continuity_summary',
  'values_journal',
  'memory_write',
  'concern_store',
  'outreach_handoff',
  'session_message',
] as const;
export const INTERNAL_ROLE_ENVELOPE_PROMOTION_STATUSES = [
  'ephemeral',
  'candidate',
  'promoted',
  'suppressed',
  'consumed',
  'expired',
] as const;
export const INTERNAL_ROLE_ENVELOPE_TOMBSTONE_ACTIONS = [
  'redact',
  'expire',
  'cancel',
] as const;

export type InternalRoleEnvelopeKind = (typeof INTERNAL_ROLE_ENVELOPE_KINDS)[number];
export type InternalRoleEnvelopeVisibility = (typeof INTERNAL_ROLE_ENVELOPE_VISIBILITIES)[number];
export type InternalRoleEnvelopeSourceStage = (typeof INTERNAL_ROLE_ENVELOPE_SOURCE_STAGES)[number];
export type InternalRolePromotionTarget = (typeof INTERNAL_ROLE_ENVELOPE_PROMOTION_TARGETS)[number];
export type InternalRolePromotionStatus = (typeof INTERNAL_ROLE_ENVELOPE_PROMOTION_STATUSES)[number];
export type InternalRoleEnvelopeTombstoneAction = (typeof INTERNAL_ROLE_ENVELOPE_TOMBSTONE_ACTIONS)[number];
export type InternalRoleEnvelopeTransportRole = 'system' | 'assistant' | 'tool';
export type InternalRoleEnvelopeChannelType = ChannelType | 'internal';

export interface InternalRoleEnvelopeInspection {
  defaultView: 'summary' | 'forensic';
  rawTtlDays: 7 | 30 | 90;
  searchableSummary: boolean;
  searchableBody: boolean;
}

export interface InternalRoleEnvelopePromotion {
  status: InternalRolePromotionStatus;
  target: InternalRolePromotionTarget;
  reason?: string;
  promotedRef?: string;
  promotedAt?: number;
}

export interface InternalRoleEnvelope {
  schemaVersion: 1;
  envelopeId: string;
  parentEnvelopeId?: string;
  turnId?: string;
  requestId?: string;
  sourceMessageId?: string;
  channelId: string;
  channelType: InternalRoleEnvelopeChannelType;
  canonicalContactId?: string;
  createdAt: number;
  transportRole: InternalRoleEnvelopeTransportRole;
  internalRole: InternalRoleEnvelopeKind;
  sourceStage: InternalRoleEnvelopeSourceStage;
  visibility: InternalRoleEnvelopeVisibility;
  summary: string;
  body: string;
  tags: string[];
  provenanceRefs: string[];
  inspection: InternalRoleEnvelopeInspection;
  promotion: InternalRoleEnvelopePromotion;
}

export interface InternalRoleEnvelopeIdSeed {
  turnId: string;
  sourceStage: InternalRoleEnvelopeSourceStage;
  internalRole: InternalRoleEnvelopeKind;
  ordinal?: number;
}

export interface CreateInternalRoleEnvelopeInput {
  envelopeId?: string;
  parentEnvelopeId?: string;
  turnId?: string;
  requestId?: string;
  sourceMessageId?: string;
  channelId: string;
  channelType: InternalRoleEnvelopeChannelType;
  canonicalContactId?: string;
  createdAt?: number;
  transportRole: InternalRoleEnvelopeTransportRole;
  internalRole: InternalRoleEnvelopeKind;
  sourceStage: InternalRoleEnvelopeSourceStage;
  visibility: InternalRoleEnvelopeVisibility;
  summary: string;
  body: string;
  tags?: readonly string[];
  provenanceRefs?: readonly string[];
  inspection?: Partial<InternalRoleEnvelopeInspection>;
  promotion?: Partial<InternalRoleEnvelopePromotion>;
  ordinal?: number;
}

export interface InternalRoleEnvelopeLedgerEnvelopeEntry {
  type: 'envelope';
  loggedAt: number;
  envelope: InternalRoleEnvelope;
}

export interface InternalRoleEnvelopeLedgerPromotionEntry {
  type: 'promotion';
  loggedAt: number;
  envelopeId: string;
  status: InternalRolePromotionStatus;
  target: InternalRolePromotionTarget;
  reason: string;
  promotedRef?: string;
}

export interface InternalRoleEnvelopeLedgerTombstoneEntry {
  type: 'tombstone';
  loggedAt: number;
  envelopeId: string;
  action: InternalRoleEnvelopeTombstoneAction;
  actor: string;
  reason?: string;
}

export type InternalRoleEnvelopeLedgerEntry =
  | InternalRoleEnvelopeLedgerEnvelopeEntry
  | InternalRoleEnvelopeLedgerPromotionEntry
  | InternalRoleEnvelopeLedgerTombstoneEntry;

export interface InternalRoleEnvelopePromotionInput {
  envelopeId: string;
  loggedAt?: number;
  status: InternalRolePromotionStatus;
  target: InternalRolePromotionTarget;
  reason: string;
  promotedRef?: string;
}

export interface InternalRoleEnvelopeTombstoneInput {
  envelopeId: string;
  loggedAt?: number;
  action: InternalRoleEnvelopeTombstoneAction;
  actor: string;
  reason?: string;
}

export interface InternalRoleEnvelopeLedger {
  getChannelLedgerPath(channelId: string): string;
  appendEnvelope(input: CreateInternalRoleEnvelopeInput): InternalRoleEnvelope;
  appendPromotion(
    channelId: string,
    input: InternalRoleEnvelopePromotionInput,
  ): InternalRoleEnvelopeLedgerPromotionEntry;
  appendTombstone(
    channelId: string,
    input: InternalRoleEnvelopeTombstoneInput,
  ): InternalRoleEnvelopeLedgerTombstoneEntry;
  readEntries(channelId: string): InternalRoleEnvelopeLedgerEntry[];
}

const INTERNAL_ROLE_ENVELOPE_KIND_SET = new Set<string>(INTERNAL_ROLE_ENVELOPE_KINDS);
const INTERNAL_ROLE_ENVELOPE_VISIBILITY_SET = new Set<string>(INTERNAL_ROLE_ENVELOPE_VISIBILITIES);
const INTERNAL_ROLE_ENVELOPE_SOURCE_STAGE_SET = new Set<string>(INTERNAL_ROLE_ENVELOPE_SOURCE_STAGES);
const INTERNAL_ROLE_ENVELOPE_PROMOTION_TARGET_SET = new Set<string>(INTERNAL_ROLE_ENVELOPE_PROMOTION_TARGETS);
const INTERNAL_ROLE_ENVELOPE_PROMOTION_STATUS_SET = new Set<string>(INTERNAL_ROLE_ENVELOPE_PROMOTION_STATUSES);
const INTERNAL_ROLE_ENVELOPE_TOMBSTONE_ACTION_SET = new Set<string>(INTERNAL_ROLE_ENVELOPE_TOMBSTONE_ACTIONS);
const INTERNAL_ROLE_ENVELOPE_CHANNEL_TYPE_SET = new Set<string>([...CHANNEL_TYPES, 'internal']);
const INTERNAL_ROLE_ENVELOPE_TRANSPORT_ROLE_SET = new Set<string>(['system', 'assistant', 'tool']);

function normalizeRequiredString(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Internal role envelope ${field} must be non-empty`);
  }
  return normalized;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeTimestamp(value: number | undefined, field: string): number {
  const normalized = value ?? Date.now();
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`Internal role envelope ${field} must be a finite timestamp`);
  }
  return Math.floor(normalized);
}

function normalizeStringList(values: readonly string[] | undefined): string[] {
  if (!Array.isArray(values) || values.length === 0) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function defaultInspectionForRole(internalRole: InternalRoleEnvelopeKind): InternalRoleEnvelopeInspection {
  if (internalRole === 'internal_thought') {
    return {
      defaultView: 'summary',
      rawTtlDays: 7,
      searchableSummary: true,
      searchableBody: false,
    };
  }

  if (internalRole === 'self_reflection' || internalRole === 'values_reflection') {
    return {
      defaultView: 'summary',
      rawTtlDays: 30,
      searchableSummary: true,
      searchableBody: true,
    };
  }

  return {
    defaultView: 'summary',
    rawTtlDays: 30,
    searchableSummary: true,
    searchableBody: false,
  };
}

export function isInternalRoleEnvelopeKind(value: unknown): value is InternalRoleEnvelopeKind {
  return typeof value === 'string' && INTERNAL_ROLE_ENVELOPE_KIND_SET.has(value);
}

export function isInternalRoleEnvelopeVisibility(value: unknown): value is InternalRoleEnvelopeVisibility {
  return typeof value === 'string' && INTERNAL_ROLE_ENVELOPE_VISIBILITY_SET.has(value);
}

export function isInternalRoleEnvelopeSourceStage(value: unknown): value is InternalRoleEnvelopeSourceStage {
  return typeof value === 'string' && INTERNAL_ROLE_ENVELOPE_SOURCE_STAGE_SET.has(value);
}

export function isInternalRolePromotionTarget(value: unknown): value is InternalRolePromotionTarget {
  return typeof value === 'string' && INTERNAL_ROLE_ENVELOPE_PROMOTION_TARGET_SET.has(value);
}

export function isInternalRolePromotionStatus(value: unknown): value is InternalRolePromotionStatus {
  return typeof value === 'string' && INTERNAL_ROLE_ENVELOPE_PROMOTION_STATUS_SET.has(value);
}

export function isInternalRoleEnvelopeTombstoneAction(
  value: unknown,
): value is InternalRoleEnvelopeTombstoneAction {
  return typeof value === 'string' && INTERNAL_ROLE_ENVELOPE_TOMBSTONE_ACTION_SET.has(value);
}

export function isInternalRoleEnvelopeChannelType(value: unknown): value is InternalRoleEnvelopeChannelType {
  return typeof value === 'string' && INTERNAL_ROLE_ENVELOPE_CHANNEL_TYPE_SET.has(value);
}

export function isInternalRoleEnvelopeTransportRole(
  value: unknown,
): value is InternalRoleEnvelopeTransportRole {
  return typeof value === 'string' && INTERNAL_ROLE_ENVELOPE_TRANSPORT_ROLE_SET.has(value);
}

export function createInternalRoleEnvelopeId(seed: InternalRoleEnvelopeIdSeed): string {
  const ordinal = Number.isFinite(seed.ordinal) ? Math.max(0, Math.floor(seed.ordinal ?? 0)) : 0;
  const digest = createHash('sha256')
    .update(seed.turnId)
    .update('\x1f')
    .update(seed.sourceStage)
    .update('\x1f')
    .update(seed.internalRole)
    .update('\x1f')
    .update(String(ordinal))
    .digest('hex');
  return `env_${digest.slice(0, 24)}`;
}

export function createInternalRoleEnvelope(
  input: CreateInternalRoleEnvelopeInput,
): InternalRoleEnvelope {
  if (!isInternalRoleEnvelopeKind(input.internalRole)) {
    throw new Error(`Unknown internal role envelope kind "${String(input.internalRole)}"`);
  }
  if (!isInternalRoleEnvelopeSourceStage(input.sourceStage)) {
    throw new Error(`Unknown internal role envelope source stage "${String(input.sourceStage)}"`);
  }
  if (!isInternalRoleEnvelopeVisibility(input.visibility)) {
    throw new Error(`Unknown internal role envelope visibility "${String(input.visibility)}"`);
  }
  if (!isInternalRoleEnvelopeChannelType(input.channelType)) {
    throw new Error(`Unknown internal role envelope channel type "${String(input.channelType)}"`);
  }
  if (!isInternalRoleEnvelopeTransportRole(input.transportRole)) {
    throw new Error(`Unknown internal role envelope transport role "${String(input.transportRole)}"`);
  }

  const turnId = normalizeOptionalString(input.turnId);
  const envelopeId = normalizeOptionalString(input.envelopeId)
    ?? (turnId
      ? createInternalRoleEnvelopeId({
        turnId,
        sourceStage: input.sourceStage,
        internalRole: input.internalRole,
        ordinal: input.ordinal,
      })
      : null);
  if (!envelopeId) {
    throw new Error('Internal role envelope requires either envelopeId or turnId for deterministic IDs');
  }

  const defaultInspection = defaultInspectionForRole(input.internalRole);
  const requestedInspection = input.inspection ?? {};
  const promotion = input.promotion ?? {};

  return {
    schemaVersion: INTERNAL_ROLE_ENVELOPE_SCHEMA_VERSION,
    envelopeId,
    ...(normalizeOptionalString(input.parentEnvelopeId)
      ? { parentEnvelopeId: normalizeOptionalString(input.parentEnvelopeId) }
      : {}),
    ...(turnId ? { turnId } : {}),
    ...(normalizeOptionalString(input.requestId) ? { requestId: normalizeOptionalString(input.requestId) } : {}),
    ...(normalizeOptionalString(input.sourceMessageId)
      ? { sourceMessageId: normalizeOptionalString(input.sourceMessageId) }
      : {}),
    channelId: normalizeRequiredString(input.channelId, 'channelId'),
    channelType: input.channelType,
    ...(normalizeOptionalString(input.canonicalContactId)
      ? { canonicalContactId: normalizeOptionalString(input.canonicalContactId) }
      : {}),
    createdAt: normalizeTimestamp(input.createdAt, 'createdAt'),
    transportRole: input.transportRole,
    internalRole: input.internalRole,
    sourceStage: input.sourceStage,
    visibility: input.visibility,
    summary: normalizeRequiredString(input.summary, 'summary'),
    body: normalizeRequiredString(input.body, 'body'),
    tags: normalizeStringList(input.tags),
    provenanceRefs: normalizeStringList(input.provenanceRefs),
    inspection: {
      defaultView: requestedInspection.defaultView === 'forensic' ? 'forensic' : defaultInspection.defaultView,
      rawTtlDays:
        requestedInspection.rawTtlDays === 7
        || requestedInspection.rawTtlDays === 30
        || requestedInspection.rawTtlDays === 90
          ? requestedInspection.rawTtlDays
          : defaultInspection.rawTtlDays,
      searchableSummary: requestedInspection.searchableSummary ?? defaultInspection.searchableSummary,
      searchableBody: requestedInspection.searchableBody ?? defaultInspection.searchableBody,
    },
    promotion: {
      status: isInternalRolePromotionStatus(promotion.status) ? promotion.status : 'ephemeral',
      target: isInternalRolePromotionTarget(promotion.target) ? promotion.target : 'none',
      ...(normalizeOptionalString(promotion.reason) ? { reason: normalizeOptionalString(promotion.reason) } : {}),
      ...(normalizeOptionalString(promotion.promotedRef)
        ? { promotedRef: normalizeOptionalString(promotion.promotedRef) }
        : {}),
      ...(promotion.promotedAt !== undefined
        ? { promotedAt: normalizeTimestamp(promotion.promotedAt, 'promotion.promotedAt') }
        : {}),
    },
  };
}
