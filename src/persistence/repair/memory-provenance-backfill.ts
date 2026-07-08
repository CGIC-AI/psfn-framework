// ── Memory provenance backfill (psfn-framework-27ut) ──
// Historical l2_memories rows carry provenance_json = '{}' because the
// Postgres store never persisted provenance (psfn-framework-tsyo), and the
// legacy routing lanes never captured addressMode/sourceContactId
// (psfn-framework-0zd9). The append-only memory journal (memories.jsonl)
// preserved the in-memory provenance at insert time, so it is the recovery
// source. This module rebuilds provenance_json/source_type from journal
// insert events, with two CONSERVATIVE derivations for the fields the legacy
// lanes never wrote:
//
//   - sourceContactId := routedContactId, but ONLY for routingReason
//     'speaker_name_prefix' / 'transcript_content_match' — on those lanes the
//     routed contact is definitionally the matched source speaker. (On
//     'single_speaker_transcript' the routed contact is the trigger contact,
//     which is not provably the speaker; never derived.)
//   - addressMode := 'overheard_room_context', but ONLY when the memory's
//     channel is a known multi-member room (contact_channel_activity), since
//     the session entries needed to re-run inferAddressMode no longer exist.
//
// Rows whose provenance_json is already non-empty are never touched, and the
// UPDATE re-checks that guard so the operation is idempotent. Every applied
// update records an l2_memory_patch_events row.

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  normalizeMemoryProvenance,
  normalizeMemorySourceType,
  type MemoryProvenance,
  type MemorySourceType,
} from '../../faculties/memory/types.js';

const DERIVABLE_SOURCE_CONTACT_ROUTING_REASONS = new Set([
  'speaker_name_prefix',
  'transcript_content_match',
]);

const BACKFILL_PATCH_REASON = 'memory_provenance_backfill';
const REPORT_SAMPLE_LIMIT = 25;

export interface MemoryProvenanceBackfillOptions {
  /** Raw memories.jsonl lines (one journal event per line). */
  journalLines: Iterable<string>;
  /** Report only (default true when omitted upstream); apply requires false. */
  dryRun: boolean;
  /** Distinct contacts required for a channel to count as a room. */
  roomMinMembers?: number;
}

export interface MemoryProvenanceBackfillPlanEntry {
  memoryId: string;
  channelId?: string;
  sourceType?: MemorySourceType;
  sourceContactIdDerived: boolean;
  addressModeDerived: boolean;
}

export interface MemoryProvenanceBackfillReport {
  dryRun: boolean;
  journalInsertEvents: number;
  journalMemoriesWithProvenance: number;
  malformedJournalLines: number;
  scannedRows: number;
  emptyProvenanceRows: number;
  planned: number;
  updated: number;
  skippedNoJournalProvenance: number;
  sourceContactIdDerivedCount: number;
  addressModeDerivedCount: number;
  /** Bounded sample of the planned updates (first N by memory id order). */
  entries: MemoryProvenanceBackfillPlanEntry[];
}

interface JournalMemorySnapshot {
  provenance?: MemoryProvenance;
  sourceType?: MemorySourceType;
}

interface MemoryProvenanceRow {
  id: string;
  source_type: string | null;
  provenance_json: unknown;
}

interface RoomMemberCountRow {
  channel_id: string;
  member_count: string | number;
}

interface PlannedUpdate extends MemoryProvenanceBackfillPlanEntry {
  provenance: MemoryProvenance;
  nextSourceType: string | null;
  previousSourceType: string | null;
}

function isEmptyProvenance(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return true;
  return Object.keys(value as Record<string, unknown>).length === 0;
}

/**
 * Parses journal lines into memoryId -> latest insert snapshot. Throws on a
 * malformed NON-FINAL line (a corrupted journal must be inspected by hand);
 * tolerates exactly one torn final line, which a crash mid-append produces.
 */
