import { isDeepStrictEqual } from 'node:util';
import type { JournalEntry } from '../../core/session/types.js';
import type { MessageAddressingParticipant } from '../../shared/contracts/runtime.js';
import { parseMessageAddressingMetadata } from '../../shared/contracts/message-addressing.js';
import { isRecord } from '../../shared/utils/types.js';
import { classifyRow, normalizedParticipant } from './message-addressing-migration-policy.js';

/** The one explicitly supported canonical metadata migration; never a general rewrite permission. */
export interface JournalAddressingMigration {
  kind: 'message-addressing-v1-to-v2';
  observer: MessageAddressingParticipant;
}

export function migrateJournalAddressingEntry(
  entry: JournalEntry,
  migration: JournalAddressingMigration,
): JournalEntry {
  const requestedKind: unknown = migration.kind;
  if (requestedKind !== 'message-addressing-v1-to-v2'
    || Object.keys(migration).some(key => key !== 'kind' && key !== 'observer')
    || !isDeepStrictEqual(normalizedParticipant(migration.observer), migration.observer)) {
    throw new Error('Invalid canonical addressing migration observer or contract');
  }
  if (entry.metadata === undefined) return entry;
  const metadata: unknown = JSON.parse(entry.metadata);
  if (!isRecord(metadata)) throw new Error('Canonical journal metadata must be an object');
  if (Object.hasOwn(metadata, 'messageAddressingQuarantine')) {
    throw new Error('Canonical addressing quarantine requires separate evidence review');
  }
  const disposition = classifyRow({
    channel_id: entry.channelId,
    message_id: entry.id,
    role: entry.role ?? '',
    author_id: entry.authorId ?? null,
    author_name: entry.authorName ?? null,
    channel_visibility: entry.channelVisibility ?? '',
    metadata_json: metadata,
  }, migration.observer);
  if (disposition.kind === 'quarantine') throw new Error(disposition.reason);
  if (disposition.kind === 'current') {
    const current = parseMessageAddressingMetadata(metadata.messageAddressing);
    if (current.observer.authorId !== migration.observer.authorId) {
      throw new Error('Canonical addressing observer conflicts with supplied observer');
    }
  }
  if (disposition.kind !== 'migrate') return entry;
  if (entry.type !== 'message') throw new Error('Canonical addressing migration requires a message');
  return { ...entry, metadata: JSON.stringify({ ...metadata, messageAddressing: disposition.addressing }) };
}

export function assertJournalAddressingMigration(
  original: JournalEntry,
  replacement: JournalEntry,
  migration: JournalAddressingMigration,
): void {
  const { _hmac: oldHmac, _hmacKeyVersion: oldVersion, ...expected } = migrateJournalAddressingEntry(original, migration);
  const { _hmac: newHmac, _hmacKeyVersion: newVersion, ...actual } = replacement;
  if (!isDeepStrictEqual(expected, actual)) {
    throw new Error('Canonical addressing migration may only replace the proven v1 addressing field');
  }
}
