import { describe, expect, it, vi } from 'vitest';

import type { AutomataBusEffectiveFinding } from './current-state.js';
import {
  PostgresAutomataBusCanonicalFindingAdapter,
} from './postgres-canonical-query.js';
import type {
  AutomataBusSqlClient,
  AutomataBusSqlPool,
  AutomataBusSqlQueryResult,
  PersistedAutomataBusCurrentFinding,
  PostgresAutomataBusStore,
} from './postgres-store.js';
import {
  PostgresAutomataBusVectorIndexAdapter,
} from './postgres-vector-index.js';
import type {
  AutomataBusCanonicalFinding,
  AutomataBusEmbeddingIdentity,
} from './query-ports.js';

const MODEL: AutomataBusEmbeddingIdentity = {
  provider: 'test-provider',
  model: 'test-model-v1',
  dimensions: 3,
};

const VISIBILITY = {
  companionId: 'companion-a',
  audience: 'eligible-automata' as const,
  maxSensitivity: 'personal' as const,
};

function effectiveFinding(
  eventId: string,
  overrides: Partial<AutomataBusEffectiveFinding> = {},
): AutomataBusEffectiveFinding {
  return {
    eventId,
    companionId: 'companion-a',
    sequence: 1,
    occurredAt: '2026-08-11T12:00:00.000Z',
    context: {
      automatonClass: 'task-worker',
      runId: 'run-a',
      taskId: 'task-a',
      sessionIds: ['session-a'],
      artifactRefs: ['artifact:a'],
    },
    body: {
      claim: `claim ${eventId}`,
      provenance: 'computed',
      evidence: [{
        kind: 'artifact',
        reference: 'artifact:a',
        summary: 'proof',
      }],
      verification: { status: 'verified', by: 'reviewer', evidenceRefs: ['artifact:a'] },
    },
    sourceEventType: 'finding',
    ...overrides,
  };
}

function persistedFinding(
  eventId: string,
  overrides: Partial<PersistedAutomataBusCurrentFinding> = {},
): PersistedAutomataBusCurrentFinding {
  return {
    effectiveFinding: effectiveFinding(eventId),
    audiences: ['eligible-automata'],
    sensitivity: 'personal',
    ...overrides,
  };
}

function canonicalFinding(
  eventId: string,
  overrides: Partial<AutomataBusCanonicalFinding> = {},
): AutomataBusCanonicalFinding {
  return {
    eventId,
    companionId: 'companion-a',
    sequence: 1,
    occurredAt: '2026-08-11T12:00:00.000Z',
    automatonClass: 'task-worker',
    taskId: 'task-a',
    runId: 'run-a',
    claim: `claim ${eventId}`,
    provenance: 'computed',
    verificationStatus: 'verified',
    audience: 'eligible-automata',
    sensitivity: 'personal',
    ...overrides,
  };
}

interface RecordedQuery {
  text: string;
  values: unknown[];
  viaClient: boolean;
}

class RecordingPool implements AutomataBusSqlPool {
  readonly queries: RecordedQuery[] = [];
  stateRows: unknown[] = [];
  searchRows: unknown[] = [];
  writeRowCount = 1;

  async query<Row>(text: string, values: unknown[] = []): Promise<AutomataBusSqlQueryResult<Row>> {
    return this.execute<Row>(text, values, false);
  }

  async connect(): Promise<AutomataBusSqlClient> {
    return {
      query: async <Row>(text: string, values: unknown[] = []) => (
        this.execute<Row>(text, values, true)
      ),
      release: vi.fn(),
    };
  }

  private async execute<Row>(
    text: string,
    values: unknown[],
    viaClient: boolean,
  ): Promise<AutomataBusSqlQueryResult<Row>> {
    const normalized = text.replaceAll(/\s+/gu, ' ').trim();
    this.queries.push({ text: normalized, values, viaClient });
    if (normalized.includes('FROM automata_bus_vector_state')) {
      return result(this.stateRows as Row[]);
    }
    if (normalized.includes('FROM automata_bus_finding_vectors')) {
      return result(this.searchRows as Row[]);
    }
    if (normalized.includes('FROM automata_bus_current_findings c')) {
      return result(this.searchRows as Row[]);
    }
    if (normalized.startsWith('INSERT INTO automata_bus_vector_state')) {
      return result(this.writeRowCount > 0 ? ([{ companion_id: 'companion-a' }] as Row[]) : []);
    }
    if (normalized.startsWith('INSERT INTO automata_bus_finding_vectors')) {
      return result(this.writeRowCount > 0 ? ([{ event_id: 'event-a' }] as Row[]) : []);
    }
    if (normalized.startsWith('INSERT INTO automata_bus_vector_lag')) {
      return result(this.writeRowCount > 0 ? ([{ event_id: 'event-a' }] as Row[]) : []);
    }
    if (normalized.startsWith('UPDATE automata_bus_vector_state')) {
      return result(this.writeRowCount > 0 ? ([{ companion_id: 'companion-a' }] as Row[]) : []);
    }
    if (normalized.startsWith('DELETE FROM automata_bus_vector_lag')) {
      return { rows: [], rowCount: this.writeRowCount };
    }
    return result<Row>();
  }
}

