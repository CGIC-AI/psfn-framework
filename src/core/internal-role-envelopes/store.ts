import { appendJsonLine, readJsonLines } from '../../persistence/jsonl.js';
import { resolveInternalRoleEnvelopeLedgerPath } from '../../persistence/layout.js';
import {
  createInternalRoleEnvelope,
  isInternalRoleEnvelopeKind,
  isInternalRoleEnvelopeSourceStage,
  isInternalRoleEnvelopeVisibility,
  isInternalRoleEnvelopeChannelType,
  isInternalRoleEnvelopeTransportRole,
  isInternalRolePromotionStatus,
  isInternalRolePromotionTarget,
  isInternalRoleEnvelopeTombstoneAction,
  type CreateInternalRoleEnvelopeInput,
  type InternalRoleEnvelope,
  type InternalRoleEnvelopeInspection,
  type InternalRoleEnvelopeLedger,
  type InternalRoleEnvelopeLedgerEntry,
  type InternalRoleEnvelopeLedgerPromotionEntry,
  type InternalRoleEnvelopeLedgerTombstoneEntry,
  type InternalRoleEnvelopePromotionInput,
  type InternalRoleEnvelopeTombstoneInput,
} from './types.js';

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${context} must be a non-empty string`);
  }
  return value.trim();
}

function requireTimestamp(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${context} must be a finite timestamp`);
  }
  return Math.floor(value);
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readStringArray(value: unknown, context: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be an array`);
  }
  return value.map((item, index) => requireString(item, `${context}[${String(index)}]`));
}

function readInspection(value: unknown, context: string): Partial<InternalRoleEnvelopeInspection> {
  if (value === undefined) return {};
  const inspection = requireRecord(value, context);
  const defaultView = inspection.defaultView;
  const rawTtlDays = inspection.rawTtlDays;
  const searchableSummary = inspection.searchableSummary;
  const searchableBody = inspection.searchableBody;
  return {
    ...(defaultView === 'summary' || defaultView === 'forensic' ? { defaultView } : {}),
    ...(rawTtlDays === 7 || rawTtlDays === 30 || rawTtlDays === 90 ? { rawTtlDays } : {}),
    ...(typeof searchableSummary === 'boolean' ? { searchableSummary } : {}),
    ...(typeof searchableBody === 'boolean' ? { searchableBody } : {}),
  };
}

function parseEnvelope(value: unknown, context: string): InternalRoleEnvelope {
  const envelope = requireRecord(value, context);
  const internalRole = envelope.internalRole;
  const sourceStage = envelope.sourceStage;
  const visibility = envelope.visibility;
  const channelType = envelope.channelType;
  const transportRole = envelope.transportRole;
  if (!isInternalRoleEnvelopeKind(internalRole)) {
    throw new Error(`${context}.internalRole is invalid`);
  }
  if (!isInternalRoleEnvelopeSourceStage(sourceStage)) {
    throw new Error(`${context}.sourceStage is invalid`);
  }
  if (!isInternalRoleEnvelopeVisibility(visibility)) {
    throw new Error(`${context}.visibility is invalid`);
  }
  if (!isInternalRoleEnvelopeChannelType(channelType)) {
    throw new Error(`${context}.channelType is invalid`);
  }
  if (!isInternalRoleEnvelopeTransportRole(transportRole)) {
    throw new Error(`${context}.transportRole is invalid`);
  }

  const promotionRecord = requireRecord(envelope.promotion, `${context}.promotion`);
  const promotionStatus = promotionRecord.status;
  const promotionTarget = promotionRecord.target;
  if (!isInternalRolePromotionStatus(promotionStatus)) {
    throw new Error(`${context}.promotion.status is invalid`);
  }
  if (!isInternalRolePromotionTarget(promotionTarget)) {
    throw new Error(`${context}.promotion.target is invalid`);
  }

  return createInternalRoleEnvelope({
    envelopeId: requireString(envelope.envelopeId, `${context}.envelopeId`),
    parentEnvelopeId: readOptionalString(envelope.parentEnvelopeId),
    turnId: readOptionalString(envelope.turnId),
    requestId: readOptionalString(envelope.requestId),
    sourceMessageId: readOptionalString(envelope.sourceMessageId),
    channelId: requireString(envelope.channelId, `${context}.channelId`),
    channelType,
    canonicalContactId: readOptionalString(envelope.canonicalContactId),
    createdAt: requireTimestamp(envelope.createdAt, `${context}.createdAt`),
    transportRole,
    internalRole,
    sourceStage,
    visibility,
    summary: requireString(envelope.summary, `${context}.summary`),
    body: requireString(envelope.body, `${context}.body`),
    tags: readStringArray(envelope.tags, `${context}.tags`),
    provenanceRefs: readStringArray(envelope.provenanceRefs, `${context}.provenanceRefs`),
    inspection: readInspection(envelope.inspection, `${context}.inspection`),
    promotion: {
      status: promotionStatus,
      target: promotionTarget,
      ...(readOptionalString(promotionRecord.reason)
        ? { reason: readOptionalString(promotionRecord.reason) }
        : {}),
      ...(readOptionalString(promotionRecord.promotedRef)
        ? { promotedRef: readOptionalString(promotionRecord.promotedRef) }
        : {}),
      ...(promotionRecord.promotedAt !== undefined
        ? { promotedAt: requireTimestamp(promotionRecord.promotedAt, `${context}.promotion.promotedAt`) }
        : {}),
    },
  });
}

function parseLedgerEntry(value: unknown, context: string): InternalRoleEnvelopeLedgerEntry {
  const entry = requireRecord(value, context);
  const type = entry.type;
  if (type === 'envelope') {
    return {
      type,
      loggedAt: requireTimestamp(entry.loggedAt, `${context}.loggedAt`),
      envelope: parseEnvelope(entry.envelope, `${context}.envelope`),
    };
  }

  if (type === 'promotion') {
    const status = entry.status;
    const target = entry.target;
    if (!isInternalRolePromotionStatus(status)) {
      throw new Error(`${context}.status is invalid`);
    }
    if (!isInternalRolePromotionTarget(target)) {
      throw new Error(`${context}.target is invalid`);
    }
    return {
      type,
      loggedAt: requireTimestamp(entry.loggedAt, `${context}.loggedAt`),
      envelopeId: requireString(entry.envelopeId, `${context}.envelopeId`),
      status,
      target,
      reason: requireString(entry.reason, `${context}.reason`),
      ...(readOptionalString(entry.promotedRef) ? { promotedRef: readOptionalString(entry.promotedRef) } : {}),
    };
  }

  if (type === 'tombstone') {
    const action = entry.action;
    if (!isInternalRoleEnvelopeTombstoneAction(action)) {
      throw new Error(`${context}.action is invalid`);
    }
    return {
      type,
      loggedAt: requireTimestamp(entry.loggedAt, `${context}.loggedAt`),
      envelopeId: requireString(entry.envelopeId, `${context}.envelopeId`),
      action,
      actor: requireString(entry.actor, `${context}.actor`),
      ...(readOptionalString(entry.reason) ? { reason: readOptionalString(entry.reason) } : {}),
    };
  }

  throw new Error(`${context}.type is invalid`);
}

export class InternalRoleEnvelopeLedgerStore implements InternalRoleEnvelopeLedger {
  private readonly companionDataDir: string;

  constructor(companionDataDir: string) {
    this.companionDataDir = companionDataDir;
  }

  getChannelLedgerPath(channelId: string): string {
    return resolveInternalRoleEnvelopeLedgerPath(this.companionDataDir, channelId);
  }

  appendEnvelope(input: CreateInternalRoleEnvelopeInput): InternalRoleEnvelope {
    const envelope = createInternalRoleEnvelope(input);
    appendJsonLine(this.getChannelLedgerPath(envelope.channelId), {
      type: 'envelope',
      loggedAt: envelope.createdAt,
      envelope,
    });
    return envelope;
  }

  appendPromotion(
    channelId: string,
    input: InternalRoleEnvelopePromotionInput,
  ): InternalRoleEnvelopeLedgerPromotionEntry {
    const entry: InternalRoleEnvelopeLedgerPromotionEntry = {
      type: 'promotion',
      loggedAt: requireTimestamp(input.loggedAt ?? Date.now(), 'promotion.loggedAt'),
      envelopeId: requireString(input.envelopeId, 'promotion.envelopeId'),
      status: input.status,
      target: input.target,
      reason: requireString(input.reason, 'promotion.reason'),
      ...(readOptionalString(input.promotedRef) ? { promotedRef: readOptionalString(input.promotedRef) } : {}),
    };
    appendJsonLine(this.getChannelLedgerPath(channelId), entry);
    return entry;
  }

  appendTombstone(
    channelId: string,
    input: InternalRoleEnvelopeTombstoneInput,
  ): InternalRoleEnvelopeLedgerTombstoneEntry {
    const entry: InternalRoleEnvelopeLedgerTombstoneEntry = {
      type: 'tombstone',
      loggedAt: requireTimestamp(input.loggedAt ?? Date.now(), 'tombstone.loggedAt'),
      envelopeId: requireString(input.envelopeId, 'tombstone.envelopeId'),
      action: input.action,
      actor: requireString(input.actor, 'tombstone.actor'),
      ...(readOptionalString(input.reason) ? { reason: readOptionalString(input.reason) } : {}),
    };
    appendJsonLine(this.getChannelLedgerPath(channelId), entry);
    return entry;
  }

  readEntries(channelId: string): InternalRoleEnvelopeLedgerEntry[] {
    const filePath = this.getChannelLedgerPath(channelId);
    return readJsonLines<InternalRoleEnvelopeLedgerEntry>(
      filePath,
      (raw, { line }) => parseLedgerEntry(raw, `Internal role envelope ledger ${filePath}:${String(line)}`),
      {
        onError: ({ line, error }) => {
          const context = `Internal role envelope ledger ${filePath}:${String(line)}`;
          throw new Error(`${context} could not be parsed: ${error instanceof Error ? error.message : String(error)}`);
        },
      },
    ).entries;
  }
}
