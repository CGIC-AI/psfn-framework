import { describe, expect, it } from 'vitest';
import { createPostgresGatewayAuditStoreFromPool } from './postgres-audit.js';

interface QueryResult<Row> {
  rows: Row[];
  rowCount?: number;
}

interface AuditRow {
  id: number;
  timestamp: number;
  method: string;
  decision: string;
  paramsJson: string | null;
  durationMs: number | null;
  error: string | null;
}

class FakeAuditPool {
  private rows: AuditRow[] = [];
  private nextId = 1;

  async query<Row>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
    const normalized = text.replace(/\s+/g, ' ').trim();

    if (normalized.startsWith('INSERT INTO gateway_audit')) {
      const [timestamp, method, decision, paramsJson, durationMs, error] = values as [
        number,
        string,
        string,
        string | null,
        number | null,
        string | null,
      ];
      const row: AuditRow = {
        id: this.nextId++,
        timestamp,
        method,
        decision,
        paramsJson,
        durationMs,
        error,
      };
      this.rows.push(row);
      return { rows: [{ id: row.id } as Row] };
    }

    if (normalized.startsWith('UPDATE gateway_audit SET duration_ms')) {
      const [durationMs, error, id] = values as [number, string | null, number];
      const row = this.rows.find(entry => entry.id === id);
      if (row) {
        row.durationMs = durationMs;
        row.error = error;
      }
      return { rows: [] };
    }

    if (normalized.startsWith('DELETE FROM gateway_audit WHERE timestamp < $1')) {
      const [threshold] = values as [number];
      this.rows = this.rows.filter(row => row.timestamp >= threshold);
      return { rows: [], rowCount: 0 };
    }

    if (normalized.includes('DELETE FROM gateway_audit') && normalized.includes('ORDER BY timestamp DESC, id DESC OFFSET $1')) {
      const [offset] = values as [number];
      const keep = [...this.rows].sort((left, right) => right.timestamp - left.timestamp || right.id - left.id);
      const kept = keep.slice(0, offset);
      const keptIds = new Set(kept.map(row => row.id));
      const before = this.rows.length;
      this.rows = this.rows.filter(row => keptIds.has(row.id));
      return { rows: [], rowCount: before - this.rows.length };
    }

    if (normalized.includes('DELETE FROM gateway_audit') && normalized.includes('ORDER BY timestamp ASC, id ASC LIMIT $1')) {
      const [limit] = values as [number];
      const ordered = [...this.rows].sort((left, right) => left.timestamp - right.timestamp || left.id - right.id);
      const removeIds = new Set(ordered.slice(0, limit).map(row => row.id));
      const before = this.rows.length;
      this.rows = this.rows.filter(row => !removeIds.has(row.id));
      return { rows: [], rowCount: before - this.rows.length };
    }

    if (normalized.startsWith('SELECT COUNT(*)::INTEGER AS cnt FROM gateway_audit')) {
      return { rows: [{ cnt: this.rows.length } as Row] };
    }

    if (normalized.includes('COALESCE(SUM(') && normalized.includes('FROM gateway_audit')) {
      const bytes = this.rows.reduce((total, row) => (
        total
        + row.method.length
        + row.decision.length
        + (row.paramsJson?.length ?? 0)
        + (row.error?.length ?? 0)
        + 24
      ), 0);
      return { rows: [{ bytes } as Row] };
    }

    if (normalized.includes('FROM gateway_audit') && normalized.includes('WHERE method = $1')) {
      const [method, limit] = values as [string, number];
      const rows = [...this.rows]
        .filter(row => row.method === method)
        .sort((left, right) => right.timestamp - left.timestamp || right.id - left.id)
        .slice(0, limit);
      return { rows: rows.map(row => toQueryRow(row) as Row) };
    }

    if (normalized.includes('FROM gateway_audit') && normalized.includes('WHERE decision != \'ALLOW\'')) {
      const [limit] = values as [number];
      const rows = [...this.rows]
        .filter(row => row.decision !== 'ALLOW')
        .sort((left, right) => right.timestamp - left.timestamp || right.id - left.id)
        .slice(0, limit);
      return { rows: rows.map(row => toQueryRow(row) as Row) };
    }

    if (normalized.includes('FROM gateway_audit') && normalized.includes('ORDER BY timestamp DESC, id DESC')) {
      const [limit] = values as [number];
      const rows = [...this.rows]
        .sort((left, right) => right.timestamp - left.timestamp || right.id - left.id)
        .slice(0, limit);
      return { rows: rows.map(row => toQueryRow(row) as Row) };
    }

    throw new Error(`Unhandled SQL in FakeAuditPool: ${normalized}`);
  }
}

function toQueryRow(row: AuditRow): Record<string, unknown> {
  return {
    id: row.id,
    timestamp: row.timestamp,
    method: row.method,
    decision: row.decision,
    paramsJson: row.paramsJson,
    durationMs: row.durationMs,
    error: row.error,
  };
}

describe('postgres gateway audit adapter', () => {
  it('logs, completes, and prunes audit entries', async () => {
    const pool = new FakeAuditPool();
    const store = createPostgresGatewayAuditStoreFromPool(pool as never, {
      maxCount: 2,
      maxAgeMs: 1_000,
      maxSizeBytes: 1_000,
    }, () => 1_000);

    const first = await store.log('llm.chat', 'ALLOW', { model: 'test' });
    const second = await store.log('fs.read', 'NEEDS_APPROVAL', { path: '/etc/passwd' });
    const third = await store.log('discord.send', 'ALLOW');
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);

    await store.complete(second, 150, 'approval denied');

    expect(await store.count()).toBe(2);
    const entries = await store.getRecent(10);
    expect(entries.map(entry => entry.method)).toEqual(['discord.send', 'fs.read']);
    expect(entries[1]).toMatchObject({
      durationMs: 150,
      error: 'approval denied',
    });
  });

  it('creates summary hooks and approval-event queries', async () => {
    const pool = new FakeAuditPool();
    const store = createPostgresGatewayAuditStoreFromPool(pool as never);

    await store.recordSummary({
      method: 'wyoming.session.start',
      decision: 'ALLOW',
      params: { connectionId: 'conn-1' },
      durationMs: 12.8,
    });
    await store.recordSummary({
      method: 'wyoming.policy.violation',
      decision: 'DENY',
      params: { code: 'RATE_LIMIT_EXCEEDED' },
      error: 'Session exceeded event rate',
    });

    const hook = store.createSummaryHook();
    await hook({
      method: 'llm.complete',
      decision: 'ALLOW',
      params: { requestId: 'req-1' },
    });

    const approvalEvents = await store.getApprovalEvents();
    expect(approvalEvents).toHaveLength(1);
    expect(approvalEvents[0]?.method).toBe('wyoming.policy.violation');

    const recent = await store.getRecent(3);
    expect(recent.map(entry => entry.method)).toEqual([
      'llm.complete',
      'wyoming.policy.violation',
      'wyoming.session.start',
    ]);
    expect(recent[0]?.paramsJson).toContain('req-1');
  });
});
