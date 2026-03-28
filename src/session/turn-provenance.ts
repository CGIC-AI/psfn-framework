import type { TurnID } from '../shared/contracts/runtime.js';
import type { SessionRoleEnvelopePreview } from '../internal-role-envelopes/projections.js';
import {
  parseSessionRoleEnvelopePreview,
  normalizeSessionRoleEnvelopePreview,
} from '../internal-role-envelopes/projections.js';
import type { SessionEntry } from './types.js';
import { backfillLegacyTurnId, parseTurnId } from '../turns/id.js';

interface SessionTurnEnvelope {
  schemaVersion: 1;
  turnId?: string;
  requestId?: string;
  sourceMessageId?: string;
  role: SessionEntry['role'];
  speakerRole?: SessionEntry['role'];
}

interface SessionMetadataEnvelope {
  turn?: unknown;
  roleEnvelopePreview?: unknown;
  [key: string]: unknown;
}

export interface SessionEntryTurnContext {
  turnId: TurnID;
  requestId?: string;
  sourceMessageId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMetadataEnvelope(metadata: string | undefined): SessionMetadataEnvelope {
  if (!metadata) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(metadata);
  } catch {
    throw new Error('Session metadata is malformed JSON; refusing turn provenance fallback');
  }

  if (!isRecord(parsed)) {
    throw new Error('Session metadata must be a JSON object for turn provenance parsing');
  }

  return parsed as SessionMetadataEnvelope;
}

function legacySeed(entry: Pick<SessionEntry, 'channelId' | 'id' | 'timestamp' | 'role'>): string {
  return `legacy-turn:${entry.channelId}:${entry.id}:${entry.timestamp}:${entry.role}`;
}

function parseOptionalStringField(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Session turn metadata field \"${fieldName}\" must be a string`);
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function buildSessionMetadataWithTurn(
  existingMetadata: string | undefined,
  input: {
    turnId: TurnID;
    requestId: string;
    sourceMessageId?: string;
    role: SessionEntry['role'];
  },
): string {
  const base = parseMetadataEnvelope(existingMetadata);
  if (base.turn !== undefined && !isRecord(base.turn)) {
    throw new Error('Session metadata turn field must be an object when present');
  }

  const requestId = input.requestId.trim();
  if (!requestId) {
    throw new Error('Session turn metadata requestId cannot be empty');
  }

  const turn: SessionTurnEnvelope = {
    schemaVersion: 1,
    turnId: input.turnId,
    requestId,
    role: input.role,
    speakerRole: input.role,
    ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
  };

  return JSON.stringify({
    ...base,
    turn,
  });
}

export function buildSessionMetadataWithRoleEnvelopePreview(
  existingMetadata: string | undefined,
  preview: SessionRoleEnvelopePreview,
): string {
  const base = parseMetadataEnvelope(existingMetadata);
  return JSON.stringify({
    ...base,
    roleEnvelopePreview: normalizeSessionRoleEnvelopePreview(preview),
  });
}

export function parseSessionRoleEnvelopePreviewFromMetadata(
  metadata: string | undefined,
): SessionRoleEnvelopePreview | null {
  const envelope = parseMetadataEnvelope(metadata);
  const rawPreview = envelope.roleEnvelopePreview;
  if (rawPreview === undefined) {
    return null;
  }
  return parseSessionRoleEnvelopePreview(rawPreview, 'metadata.roleEnvelopePreview');
}

export function resolveSessionEntryTurnContext(
  entry: Pick<SessionEntry, 'channelId' | 'id' | 'timestamp' | 'role' | 'metadata'>,
): SessionEntryTurnContext {
  const metadata = parseMetadataEnvelope(entry.metadata);
  const rawTurn = metadata.turn;
  if (rawTurn === undefined) {
    return {
      turnId: backfillLegacyTurnId(legacySeed(entry)),
    };
  }

  if (!isRecord(rawTurn)) {
    throw new Error('Session metadata turn field must be an object');
  }

  const turnId = parseTurnId(rawTurn.turnId, 'metadata.turn.turnId')
    ?? backfillLegacyTurnId(legacySeed(entry));
  const requestId = parseOptionalStringField(rawTurn.requestId, 'metadata.turn.requestId');
  const sourceMessageId = parseOptionalStringField(rawTurn.sourceMessageId, 'metadata.turn.sourceMessageId');

  return {
    turnId,
    ...(requestId ? { requestId } : {}),
    ...(sourceMessageId ? { sourceMessageId } : {}),
  };
}

export function resolveSessionEntryRoleEnvelopePreview(
  entry: Pick<SessionEntry, 'metadata'>,
): SessionRoleEnvelopePreview | null {
  return parseSessionRoleEnvelopePreviewFromMetadata(entry.metadata);
}

export function resolveLatestTurnContext(entries: readonly SessionEntry[]): SessionEntryTurnContext | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries.at(index);
    if (!entry) continue;
    if (entry.role !== 'user' && entry.role !== 'assistant') continue;
    return resolveSessionEntryTurnContext(entry);
  }
  return null;
}