function result<Row>(rows: Row[] = []): AutomataBusSqlQueryResult<Row> {
  return { rows, rowCount: rows.length };
}

describe('PostgresAutomataBusCanonicalFindingAdapter', () => {
  it('hydrates through the canonical store and re-applies every filter after mapping', async () => {
    const store = {
      readCurrentFindingsByEventIds: vi.fn(async () => [
        persistedFinding('allowed'),
        persistedFinding('wrong-class', {
          effectiveFinding: effectiveFinding('wrong-class', {
            context: {
              ...effectiveFinding('wrong-class').context,
              automatonClass: 'memory-retrieval',
            },
          }),
        }),
        persistedFinding('too-sensitive', { sensitivity: 'confidential' }),
      ]),
    } as unknown as Pick<PostgresAutomataBusStore, 'readCurrentFindingsByEventIds'>;
    const pool = new RecordingPool();
    const adapter = new PostgresAutomataBusCanonicalFindingAdapter({
      pool,
      store,
      maxCandidateLimit: 5,
    });

    const rows = await adapter.getCurrentByEventIds({
      eventIds: ['allowed', 'wrong-class', 'too-sensitive'],
      visibility: VISIBILITY,
      filters: {
        automatonClasses: ['task-worker'],
        taskIds: ['task-a'],
        runIds: ['run-a'],
        occurredAfter: '2026-01-01T00:00:00.000Z',
        occurredBefore: '2026-12-31T23:59:59.000Z',
        audiences: ['eligible-automata'],
        statuses: ['verified'],
      },
    });

    expect(store.readCurrentFindingsByEventIds).toHaveBeenCalledWith({
      ...VISIBILITY,
      eventIds: ['allowed', 'too-sensitive', 'wrong-class'],
    });
    expect(rows.map(row => row.eventId)).toEqual(['allowed']);
    expect(rows[0]).toEqual(expect.objectContaining({
      audience: 'eligible-automata',
      sensitivity: 'personal',
      claim: 'claim allowed',
      verificationStatus: 'verified',
    }));
  });

  it('builds bounded lexical SQL with visibility and all optional filters parameterized', async () => {
    const pool = new RecordingPool();
    pool.searchRows = [{ event_id: 'event-a', score: '0.75' }];
    const store = {
      readCurrentFindingsByEventIds: vi.fn(async () => []),
    } as unknown as Pick<PostgresAutomataBusStore, 'readCurrentFindingsByEventIds'>;
    const adapter = new PostgresAutomataBusCanonicalFindingAdapter({
      pool,
      store,
      maxCandidateLimit: 5,
    });

    const rows = await adapter.searchLexical({
      query: 'deterministic ordering',
      visibility: VISIBILITY,
      filters: {
        automatonClasses: ['task-worker'],
        taskIds: ['task-a'],
        runIds: ['run-a'],
        occurredAfter: '2026-01-01T00:00:00.000Z',
        occurredBefore: '2026-12-31T23:59:59.000Z',
        audiences: ['eligible-automata'],
        statuses: ['verified'],
      },
      limit: 99,
    });

    expect(rows).toEqual([{ eventId: 'event-a', score: 0.75 }]);
    const query = pool.queries.at(-1);
    expect(query?.text).toContain('FROM automata_bus_current_findings c');
    expect(query?.text).toContain('plainto_tsquery');
    expect(query?.text).toContain('c.companion_id = $1');
    expect(query?.text).toContain('ANY(c.audiences)');
    expect(query?.text).toContain("event_json #>> '{context,automatonClass}'");
    expect(query?.text).toContain("event_json #>> '{context,taskId}'");
    expect(query?.text).toContain("event_json #>> '{context,runId}'");
    expect(query?.text).toContain("event_json ->> 'occurredAt'");
    expect(query?.text).toContain("body,replacement,verification,status");
    expect(query?.values).toContain(5);
    expect(query?.values).not.toContain(99);
  });

  it('returns no lexical rows without querying when the requested audience filter is narrower than scope', async () => {
    const pool = new RecordingPool();
    const store = {
      readCurrentFindingsByEventIds: vi.fn(async () => []),
    } as unknown as Pick<PostgresAutomataBusStore, 'readCurrentFindingsByEventIds'>;
    const adapter = new PostgresAutomataBusCanonicalFindingAdapter({
      pool,
      store,
      maxCandidateLimit: 5,
    });

    await expect(adapter.searchLexical({
      query: 'hidden',
      visibility: VISIBILITY,
      filters: { audiences: ['operator'] },
      limit: 2,
    })).resolves.toEqual([]);
    expect(pool.queries).toEqual([]);
  });
});

