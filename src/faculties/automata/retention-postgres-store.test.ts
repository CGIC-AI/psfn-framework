import type { QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';
import type { AutomataRetentionAuditEvent } from './retention-contract.js';
import {
  PostgresAutomataRetentionStore,
  type AutomataRetentionSqlPool,
} from './retention-postgres-store.js';
import type { AutomataSessionClassification } from './session-classification.js';

class FakePool implements AutomataRetentionSqlPool {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];

  constructor(private readonly replies: QueryResultRow[][]) {}

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<R>> {
    this.calls.push({ text, values });
    const rows = (this.replies.shift() ?? []) as R[];
    return {
      command: '',
      rowCount: rows.length,
      oid: 0,
      fields: [],
      rows,
    };
  }
}

const classification: AutomataSessionClassification = {
  schemaVersion: 1,
  companionId: 'companion-a',
  sessionId: 'session-a',
  ownership: 'automata',
  runId: 'run-a',
  automatonClass: 'subagent.bounded',
  workerGeneration: 2,
  classifiedAtMs: 100,
  retentionDeadlineMs: 200,
};

const classificationRow = {
  companion_id: 'companion-a',
  session_id: 'session-a',
  schema_version: 1,
  ownership: 'automata',
  classified_at_ms: 100,
  run_id: 'run-a',
  automaton_class: 'subagent.bounded',
  worker_generation: 2,
  retention_deadline_ms: 200,
};

const auditEvent: AutomataRetentionAuditEvent = {
  schemaVersion: 1,
  eventId: 'attempt-a:purged',
  attemptId: 'attempt-a',
  companionId: 'companion-a',
  sessionId: 'session-a',
  runId: 'run-a',
  automatonClass: 'subagent.bounded',
  workerGeneration: 2,
  kind: 'purged',
  reason: 'eligible',
  occurredAtMs: 300,
  targetRevision: 'revision-a',
  removedCounts: {
    journals: 2,
    journal_rolls: 1,
    channel_index: 1,
    transcript_projection: 3,
    turn_records: 4,
    redis_tail_pointers: 2,
  },
  preservedReferenceCount: 2,
};

describe('PostgresAutomataRetentionStore', () => {
  it('persists immutable creation classification without session content', async () => {
    const pool = new FakePool([[{ session_id: 'session-a' }]]);
    const store = new PostgresAutomataRetentionStore(pool);
    await store.recordClassification(classification);

    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0]?.text).toContain('INSERT INTO automata_session_classifications');
    expect(pool.calls[0]?.values).toEqual([
      'companion-a',
      'session-a',
      1,
      'automata',
      100,
      'run-a',
      'subagent.bounded',
      2,
      200,
    ]);
  });

  it('hydrates only exact due automata rows and excludes successful receipts in SQL', async () => {
    const pool = new FakePool([[classificationRow]]);
    const store = new PostgresAutomataRetentionStore(pool);

    await expect(store.listDueAutomataSessions('companion-a', 200, 10))
      .resolves.toEqual([classification]);
    expect(pool.calls[0]?.text).toContain("classification.ownership = 'automata'");
    expect(pool.calls[0]?.text).toContain("audit.event_kind = 'purged'");
    expect(pool.calls[0]?.values).toEqual(['companion-a', 200, 10]);
  });

  it('writes a fixed content-free purge receipt and resolves it after restart', async () => {
    const pool = new FakePool([
      [{ event_id: auditEvent.eventId }],
      [{ has_receipt: true }],
    ]);
    const store = new PostgresAutomataRetentionStore(pool);
    await store.appendAuditEvent(auditEvent);

    await expect(store.hasPurgeReceipt('companion-a', 'session-a')).resolves.toBe(true);
    expect(JSON.stringify(pool.calls[0]?.values)).not.toContain('raw worker message');
    expect(pool.calls[0]?.values).toContain(JSON.stringify(auditEvent.removedCounts));
  });

  it('rejects malformed diagnostic digests instead of persisting error text', async () => {
    const pool = new FakePool([]);
    const store = new PostgresAutomataRetentionStore(pool);
    await expect(store.appendAuditEvent({
      ...auditEvent,
      kind: 'retryable_failure',
      reason: 'purge_failed',
      errorDigest: 'database said the raw message here',
    })).rejects.toThrow('error_digest is invalid');
    expect(pool.calls).toHaveLength(0);
  });
});
