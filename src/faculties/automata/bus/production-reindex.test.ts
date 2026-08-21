import { describe, expect, it, vi } from 'vitest';

import type { AutomataBusFindingEvent } from './contract.js';
import type { AutomataBusSqlPool } from './postgres-store.js';
import {
  createProductionAutomataBusReindexService,
  type AutomataBusReindexProductionRuntime,
  PostgresAutomataBusReindexSource,
} from './production-reindex.js';
import type { AutomataBusReindexLease } from './reindex-service.js';

const LEASE: AutomataBusReindexLease = {
  companionId: 'companion-a',
  leaseToken: 'a2b74a19-5c3c-4cee-aa8c-56d352fe73ae',
  snapshotSequence: 7,
  mutationFence: 11,
};

const event: AutomataBusFindingEvent = {
  schemaVersion: 1,
  eventId: 'event-a',
  companionId: 'companion-a',
  sequence: 1,
  occurredAt: '2026-08-20T12:00:00.000Z',
  mustUnderstand: [],
  type: 'finding',
  context: {
    automatonClass: 'subagent.bounded',
    runId: 'run-a',
    taskId: 'task-a',
    sessionIds: [],
    artifactRefs: [],
  },
  body: {
    claim: 'Bounded claim.',
    provenance: 'computed',
    evidence: [{ kind: 'artifact', reference: 'artifact:a', summary: 'Proof.' }],
    verification: { status: 'pending' },
  },
};

function pool(rowCompanionId = 'companion-a'): {
  pool: AutomataBusSqlPool;
  query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async () => ({
    rows: [{
      companion_id: rowCompanionId,
      event_id: event.eventId,
      sequence: event.sequence,
      audiences: ['eligible-automata'],
      sensitivity: 'personal',
      event_json: { ...event, companionId: rowCompanionId },
    }],
    rowCount: 1,
  }));
  return {
    query,
    pool: {
      query,
      connect: vi.fn(async () => { throw new Error('not used'); }),
    },
  };
}

describe('PostgresAutomataBusReindexSource', () => {
  it('reads one bounded eligible-worker page for its exact companion', async () => {
    const database = pool();
    const source = new PostgresAutomataBusReindexSource({
      pool: database.pool,
      companionId: 'companion-a',
      maxFindings: 3,
    });

    await expect(source.readCurrent({
      companionId: 'companion-a',
      limit: 2,
      snapshotSequence: 7,
    }))
      .resolves.toMatchObject({
        companionId: 'companion-a',
        findings: [{ eventId: 'event-a', companionId: 'companion-a' }],
        hasMore: false,
      });
    expect(database.query.mock.calls[0]?.[0]).toContain("'eligible-automata' = ANY(audiences)");
    expect(database.query.mock.calls[0]?.[0]).toContain('sequence <= $2');
    expect(database.query.mock.calls[0]?.[1]).toEqual([
      'companion-a',
      7,
      ['public', 'personal', 'intimate', 'confidential'],
      3,
    ]);

    await expect(source.readCurrent({
      companionId: 'companion-b',
      limit: 1,
      snapshotSequence: 7,
    }))
      .rejects.toThrow('companion scope mismatch');
    expect(database.query).toHaveBeenCalledOnce();
  });

  it('rejects a database row whose authority columns cross the companion boundary', async () => {
    const database = pool('companion-b');
    const source = new PostgresAutomataBusReindexSource({
      pool: database.pool,
      companionId: 'companion-a',
      maxFindings: 3,
    });

    await expect(source.readCurrent({
      companionId: 'companion-a',
      limit: 2,
      snapshotSequence: 7,
    }))
      .rejects.toThrow('cross-companion row');
  });
});

describe('createProductionAutomataBusReindexService', () => {
  it('binds vector lifecycle and finding indexing to the same companion identity', async () => {
    const database = pool();
    const vector = {
      beginReindex: vi.fn(async () => LEASE),
      completeReindex: vi.fn(async () => undefined),
      failReindex: vi.fn(async () => undefined),
    };
    const indexing = {
      indexCurrentFinding: vi.fn(async () => ({ status: 'indexed' as const })),
    };
    const runtime: AutomataBusReindexProductionRuntime = {
      vector,
      indexing,
      describeComposition: () => ({
        embeddingIdentity: { provider: 'test', model: 'embed-v1', dimensions: 3 },
      }),
    };
    const service = createProductionAutomataBusReindexService({
      pool: database.pool,
      runtime,
      companionId: 'companion-a',
      maxFindings: 3,
    });

    await service.reindex({ companionId: 'companion-a' });

    expect(vector.beginReindex).toHaveBeenCalledWith({
      companionId: 'companion-a',
      modelIdentity: { provider: 'test', model: 'embed-v1', dimensions: 3 },
    });
    expect(vector.completeReindex).toHaveBeenCalledWith({
      ...LEASE,
      modelIdentity: { provider: 'test', model: 'embed-v1', dimensions: 3 },
      eventIds: ['event-a'],
    });
    expect(indexing.indexCurrentFinding).toHaveBeenCalledWith(
      expect.objectContaining({ companionId: 'companion-a', eventId: 'event-a' }),
    );
  });
});
