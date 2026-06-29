import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { repairSqliteMemoryParticipantNames } from './memory-participant-name-repair.js';

function createRepairDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE l2_memories (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      superseded_by TEXT,
      deleted_at INTEGER,
      extracted_at INTEGER NOT NULL
    );

    CREATE TABLE l2_memory_patch_events (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      source_type TEXT NOT NULL,
      provenance_json TEXT NOT NULL DEFAULT '{}',
      reason TEXT,
      patch_json TEXT NOT NULL,
      previous_json TEXT NOT NULL,
      next_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

function insertMemory(
  db: Database.Database,
  input: {
    id: string;
    text: string;
    extractedAt: number;
    supersededBy?: string | null;
    deletedAt?: number | null;
  },
): void {
  db.prepare(`
    INSERT INTO l2_memories (id, text, superseded_by, deleted_at, extracted_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.text,
    input.supersededBy ?? null,
    input.deletedAt ?? null,
    input.extractedAt,
  );
}

function getMemoryText(db: Database.Database, id: string): string {
  const row = db.prepare('SELECT text FROM l2_memories WHERE id = ?').get(id) as { text: string } | undefined;
  if (!row) throw new Error(`missing memory row: ${id}`);
  return row.text;
}

describe('memory participant name repair', () => {
  let db: Database.Database | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it('plans candidate updates during dry-run without modifying memory text or audit rows', async () => {
    db = createRepairDb();
    insertMemory(db, {
      id: 'm-generic',
      text: "The user trusts companion's patience.",
      extractedAt: 20,
    });
    insertMemory(db, {
      id: 'm-clean',
      text: "Alex trusts Lyra's patience.",
      extractedAt: 10,
    });

    const report = await repairSqliteMemoryParticipantNames(db, {
      canonicalContactName: 'Alex',
      companionName: 'Lyra',
      dryRun: true,
      now: 123,
      createPatchEventId: () => 'patch-1',
    });

    expect(report).toMatchObject({
      dryRun: true,
      scanned: 1,
      candidates: 1,
      plannedUpdates: 1,
      updated: 0,
      refused: [],
    });
    expect(report.updates[0]).toMatchObject({
      memoryId: 'm-generic',
      beforeText: "The user trusts companion's patience.",
      afterText: "Alex trusts Lyra's patience.",
    });
    expect(getMemoryText(db, 'm-generic')).toBe("The user trusts companion's patience.");
    expect(db.prepare('SELECT COUNT(*) AS count FROM l2_memory_patch_events').get()).toEqual({ count: 0 });
  });

  it('updates only changed active candidate memories and records patch audit details', async () => {
    db = createRepairDb();
    insertMemory(db, {
      id: 'm-active',
      text: 'The user told the companion about the kiln schedule.',
      extractedAt: 30,
    });
    insertMemory(db, {
      id: 'm-deleted',
      text: 'The user told companion an obsolete note.',
      extractedAt: 20,
      deletedAt: 50,
    });
    insertMemory(db, {
      id: 'm-superseded',
      text: 'The user told companion a superseded note.',
      extractedAt: 10,
      supersededBy: 'm-new',
    });

    const report = await repairSqliteMemoryParticipantNames(db, {
      canonicalContactName: 'Alex',
      companionName: 'Lyra',
      dryRun: false,
      now: 456,
      createPatchEventId: () => 'patch-active',
    });

    expect(report).toMatchObject({
      dryRun: false,
      scanned: 1,
      candidates: 1,
      plannedUpdates: 1,
      updated: 1,
    });
    expect(getMemoryText(db, 'm-active')).toBe('Alex told Lyra about the kiln schedule.');
    expect(getMemoryText(db, 'm-deleted')).toBe('The user told companion an obsolete note.');
    expect(getMemoryText(db, 'm-superseded')).toBe('The user told companion a superseded note.');

    const event = db.prepare('SELECT * FROM l2_memory_patch_events WHERE memory_id = ?').get('m-active') as {
      id: string;
      source_ref: string;
      source_type: string;
      reason: string;
      patch_json: string;
      previous_json: string;
      next_json: string;
      created_at: number;
    };
    expect(event.id).toBe('patch-active');
    expect(event.source_ref).toBe('source:repair|operation:memory_participant_name_backfill');
    expect(event.source_type).toBe('tool_write');
    expect(event.reason).toBe('memory_participant_name_backfill');
    expect(JSON.parse(event.previous_json)).toEqual({
      text: 'The user told the companion about the kiln schedule.',
    });
    expect(JSON.parse(event.patch_json)).toEqual({
      text: 'Alex told Lyra about the kiln schedule.',
    });
    expect(JSON.parse(event.next_json)).toEqual({
      text: 'Alex told Lyra about the kiln schedule.',
    });
    expect(event.created_at).toBe(456);
  });

  it('refuses ambiguous participant labels instead of partially rewriting memory text', async () => {
    db = createRepairDb();
    insertMemory(db, {
      id: 'm-ambiguous',
      text: 'The user trusts the companion with difficult topics.',
      extractedAt: 10,
    });

    const report = await repairSqliteMemoryParticipantNames(db, {
      companionName: 'Lyra',
      dryRun: false,
      createPatchEventId: () => 'patch-unused',
    });

    expect(report).toMatchObject({
      dryRun: false,
      scanned: 1,
      candidates: 1,
      plannedUpdates: 0,
      updated: 0,
    });
    expect(report.refused).toHaveLength(1);
    expect(report.refused[0]).toMatchObject({
      memoryId: 'm-ambiguous',
      reasons: ['missing_user_name'],
    });
    expect(report.refusalCounts.missing_user_name).toBe(1);
    expect(getMemoryText(db, 'm-ambiguous')).toBe('The user trusts the companion with difficult topics.');
    expect(db.prepare('SELECT COUNT(*) AS count FROM l2_memory_patch_events').get()).toEqual({ count: 0 });
  });

  it('allows companion-only repairs when the human participant name is not required', async () => {
    db = createRepairDb();
    insertMemory(db, {
      id: 'm-companion-only',
      text: 'The companion remembers Alex prefers concise summaries.',
      extractedAt: 10,
    });

    const report = await repairSqliteMemoryParticipantNames(db, {
      companionName: 'Lyra',
      dryRun: false,
      createPatchEventId: () => 'patch-companion',
    });

    expect(report.refused).toEqual([]);
    expect(report.updated).toBe(1);
    expect(getMemoryText(db, 'm-companion-only')).toBe('Lyra remembers Alex prefers concise summaries.');
  });
});
