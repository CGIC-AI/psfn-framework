import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  backfillPostgresMemoryProvenance,
  collectJournalMemorySnapshots,
} from './memory-provenance-backfill.js';

interface FakeMemoryRow {
  id: string;
  source_type: string | null;
  provenance_json: unknown;
  extracted_at: number;
}

class FakeBackfillPool {
  memories = new Map<string, FakeMemoryRow>();
  roomMembers = new Map<string, number>();
  patchEvents: unknown[][] = [];
  transactionStatements: string[] = [];

  async query(text: string, values: readonly unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized === 'begin' || normalized === 'commit' || normalized === 'rollback') {
      this.transactionStatements.push(normalized);
      return { rows: [], rowCount: 0 };
    }
    if (normalized.includes('from contact_channel_activity')) {
      const rows = [...this.roomMembers.entries()].map(([channelId, count]) => ({
        channel_id: channelId,
        member_count: count,
      }));
      return { rows, rowCount: rows.length };
    }
    if (normalized.startsWith('select id, source_type, provenance_json from l2_memories')) {
      const rows = [...this.memories.values()]
        .sort((left, right) => left.extracted_at - right.extracted_at || left.id.localeCompare(right.id));
      return { rows, rowCount: rows.length };
    }
    if (normalized.startsWith('update l2_memories')) {
      const [provenanceJson, sourceType, id] = values as [string, string | null, string];
      const row = this.memories.get(id);
      const empty = !row
        ? false
        : row.provenance_json === null
          || (typeof row.provenance_json === 'object'
            && Object.keys(row.provenance_json as Record<string, unknown>).length === 0);
      if (!row || !empty) return { rows: [], rowCount: 0 };
      row.provenance_json = JSON.parse(provenanceJson);
      if (sourceType !== null) row.source_type = sourceType;
      return { rows: [{ id }], rowCount: 1 };
    }
    if (normalized.startsWith('insert into l2_memory_patch_events')) {
      this.patchEvents.push([...values]);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unhandled SQL in FakeBackfillPool: ${text}`);
  }

  async connect(): Promise<{ query: FakeBackfillPool['query']; release: () => void }> {
    return {
      query: this.query.bind(this),
      release: () => undefined,
    };
  }
}

function journalInsert(memory: Record<string, unknown>): string {
  return JSON.stringify({ kind: 'insert', ts: 1_783_000_000_000, memory });
}

const ROOM_CHANNEL = 'room-channel-1';

function seedPool(): FakeBackfillPool {
  const pool = new FakeBackfillPool();
  pool.roomMembers.set(ROOM_CHANNEL, 5);
  pool.roomMembers.set('dm-channel', 1);
  pool.memories.set('mem-room', {
    id: 'mem-room',
    source_type: 'unknown',
    provenance_json: {},
    extracted_at: 100,
  });
  pool.memories.set('mem-dm', {
    id: 'mem-dm',
    source_type: null,
    provenance_json: {},
    extracted_at: 200,
  });
  pool.memories.set('mem-already-populated', {
    id: 'mem-already-populated',
    source_type: 'turn',
    provenance_json: { channelId: ROOM_CHANNEL },
    extracted_at: 300,
  });
  pool.memories.set('mem-no-journal', {
    id: 'mem-no-journal',
    source_type: null,
    provenance_json: {},
    extracted_at: 400,
  });
  return pool;
}

const JOURNAL_LINES = [
  journalInsert({
    id: 'mem-room',
    sourceType: 'turn',
    provenance: {
      channelId: ROOM_CHANNEL,
      sessionId: `${ROOM_CHANNEL}:session:test`,
      routedContactId: 'contact-speaker',
      sourceSpeakerName: 'MemberOne',
      routingReason: 'speaker_name_prefix',
    },
  }),
  journalInsert({
    id: 'mem-dm',
    sourceType: 'turn',
    provenance: {
      channelId: 'dm-channel',
      routedContactId: 'contact-trigger',
      routingReason: 'single_speaker_transcript',
    },
  }),
  journalInsert({
    id: 'mem-already-populated',
    sourceType: 'turn',
    provenance: { channelId: ROOM_CHANNEL, routingReason: 'speaker_name_prefix' },
  }),
];

describe('collectJournalMemorySnapshots', () => {
  it('collects the latest insert snapshot per memory and tolerates one torn final line', () => {
    const { snapshots, insertEvents, malformed } = collectJournalMemorySnapshots([
      ...JOURNAL_LINES,
      '{"kind":"insert","memory":{"id":"mem-torn"',
    ]);
    expect(insertEvents).toBe(3);
    expect(malformed).toBe(1);
    expect(snapshots.get('mem-room')?.provenance?.routedContactId).toBe('contact-speaker');
    expect(snapshots.has('mem-torn')).toBe(false);
  });

  it('fails closed on a malformed non-final line', () => {
    expect(() => collectJournalMemorySnapshots([
      'not json at all',
      ...JOURNAL_LINES,
    ])).toThrow(/Malformed memory journal line 1/);
  });
});

describe('backfillPostgresMemoryProvenance', () => {
  it('plans conservative derivations in dry-run without touching rows', async () => {
    const pool = seedPool();
    const report = await backfillPostgresMemoryProvenance(pool as unknown as Pool, {
      journalLines: JOURNAL_LINES,
      dryRun: true,
    });

    expect(report.dryRun).toBe(true);
    expect(report.scannedRows).toBe(4);
    expect(report.emptyProvenanceRows).toBe(3);
    expect(report.planned).toBe(2);
    expect(report.updated).toBe(0);
    expect(report.skippedNoJournalProvenance).toBe(1);
    // speaker_name_prefix in a 5-member room: both fields derived.
    const roomEntry = report.entries.find(entry => entry.memoryId === 'mem-room');
    expect(roomEntry).toMatchObject({
      channelId: ROOM_CHANNEL,
      sourceContactIdDerived: true,
      addressModeDerived: true,
    });
    // single_speaker_transcript in a 1-member channel: nothing derived.
    const dmEntry = report.entries.find(entry => entry.memoryId === 'mem-dm');
    expect(dmEntry).toMatchObject({
      sourceContactIdDerived: false,
      addressModeDerived: false,
    });
    // Dry run must not mutate.
    expect(pool.memories.get('mem-room')?.provenance_json).toEqual({});
    expect(pool.patchEvents).toHaveLength(0);
  });

  it('applies updates with the empty-provenance guard and records patch events', async () => {
    const pool = seedPool();
    const report = await backfillPostgresMemoryProvenance(pool as unknown as Pool, {
      journalLines: JOURNAL_LINES,
      dryRun: false,
    });

    expect(report.updated).toBe(2);
    const roomRow = pool.memories.get('mem-room');
    expect(roomRow?.provenance_json).toMatchObject({
      channelId: ROOM_CHANNEL,
      sourceContactId: 'contact-speaker',
      routedContactId: 'contact-speaker',
      addressMode: 'overheard_room_context',
      routingReason: 'speaker_name_prefix',
    });
    expect(roomRow?.source_type).toBe('turn');
    // Populated rows stay untouched.
    expect(pool.memories.get('mem-already-populated')?.provenance_json).toEqual({
      channelId: ROOM_CHANNEL,
    });
    expect(pool.patchEvents).toHaveLength(2);
    expect(pool.transactionStatements).toEqual(['begin', 'commit']);

    // Second run is a no-op: rows are no longer empty.
    const rerun = await backfillPostgresMemoryProvenance(pool as unknown as Pool, {
      journalLines: JOURNAL_LINES,
      dryRun: false,
    });
    expect(rerun.planned).toBe(0);
    expect(rerun.updated).toBe(0);
  });

  it('refuses to apply when the journal has malformed trailing lines', async () => {
    const pool = seedPool();
    await expect(backfillPostgresMemoryProvenance(pool as unknown as Pool, {
      journalLines: [...JOURNAL_LINES, '{"kind":"insert"'],
      dryRun: false,
    })).rejects.toThrow(/Refusing to apply/);
  });
});