export function collectJournalMemorySnapshots(
  journalLines: Iterable<string>,
): { snapshots: Map<string, JournalMemorySnapshot>; insertEvents: number; malformed: number } {
  const lines = [...journalLines].filter(line => line.trim().length > 0);
  const snapshots = new Map<string, JournalMemorySnapshot>();
  let insertEvents = 0;
  let malformed = 0;
  for (const [index, line] of lines.entries()) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (error) {
      if (index === lines.length - 1) {
        malformed += 1;
        continue;
      }
      throw new Error(
        `Malformed memory journal line ${index + 1} of ${lines.length}: ${String(error)}`,
      );
    }
    if (!event || typeof event !== 'object') continue;
    const record = event as { kind?: unknown; memory?: unknown };
    if (record.kind !== 'insert' || !record.memory || typeof record.memory !== 'object') continue;
    insertEvents += 1;
    const memory = record.memory as {
      id?: unknown;
      provenance?: unknown;
      sourceType?: unknown;
    };
    if (typeof memory.id !== 'string' || memory.id.length === 0) continue;
    const provenance = normalizeMemoryProvenance(memory.provenance);
    const sourceType = typeof memory.sourceType === 'string'
      ? normalizeMemorySourceType(memory.sourceType)
      : undefined;
    snapshots.set(memory.id, {
      ...(provenance ? { provenance } : {}),
      ...(sourceType ? { sourceType } : {}),
    });
  }
  return { snapshots, insertEvents, malformed };
}

async function loadRoomMemberCounts(pool: Pool): Promise<Map<string, number>> {
  const result = await pool.query<RoomMemberCountRow>(`
    SELECT channel_id, COUNT(*) AS member_count
    FROM contact_channel_activity
    GROUP BY channel, channel_id
  `);
  const counts = new Map<string, number>();
  for (const row of result.rows) {
    const count = Number(row.member_count);
    counts.set(row.channel_id, Math.max(counts.get(row.channel_id) ?? 0, count));
  }
  return counts;
}

function planUpdate(
  row: MemoryProvenanceRow,
  snapshot: JournalMemorySnapshot,
  roomMemberCounts: Map<string, number>,
  roomMinMembers: number,
): PlannedUpdate | undefined {
  if (!snapshot.provenance) return undefined;
  const provenance: MemoryProvenance = { ...snapshot.provenance };

  let sourceContactIdDerived = false;
  if (
    !provenance.sourceContactId
    && provenance.routedContactId
    && provenance.routingReason
    && DERIVABLE_SOURCE_CONTACT_ROUTING_REASONS.has(provenance.routingReason)
  ) {
    provenance.sourceContactId = provenance.routedContactId;
    sourceContactIdDerived = true;
  }

  let addressModeDerived = false;
  if (
    !provenance.addressMode
    && provenance.channelId
    && (roomMemberCounts.get(provenance.channelId) ?? 0) >= roomMinMembers
  ) {
    provenance.addressMode = 'overheard_room_context';
    addressModeDerived = true;
  }

  const previousSourceType = row.source_type;
  const hasUsableSourceType = previousSourceType !== null && previousSourceType !== 'unknown';
  const nextSourceType = hasUsableSourceType
    ? previousSourceType
    : (snapshot.sourceType ?? previousSourceType);

  return {
    memoryId: row.id,
    ...(provenance.channelId ? { channelId: provenance.channelId } : {}),
    ...(snapshot.sourceType ? { sourceType: snapshot.sourceType } : {}),
    sourceContactIdDerived,
    addressModeDerived,
    provenance,
    nextSourceType,
    previousSourceType,
  };
}

