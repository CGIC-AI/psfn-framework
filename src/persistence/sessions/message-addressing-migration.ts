import { parseMessageAddressingMetadata } from '../../shared/contracts/message-addressing.js';
import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  MessageAddressingMetadata,
  MessageAddressingParticipant,
} from '../../shared/contracts/runtime.js';
import { isRecord } from '../../shared/utils/types.js';

import { classifyRow, normalizedParticipant, type PersistedAddressingRow, type MessageAddressingQuarantineReason } from './message-addressing-migration-policy.js';

const MESSAGE_ADDRESSING_V1_TO_V2_MIGRATION_ID = 'message-addressing-v1-to-v2' as const;

type MessageAddressingMigrationMode = 'apply' | 'dry-run';

export interface MessageAddressingMigrationOptions {
  mode: MessageAddressingMigrationMode;
  observer: MessageAddressingParticipant;
}

export interface MessageAddressingMigrationReport {
  currentV2: number;
  migratedV1: number;
  mode: MessageAddressingMigrationMode;
  quarantined: Readonly<Record<MessageAddressingQuarantineReason, number>>;
  scanned: number;
  unchanged: number;
}

const QUARANTINE_REASONS: readonly MessageAddressingQuarantineReason[] = [
  'invalid_v2',
  'legacy_v1_ambiguous_channel_scope',
  'legacy_v1_empty_mentions',
  'legacy_v1_invalid_mentions',
  'legacy_v1_missing_author',
  'legacy_v1_non_user_row',
  'legacy_v1_unknown_fields',
  'unsupported_schema_version',
];

function emptyQuarantineCounts(): Record<MessageAddressingQuarantineReason, number> {
  return Object.fromEntries(QUARANTINE_REASONS.map(reason => [reason, 0])) as Record<
    MessageAddressingQuarantineReason,
    number
  >;
}

function fingerprintAddressing(addressing: unknown): string {
  return createHash('sha256').update(JSON.stringify(addressing)).digest('hex');
}

function schemaVersionLabel(addressing: unknown): string {
  if (!isRecord(addressing)) return 'non_object';
  const version = addressing.schemaVersion;
  return typeof version === 'string' || typeof version === 'number'
    ? String(version)
    : 'missing';
}

async function loadAddressingRows(
  client: PoolClient,
  lockRows: boolean,
): Promise<PersistedAddressingRow[]> {
  const result = await client.query<PersistedAddressingRow>(`
    SELECT channel_id, message_id, role, author_id, author_name,
      channel_visibility, metadata_json
    FROM session_messages_projection
    WHERE metadata_json ? 'messageAddressing'
       OR metadata_json ? 'messageAddressingQuarantine'
    ORDER BY channel_id ASC, message_id ASC
    ${lockRows ? 'FOR UPDATE' : ''}
  `);
  return result.rows;
}

async function applyMigration(
  client: PoolClient,
  row: PersistedAddressingRow,
  addressing: MessageAddressingMetadata,
): Promise<void> {
  await client.query(`
    UPDATE session_messages_projection
    SET metadata_json = jsonb_set(
      jsonb_set(metadata_json, '{messageAddressing}', $3::jsonb, false),
      '{messageAddressingMigration}',
      $4::jsonb,
      true
    )
    WHERE channel_id = $1 AND message_id = $2
  `, [
    row.channel_id,
    row.message_id,
    JSON.stringify(addressing),
    JSON.stringify({ migrationId: MESSAGE_ADDRESSING_V1_TO_V2_MIGRATION_ID, fromSchemaVersion: 1 }),
  ]);
}

async function applyQuarantine(
  client: PoolClient,
  row: PersistedAddressingRow,
  reason: MessageAddressingQuarantineReason,
  addressing: unknown,
): Promise<void> {
  const fingerprint = fingerprintAddressing(addressing);
  await client.query(`
    INSERT INTO session_message_addressing_quarantine (
      channel_id, message_id, reason, addressing_fingerprint, schema_version
    ) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (channel_id, message_id) DO UPDATE SET
      reason = EXCLUDED.reason,
      addressing_fingerprint = EXCLUDED.addressing_fingerprint,
      schema_version = EXCLUDED.schema_version
  `, [row.channel_id, row.message_id, reason, fingerprint, schemaVersionLabel(addressing)]);
  await client.query(`
    UPDATE session_messages_projection
    SET metadata_json = (metadata_json - 'messageAddressing') || jsonb_build_object(
      'messageAddressingQuarantine',
      jsonb_build_object(
        'migrationId', $3::text,
        'reason', $4::text,
        'addressingFingerprint', $5::text,
        'original', $6::jsonb
      )
    )
    WHERE channel_id = $1 AND message_id = $2
  `, [
    row.channel_id,
    row.message_id,
    MESSAGE_ADDRESSING_V1_TO_V2_MIGRATION_ID,
    reason,
    fingerprint,
    JSON.stringify(addressing),
  ]);
}

/** Inventory or atomically migrate one schema-pinned companion tenant. */
export async function migratePostgresMessageAddressing(
  pool: Pool,
  options: MessageAddressingMigrationOptions,
): Promise<MessageAddressingMigrationReport> {
  const observer = normalizedParticipant(options.observer);
  if (!observer) throw new Error('Message addressing migration observer must be a closed participant object');
  const client = await pool.connect();
  const quarantined = emptyQuarantineCounts();
  let migratedV1 = 0;
  let currentV2 = 0;
  let unchanged = 0;
  try {
    await client.query(options.mode === 'dry-run' ? 'BEGIN READ ONLY' : 'BEGIN');
    const rows = await loadAddressingRows(client, options.mode === 'apply');
    for (const row of rows) {
      const disposition = classifyRow(row, observer);
      if (disposition.kind === 'current') {
        currentV2 += 1;
      } else if (disposition.kind === 'unchanged') {
        unchanged += 1;
      } else if (disposition.kind === 'migrate') {
        migratedV1 += 1;
        if (options.mode === 'apply') await applyMigration(client, row, disposition.addressing);
      } else {
        quarantined[disposition.reason] += 1;
        if (options.mode === 'apply') {
          await applyQuarantine(client, row, disposition.reason, disposition.addressing);
        }
      }
    }
    if (options.mode === 'apply') await client.query('COMMIT');
    else await client.query('ROLLBACK');
    return {
      currentV2,
      migratedV1,
      mode: options.mode,
      quarantined,
      scanned: rows.length,
      unchanged,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Read the exact persisted envelope through the runtime-v2 parser. */
export async function readPostgresSessionMessageAddressing(
  pool: Pool,
  channelId: string,
  messageId: number,
): Promise<MessageAddressingMetadata | null> {
  const result = await pool.query<{ metadata_json: unknown }>(`
    SELECT metadata_json
    FROM session_messages_projection
    WHERE channel_id = $1 AND message_id = $2
  `, [channelId, messageId]);
  const metadata = result.rows[0]?.metadata_json;
  if (!isRecord(metadata) || !Object.hasOwn(metadata, 'messageAddressing')) return null;
  return parseMessageAddressingMetadata(metadata.messageAddressing);
}