describe('PostgresAutomataBusVectorIndexAdapter', () => {
  it('reads explicit model, index, reindex, and lag state', async () => {
    const pool = new RecordingPool();
    pool.stateRows = [{
      provider: MODEL.provider,
      model: MODEL.model,
      dimensions: '3',
      index_state: 'degraded',
      reindex_state: 'running',
      pending_count: '2',
      oldest_pending_at: '2026-08-11T10:00:00.000Z',
      last_failure_at: '2026-08-11T11:00:00.000Z',
    }];
    const adapter = new PostgresAutomataBusVectorIndexAdapter(pool, {
      companionId: 'companion-a',
      maxCandidateLimit: 5,
    });

    await expect(adapter.readState()).resolves.toEqual({
      modelIdentity: MODEL,
      indexState: 'degraded',
      reindexState: 'running',
      indexingLag: {
        pendingCount: 2,
        oldestPendingAt: '2026-08-11T10:00:00.000Z',
        lastFailureAt: '2026-08-11T11:00:00.000Z',
      },
    });
  });

  it('runs bounded ANN SQL with exact identity, visibility, and query filters', async () => {
    const pool = new RecordingPool();
    pool.searchRows = [{ event_id: 'event-a', score: 0.9 }];
    const adapter = new PostgresAutomataBusVectorIndexAdapter(pool, {
      companionId: 'companion-a',
      maxCandidateLimit: 5,
    });

    const rows = await adapter.searchApproximate({
      embedding: new Float32Array([1, 0, 0]),
      modelIdentity: MODEL,
      visibility: VISIBILITY,
      filters: {
        automatonClasses: ['task-worker'],
        taskIds: ['task-a'],
        runIds: ['run-a'],
        statuses: ['verified'],
      },
      limit: 99,
    });

    expect(rows).toEqual([{ eventId: 'event-a', score: 0.9 }]);
    const query = pool.queries.at(-1);
    expect(query?.text).toContain('FROM automata_bus_finding_vectors v');
    expect(query?.text).toContain('JOIN automata_bus_current_findings c');
    expect(query?.text).toContain('v.provider =');
    expect(query?.text).toContain('v.model =');
    expect(query?.text).toContain('v.dimensions =');
    expect(query?.text).toContain('v.embedding::vector(3) <=>');
    expect(query?.text).toContain('ORDER BY v.embedding::vector(3) <=>');
    expect(query?.values).toContain(MODEL.provider);
    expect(query?.values).toContain(MODEL.model);
    expect(query?.values).toContain(5);
    expect(query?.values).not.toContain(99);
  });

  it('forces exact fallback to a transaction-local sequential scan', async () => {
    const pool = new RecordingPool();
    pool.searchRows = [{ event_id: 'event-a', score: '0.8' }];
    const adapter = new PostgresAutomataBusVectorIndexAdapter(pool, {
      companionId: 'companion-a',
      maxCandidateLimit: 5,
    });

    await expect(adapter.searchExact({
      embedding: new Float32Array([1, 0, 0]),
      modelIdentity: MODEL,
      visibility: VISIBILITY,
      filters: {},
      limit: 3,
    })).resolves.toEqual([{ eventId: 'event-a', score: 0.8 }]);

    expect(pool.queries.map(query => query.text)).toEqual(expect.arrayContaining([
      'BEGIN TRANSACTION READ ONLY',
      'SET LOCAL enable_indexscan = off',
      'SET LOCAL enable_bitmapscan = off',
      'COMMIT',
    ]));
    expect(pool.queries.find(query => query.text.includes('FROM automata_bus_finding_vectors')))
      .toEqual(expect.objectContaining({ viaClient: true }));
  });

  it('upserts only derived vector data under the explicit model identity', async () => {
    const pool = new RecordingPool();
    const adapter = new PostgresAutomataBusVectorIndexAdapter(pool, {
      companionId: 'companion-a',
      maxCandidateLimit: 5,
    });

    await adapter.upsert({
      ...canonicalFinding('event-a', { claim: 'never persist this claim in the vector table' }),
      embedding: new Float32Array([1, 0, 0]),
      modelIdentity: MODEL,
    });

    const vectorWrite = pool.queries.find(query => (
      query.text.startsWith('INSERT INTO automata_bus_finding_vectors')
    ));
    expect(vectorWrite?.values).toContain(MODEL.provider);
    expect(vectorWrite?.values).toContain(MODEL.model);
    expect(vectorWrite?.values).not.toContain('never persist this claim in the vector table');
    expect(vectorWrite?.text).not.toContain('claim');
  });

  it('persists lag by event and clears it only after a successful index', async () => {
    const pool = new RecordingPool();
    const adapter = new PostgresAutomataBusVectorIndexAdapter(pool, {
      companionId: 'companion-a',
      maxCandidateLimit: 5,
    });

    await adapter.markLagging({
      eventId: 'event-a',
      companionId: 'companion-a',
      stage: 'embedding',
      modelIdentity: MODEL,
    });
    await adapter.markIndexed({
      eventId: 'event-a',
      companionId: 'companion-a',
      modelIdentity: MODEL,
    });

    expect(pool.queries.some(query => query.text.startsWith('INSERT INTO automata_bus_vector_lag')))
      .toBe(true);
    expect(pool.queries.some(query => query.text.startsWith('DELETE FROM automata_bus_vector_lag')))
      .toBe(true);
    expect(pool.queries.some(query => (
      query.text.startsWith('UPDATE automata_bus_vector_state state')
      && query.text.includes("index_state = 'ready'")
      && query.text.includes("reindex_state = 'current'")
      && query.values.includes('companion-a')
    ))).toBe(true);
  });

  it('requires explicit reindex state before changing model identity', async () => {
    const pool = new RecordingPool();
    pool.stateRows = [{
      provider: MODEL.provider,
      model: MODEL.model,
      dimensions: MODEL.dimensions,
    }];
    const adapter = new PostgresAutomataBusVectorIndexAdapter(pool, {
      companionId: 'companion-a',
      maxCandidateLimit: 5,
    });

    await expect(adapter.setState({
      modelIdentity: { ...MODEL, model: 'next-model' },
      indexState: 'building',
      reindexState: 'current',
    })).rejects.toThrow('requires explicit reindex state');
    expect(pool.queries.map(query => query.text)).toContain('ROLLBACK');
  });

  it('marks a model mismatch as reindex-required while retaining the indexed identity', async () => {
    const pool = new RecordingPool();
    const adapter = new PostgresAutomataBusVectorIndexAdapter(pool, {
      companionId: 'companion-a',
      maxCandidateLimit: 5,
    });

    await adapter.markLagging({
      eventId: 'event-a',
      companionId: 'companion-a',
      stage: 'model-identity',
      modelIdentity: { ...MODEL, model: 'next-model' },
    });

    expect(pool.queries.some(query => (
      query.text.startsWith('UPDATE automata_bus_vector_state')
      && query.text.includes("reindex_state = 'required'")
    ))).toBe(true);
    expect(pool.queries.some(query => query.text.startsWith('INSERT INTO automata_bus_vector_lag')))
      .toBe(true);
  });

  it('owns the complete reindex lifecycle under one immutable companion scope', async () => {
    const pool = new RecordingPool();
    const adapter = new PostgresAutomataBusVectorIndexAdapter(pool, {
      companionId: 'companion-a',
      maxCandidateLimit: 5,
    });

    await expect(adapter.beginReindex({
      companionId: 'companion-b',
      modelIdentity: MODEL,
    })).rejects.toThrow('companion scope mismatch');
    expect(pool.queries).toEqual([]);

    await adapter.beginReindex({ companionId: 'companion-a', modelIdentity: MODEL });
    await adapter.completeReindex({
      companionId: 'companion-a',
      modelIdentity: MODEL,
      eventIds: ['event-a'],
    });

    const mutations = pool.queries.filter(query => (
      query.text.startsWith('INSERT INTO automata_bus_vector_state')
      || query.text.startsWith('UPDATE automata_bus_vector_state')
      || query.text.startsWith('DELETE FROM automata_bus_finding_vectors')
      || query.text.startsWith('DELETE FROM automata_bus_vector_lag')
    ));
    expect(mutations.length).toBeGreaterThan(0);
    expect(mutations.every(query => query.values.includes('companion-a'))).toBe(true);
    expect(mutations.every(query => !query.values.includes('companion-b'))).toBe(true);

    await adapter.beginReindex({ companionId: 'companion-a', modelIdentity: MODEL });
    await adapter.failReindex({ companionId: 'companion-a', modelIdentity: MODEL });
    expect(pool.queries.some(query => (
      query.text.startsWith('UPDATE automata_bus_vector_state')
      && query.text.includes("reindex_state = 'required'")
    ))).toBe(true);
  });
});