async function applyUpdates(
  pool: Pool,
  updates: readonly PlannedUpdate[],
): Promise<number> {
  if (updates.length === 0) return 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await applyUpdatesWithClient(client, updates);
    await client.query('COMMIT');
    return updated;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function applyUpdatesWithClient(
  client: PoolClient,
  updates: readonly PlannedUpdate[],
): Promise<number> {
  let updated = 0;
  const createdAt = Date.now();
  for (const update of updates) {
    const result = await client.query(`
      UPDATE l2_memories
      SET provenance_json = $1::jsonb,
          source_type = COALESCE($2, source_type)
      WHERE id = $3
        AND (provenance_json IS NULL OR provenance_json = '{}'::jsonb)
      RETURNING id
    `, [
      JSON.stringify(update.provenance),
      update.nextSourceType,
      update.memoryId,
    ]);
    if (result.rowCount !== 1) continue;

    await client.query(`
      INSERT INTO l2_memory_patch_events (
        id, memory_id, source_ref, source_type, provenance_json, reason,
        patch_json, previous_json, next_json, created_at
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10)
    `, [
      randomUUID(),
      update.memoryId,
      'maintenance:memory-provenance-backfill',
      'tool_write',
      JSON.stringify({}),
      BACKFILL_PATCH_REASON,
      JSON.stringify({
        provenance: update.provenance,
        sourceType: update.nextSourceType,
        sourceContactIdDerived: update.sourceContactIdDerived,
        addressModeDerived: update.addressModeDerived,
      }),
      JSON.stringify({ provenance: {}, sourceType: update.previousSourceType }),
      JSON.stringify({ provenance: update.provenance, sourceType: update.nextSourceType }),
      createdAt,
    ]);
    updated += 1;
  }
  return updated;
}

export async function backfillPostgresMemoryProvenance(
  pool: Pool,
  options: MemoryProvenanceBackfillOptions,
): Promise<MemoryProvenanceBackfillReport> {
  const roomMinMembers = options.roomMinMembers ?? 2;
  const { snapshots, insertEvents, malformed } = collectJournalMemorySnapshots(options.journalLines);
  if (malformed > 0 && !options.dryRun) {
    throw new Error(
      `Refusing to apply: memory journal has ${malformed} malformed trailing line(s); inspect the journal first`,
    );
  }

  const roomMemberCounts = await loadRoomMemberCounts(pool);
  const rows = await pool.query<MemoryProvenanceRow>(`
    SELECT id, source_type, provenance_json
    FROM l2_memories
    ORDER BY extracted_at ASC, id ASC
  `);

  let emptyProvenanceRows = 0;
  let skippedNoJournalProvenance = 0;
  const planned: PlannedUpdate[] = [];
  for (const row of rows.rows) {
    if (!isEmptyProvenance(row.provenance_json)) continue;
    emptyProvenanceRows += 1;
    const snapshot = snapshots.get(row.id);
    if (!snapshot?.provenance) {
      skippedNoJournalProvenance += 1;
      continue;
    }
    const update = planUpdate(row, snapshot, roomMemberCounts, roomMinMembers);
    if (update) planned.push(update);
  }

  const updated = options.dryRun ? 0 : await applyUpdates(pool, planned);

  return {
    dryRun: options.dryRun,
    journalInsertEvents: insertEvents,
    journalMemoriesWithProvenance: [...snapshots.values()].filter(s => s.provenance).length,
    malformedJournalLines: malformed,
    scannedRows: rows.rows.length,
    emptyProvenanceRows,
    planned: planned.length,
    updated,
    skippedNoJournalProvenance,
    sourceContactIdDerivedCount: planned.filter(update => update.sourceContactIdDerived).length,
    addressModeDerivedCount: planned.filter(update => update.addressModeDerived).length,
    entries: planned.slice(0, REPORT_SAMPLE_LIMIT).map(update => ({
      memoryId: update.memoryId,
      ...(update.channelId ? { channelId: update.channelId } : {}),
      ...(update.sourceType ? { sourceType: update.sourceType } : {}),
      sourceContactIdDerived: update.sourceContactIdDerived,
      addressModeDerived: update.addressModeDerived,
    })),
  };
}
