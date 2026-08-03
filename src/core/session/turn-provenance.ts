import { isRecord } from '../../shared/utils/types.js';
import type { TurnID } from '../../shared/contracts/runtime.js';
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
  replyToMessageId?: string;
  role: SessionEntry['role'];
  speakerRole?: SessionEntry['role'];
  actorKind?: SessionActorKind;
}

export type SessionActorKind = 'human' | 'machine_intelligence' | 'system' | 'unknown';

interface SessionMetadataEnvelope {
  turn?: unknown;
  roleEnvelopePreview?: unknown;
  [key: string]: unknown;
}

export interface SessionEntryTurnContext {
  turnId: TurnID;
  turnIdSource: 'persisted' | 'backfilled';
  turnRecordExpectation: 'required' | 'not_expected';
  requestId?: string;
  sourceMessageId?: string;
  replyToMessageId?: string;
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
    replyToMessageId?: string;
    role: SessionEntry['role'];
    actorKind?: SessionActorKind;
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
    ...(input.actorKind ? { actorKind: input.actorKind } : {}),
    ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
  };

  return JSON.stringify({
    ...base,
    turn,
  });
}

export function resolveSessionEntryActorKind(
  entry: Pick<SessionEntry, 'metadata'>,
): SessionActorKind {
  const metadata = parseMetadataEnvelope(entry.metadata);
  if (metadata.turn === undefined) return 'unknown';
  if (!isRecord(metadata.turn)) {
    throw new Error('Session metadata turn field must be an object');
  }
  const actorKind = metadata.turn.actorKind;
  if (actorKind === undefined) return 'unknown';
  if (actorKind === 'human'
    || actorKind === 'machine_intelligence'
    || actorKind === 'system'
    || actorKind === 'unknown') {
    return actorKind;
  }
  throw new Error('Session turn metadata field "actorKind" is invalid');
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
      turnIdSource: 'backfilled',
      turnRecordExpectation: 'not_expected',
    };
  }

  if (!isRecord(rawTurn)) {
    throw new Error('Session metadata turn field must be an object');
  }

  let turnId: TurnID;
  let turnIdSource: SessionEntryTurnContext['turnIdSource'];
  if (rawTurn.turnId === undefined) {
    turnId = backfillLegacyTurnId(legacySeed(entry));
    turnIdSource = 'backfilled';
  } else {
    if (typeof rawTurn.turnId !== 'string' || !rawTurn.turnId.trim()) {
      throw new Error('Session turn metadata field "turnId" must be a non-empty UUIDv7 string');
    }
    const parsedTurnId = parseTurnId(rawTurn.turnId, 'metadata.turn.turnId');
    if (!parsedTurnId) {
      throw new Error('Session turn metadata field "turnId" must be a non-empty UUIDv7 string');
    }
    turnId = parsedTurnId;
    turnIdSource = 'persisted';
  }
  const requestId = parseOptionalStringField(rawTurn.requestId, 'metadata.turn.requestId');
  const sourceMessageId = parseOptionalStringField(rawTurn.sourceMessageId, 'metadata.turn.sourceMessageId');
  const replyToMessageId = parseOptionalStringField(rawTurn.replyToMessageId, 'metadata.turn.replyToMessageId');

  return {
    turnId,
    turnIdSource,
    turnRecordExpectation: metadata.type === 'observed_message'
      ? 'not_expected'
      : 'required',
    ...(requestId ? { requestId } : {}),
    ...(sourceMessageId ? { sourceMessageId } : {}),
    ...(replyToMessageId ? { replyToMessageId } : {}),
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
