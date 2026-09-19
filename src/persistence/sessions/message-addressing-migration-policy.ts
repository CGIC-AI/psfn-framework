import type { MessageAddressingMetadata, MessageAddressingParticipant } from '../../shared/contracts/runtime.js';
import { parseMessageAddressingMetadata } from '../../shared/contracts/message-addressing.js';
import { isRecord } from '../../shared/utils/types.js';

export type MessageAddressingQuarantineReason =
  | 'invalid_v2'
  | 'legacy_v1_ambiguous_channel_scope'
  | 'legacy_v1_empty_mentions'
  | 'legacy_v1_invalid_mentions'
  | 'legacy_v1_missing_author'
  | 'legacy_v1_non_user_row'
  | 'legacy_v1_unknown_fields'
  | 'unsupported_schema_version';

export interface PersistedAddressingRow {
  channel_id: string;
  message_id: number | string;
  role: string;
  author_id: string | null;
  author_name: string | null;
  channel_visibility: string;
  metadata_json: unknown;
}

type RowDisposition =
  | { kind: 'current' }
  | { kind: 'migrate'; addressing: MessageAddressingMetadata }
  | { kind: 'quarantine'; reason: MessageAddressingQuarantineReason; addressing: unknown }
  | { kind: 'unchanged' };

export function normalizedParticipant(
  value: unknown,
): MessageAddressingParticipant | null {
  if (!isRecord(value)) return null;
  if (typeof value.authorId !== 'string' || !value.authorId.trim()) return null;
  if (typeof value.authorName !== 'string' || !value.authorName.trim()) return null;
  if (Object.keys(value).some(key => key !== 'authorId' && key !== 'authorName')) return null;
  return { authorId: value.authorId.trim(), authorName: value.authorName.trim() };
}

function legacyMentionTargets(value: unknown): MessageAddressingParticipant[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const targets: MessageAddressingParticipant[] = [];
  for (const candidate of value) {
    const participant = normalizedParticipant(candidate);
    if (!participant || seen.has(participant.authorId)) return null;
    seen.add(participant.authorId);
    targets.push(participant);
  }
  return targets;
}

function parseLegacyReplyTarget(metadata: Record<string, unknown>): { messageId: string } | undefined {
  const turn = metadata.turn;
  if (!isRecord(turn)) return undefined;
  return typeof turn.replyToMessageId === 'string' && turn.replyToMessageId.trim()
    ? { messageId: turn.replyToMessageId.trim() }
    : undefined;
}

export function classifyRow(
  row: PersistedAddressingRow,
  observer: MessageAddressingParticipant,
): RowDisposition {
  if (!isRecord(row.metadata_json)) return { kind: 'unchanged' };
  const metadata = row.metadata_json;
  if (Object.hasOwn(metadata, 'messageAddressingQuarantine')) return { kind: 'unchanged' };
  if (!Object.hasOwn(metadata, 'messageAddressing')) return { kind: 'unchanged' };
  const addressing = metadata.messageAddressing;

  if (isRecord(addressing) && addressing.schemaVersion === 2) {
    try {
      parseMessageAddressingMetadata(addressing);
      return { kind: 'current' };
    } catch {
      return { kind: 'quarantine', reason: 'invalid_v2', addressing };
    }
  }
  if (!isRecord(addressing) || addressing.schemaVersion !== 1) {
    return { kind: 'quarantine', reason: 'unsupported_schema_version', addressing };
  }
  if (Object.keys(addressing).some(key => key !== 'schemaVersion' && key !== 'mentionedTargets')) {
    return { kind: 'quarantine', reason: 'legacy_v1_unknown_fields', addressing };
  }
  if (row.role !== 'user') {
    return { kind: 'quarantine', reason: 'legacy_v1_non_user_row', addressing };
  }
  if (!row.author_id?.trim() || !row.author_name?.trim()) {
    return { kind: 'quarantine', reason: 'legacy_v1_missing_author', addressing };
  }
  // Persisted privacy proves a group only when it is non-private. A private
  // channel may be a DM or a restricted room, so coercing it would guess.
  if (row.channel_visibility !== 'invite_only' && row.channel_visibility !== 'public') {
    return { kind: 'quarantine', reason: 'legacy_v1_ambiguous_channel_scope', addressing };
  }
  const mentionedTargets = legacyMentionTargets(addressing.mentionedTargets);
  if (!mentionedTargets) {
    return { kind: 'quarantine', reason: 'legacy_v1_invalid_mentions', addressing };
  }
  if (mentionedTargets.length === 0) {
    return { kind: 'quarantine', reason: 'legacy_v1_empty_mentions', addressing };
  }
  const replyTarget = parseLegacyReplyTarget(metadata);
  const migrated = parseMessageAddressingMetadata({
    schemaVersion: 2,
    // v1 was a Discord-only contract. This is historical schema provenance,
    // not a channel-id inference.
    source: 'discord',
    author: { authorId: row.author_id.trim(), authorName: row.author_name.trim() },
    observer,
    mentionedTargets,
    ...(replyTarget ? { replyTarget } : {}),
    channel: { scope: 'group', channelId: row.channel_id },
    resolvedAddressee: {
      kind: 'participants',
      participants: mentionedTargets.map(target => ({ ...target, evidence: ['mention'] })),
    },
  });
  return { kind: 'migrate', addressing: migrated };
}
