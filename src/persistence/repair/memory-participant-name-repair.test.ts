import type { Pool, PoolClient, QueryResult } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  planMemoryParticipantNameRepair,
  repairPostgresMemoryParticipantNames,
} from './memory-participant-name-repair.js';

function queryResult(rows: object[] = [], rowCount: number = rows.length): QueryResult {
  return {
    rows,
    command: 'OK',
    rowCount,
    oid: 0,
    fields: [],
  } as QueryResult;
}

class FakePostgresRepairPool {
  readonly poolQueries: Array<{ text: string; values: readonly unknown[] }> = [];
  readonly clientQueries: Array<{ text: string; values: readonly unknown[] }> = [];
  readonly patchEvents: readonly unknown[][] = [];
  committed = false;
  rolledBack = false;
  released = false;

  constructor(private readonly candidateRows: object[]) {}

  async query(text: string, values: readonly unknown[] = []): Promise<QueryResult> {
    this.poolQueries.push({ text, values });
    if (text.includes('FROM l2_memories')) {
      return queryResult(this.candidateRows);
    }
    throw new Error(`unexpected pool query: ${text}`);
  }

  async connect(): Promise<PoolClient> {
    return {
      query: async (text: string, values: readonly unknown[] = []) => {
        this.clientQueries.push({ text, values });
        const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();
        if (normalized === 'begin') {
          return queryResult();
        }
        if (normalized === 'commit') {
          this.committed = true;
          return queryResult();
        }
        if (normalized === 'rollback') {
          this.rolledBack = true;
          return queryResult();
        }
        if (normalized.startsWith('update l2_memories')) {
          return queryResult([{ id: values[1] }], 1);
        }
        if (normalized.startsWith('insert into l2_memory_patch_events')) {
          (this.patchEvents as unknown[][]).push([...values]);
          return queryResult([], 1);
        }
        throw new Error(`unexpected client query: ${text}`);
      },
      release: () => {
        this.released = true;
      },
    } as PoolClient;
  }
}

describe('memory participant name repair', () => {
  it('plans candidate updates without mutating storage', () => {
    const plan = planMemoryParticipantNameRepair([
      {
        id: 'm-generic',
        text: "The user trusts the companion's patience.",
      },
      {
        id: 'm-clean',
        text: "Alex trusts Lyra's patience.",
      },
    ], {
      canonicalContactName: 'Alex',
      companionName: 'Lyra',
    });

    expect(plan).toMatchObject({
      scanned: 2,
      candidates: 1,
      unchanged: 0,
      refused: [],
    });
    expect(plan.updates).toEqual([
      expect.objectContaining({
        memoryId: 'm-generic',
        beforeText: "The user trusts the companion's patience.",
        afterText: "Alex trusts Lyra's patience.",
      }),
    ]);
  });

  it('leaves ordinary assistant/companion/user nouns unchanged (not placeholders)', () => {
    const plan = planMemoryParticipantNameRepair([
      { id: 'm-research', text: 'The research assistant reviewed the paper.' },
      { id: 'm-power', text: 'He is a power user of the kiln software.' },
      { id: 'm-planting', text: 'Companion planting improved the harvest.' },
      { id: 'm-personal', text: 'She hired a personal assistant last spring.' },
    ], {
      canonicalContactName: 'Alex',
      companionName: 'Lyra',
    });

    // None are placeholder candidates, so none are rewritten or refused.
    expect(plan).toMatchObject({
      scanned: 4,
      candidates: 0,
      unchanged: 0,
      updates: [],
      refused: [],
    });
  });

  it('restricts the candidate SQL predicate to explicit placeholder forms', async () => {
    const pool = new FakePostgresRepairPool([]);
    await repairPostgresMemoryParticipantNames(pool as unknown as Pool, {
      canonicalContactName: 'Alex',
      companionName: 'Lyra',
    });
    const selectSql = pool.poolQueries
      .map(query => query.text)
      .find(text => text.includes('FROM l2_memories')) ?? '';
    expect(selectSql).toContain("'%the companion%'");
    expect(selectSql).toContain("'%the assistant%'");
    // Bare-noun predicates that would match ordinary text must be gone.
    expect(selectSql).not.toMatch(/LIKE '%companion%'/);
    expect(selectSql).not.toMatch(/LIKE '%assistant%'/);
    expect(selectSql).not.toMatch(/LIKE '%user''s%'/);
  });

  it('refuses ambiguous participant labels instead of partially rewriting memory text', () => {
    const plan = planMemoryParticipantNameRepair([
      {
        id: 'm-ambiguous',
        text: 'The user trusts the companion with difficult topics.',
      },
    ], {
      companionName: 'Lyra',
    });

    expect(plan).toMatchObject({
      scanned: 1,
      candidates: 1,
      unchanged: 0,
      updates: [],
    });
    expect(plan.refused).toHaveLength(1);
    expect(plan.refused[0]).toMatchObject({
      memoryId: 'm-ambiguous',
      reasons: ['missing_user_name'],
    });
    expect(plan.refusalCounts.missing_user_name).toBe(1);
  });

  it('repairs Postgres memories and records patch audit details', async () => {
    const pool = new FakePostgresRepairPool([{
      id: 'm-active',
      text: 'The user told the companion about the kiln schedule.',
      superseded_by: null,
      deleted_at: null,
    }]);

    const report = await repairPostgresMemoryParticipantNames(pool as unknown as Pool, {
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
      refused: [],
      sourceRef: 'source:repair|operation:memory_participant_name_backfill',
      sourceType: 'tool_write',
    });
    expect(report.updates[0]).toMatchObject({
      memoryId: 'm-active',
      beforeText: 'The user told the companion about the kiln schedule.',
      afterText: 'Alex told Lyra about the kiln schedule.',
    });
    expect(pool.poolQueries[0]?.values).toEqual([500]);
    expect(pool.clientQueries.map(query => query.text.replace(/\s+/g, ' ').trim().toLowerCase()))
      .toEqual(expect.arrayContaining([
        'begin',
        'commit',
      ]));
    expect(pool.rolledBack).toBe(false);
    expect(pool.released).toBe(true);
    expect(pool.patchEvents).toHaveLength(1);
    expect(pool.patchEvents[0]?.slice(0, 4)).toEqual([
      'patch-active',
      'm-active',
      'source:repair|operation:memory_participant_name_backfill',
      'tool_write',
    ]);
    expect(JSON.parse(String(pool.patchEvents[0]?.[4]))).toEqual({
      actor: 'operator',
      reason: 'memory_participant_name_backfill',
    });
    expect(pool.patchEvents[0]?.[5]).toBe(
      'memory_participant_name_backfill',
    );
  });
});
