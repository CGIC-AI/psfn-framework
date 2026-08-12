import { describe, expect, it, vi } from 'vitest';

import {
  AUTOMATA_BUS_LESSON_ATTRIBUTION_FEATURE,
  type AutomataBusFindingEvent,
} from '../../../faculties/automata/bus/contract.js';
import type { AutomataBusSqlPool } from '../../../faculties/automata/bus/postgres-store.js';
import type { AutomataBusVectorIndexPort } from '../../../faculties/automata/bus/query-ports.js';
import { PostgresAdminAutomataBusReadAdapter } from './automata-bus-read-adapter.js';

const event: AutomataBusFindingEvent = {
  schemaVersion: 1,
  eventId: 'event-1',
  companionId: 'companion-a',
  sequence: 1,
  occurredAt: '2026-08-11T12:00:00.000Z',
  mustUnderstand: [],
  type: 'finding',
  context: {
    automatonClass: 'subagent.bounded',
    runId: 'run-1',
    taskId: 'task-1',
    sessionIds: [],
    artifactRefs: [],
  },
  body: {
    claim: 'Focused checks passed.',
    provenance: 'computed',
    evidence: [{
      kind: 'artifact',
      reference: 'urn:test:focused-check',
      summary: 'Focused test output.',
      digest: `sha256:${'a'.repeat(64)}`,
    }],
    verification: {
      status: 'verified',
      by: 'operator',
      evidenceRefs: ['urn:test:focused-check'],
    },
  },
};

const attributedEvent: AutomataBusFindingEvent = {
  ...event,
  eventId: 'event-attributed',
  mustUnderstand: [AUTOMATA_BUS_LESSON_ATTRIBUTION_FEATURE],
  body: {
    ...event.body,
    lessonAttribution: {
      promptRevision: 'sha256:prompt-r1',
      toolName: 'repo',
      failureCategory: 'missing-instruction',
      lessonCode: 'read-before-edit',
      contradictionEventIds: [],
    },
  },
};

function vector(
  state: Awaited<ReturnType<AutomataBusVectorIndexPort['readState']>> = {
    indexState: 'ready',
    reindexState: 'current',
    modelIdentity: { provider: 'api', model: 'embedding-v1', dimensions: 3 },
    indexingLag: { pendingCount: 0 },
  },
): Pick<AutomataBusVectorIndexPort, 'readState'> {
  return { readState: vi.fn(async () => state) };
}

function pool(): { pool: AutomataBusSqlPool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(async (text: string) => {
    if (text.includes('FROM automata_bus_events') && text.includes('MAX(occurred_at)')) {
      return { rows: [{ last_event_at: event.occurredAt }], rowCount: 1 };
    }
    if (text.includes('FROM automata_bus_events')) {
      return { rows: [{ event_json: event }], rowCount: 1 };
    }
    if (text.includes('FROM automata_bus_current_findings')) {
      return {
        rows: [{
          event_json: text.includes('lessonAttribution') ? attributedEvent : event,
          audiences: ['operator'],
          sensitivity: 'personal',
        }],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });
  return {
    query,
    pool: {
      query,
      connect: vi.fn(async () => {
        throw new Error('not used');
      }),
    },
  };
}

describe('PostgresAdminAutomataBusReadAdapter', () => {
  it('returns a bounded operator-visible page and live index health', async () => {
    const database = pool();
    const adapter = new PostgresAdminAutomataBusReadAdapter({
      pool: database.pool,
      vector: vector(),
      companionId: 'companion-a',
      maxPageLimit: 20,
      now: () => new Date('2026-08-11T12:01:00.000Z'),
    });

    const page = await adapter.readPage({
      companionId: 'companion-a',
      offset: 0,
      limit: 4,
      classId: 'subagent.bounded',
      runId: 'run-1',
      taskId: 'task-1',
      verificationStatus: 'verified',
    });

    expect(page).toMatchObject({
      companionId: 'companion-a',
      events: [{ eventId: 'event-1' }],
      currentFindings: [{ eventId: 'event-1', sourceEventType: 'finding' }],
      dispositions: [],
      hasMore: false,
      health: {
        condition: 'healthy',
        freshness: 'fresh',
        observedAt: '2026-08-11T12:01:00.000Z',
        lastEventAt: event.occurredAt,
        indexState: 'ready',
        reindexState: 'current',
        pendingIndexCount: 0,
        degradationReasons: [],
      },
    });
    const eventCall = database.query.mock.calls.find(([sql]) => (
      String(sql).includes('FROM automata_bus_events') && !String(sql).includes('MAX(occurred_at)')
    ));
    expect(eventCall?.[0]).toContain("'operator' = ANY(e.audiences)");
    expect(eventCall?.[0]).toContain('LIMIT');
    expect(eventCall?.[1]).toEqual(expect.arrayContaining([
      'companion-a',
      ['public', 'personal', 'intimate', 'confidential'],
      'subagent.bounded',
      'run-1',
      'task-1',
      'verified',
      5,
      0,
    ]));
  });

  it('reports derived-index degradation without hiding canonical Bus availability', async () => {
    const database = pool();
    const adapter = new PostgresAdminAutomataBusReadAdapter({
      pool: database.pool,
      vector: vector({
        indexState: 'building',
        reindexState: 'required',
        modelIdentity: { provider: 'api', model: 'embedding-v2', dimensions: 3 },
        indexingLag: {
          pendingCount: 2,
          oldestPendingAt: '2026-08-11T11:00:00.000Z',
          lastFailureAt: '2026-08-11T11:30:00.000Z',
        },
      }),
      companionId: 'companion-a',
      maxPageLimit: 20,
      now: () => new Date('2026-08-11T12:01:00.000Z'),
    });

    const page = await adapter.readPage({ companionId: 'companion-a', offset: 0, limit: 4 });
    expect(page.health).toMatchObject({
      condition: 'degraded',
      freshness: 'stale',
      degradationReasons: ['index_building', 'index_lagging', 'reindex_required'],
      pendingIndexCount: 2,
    });
  });

  it('logs vector-state failures before reporting the derived index unavailable', async () => {
    const database = pool();
    const logger = { error: vi.fn() };
    const adapter = new PostgresAdminAutomataBusReadAdapter({
      pool: database.pool,
      vector: {
        readState: vi.fn(async () => {
          throw new Error('vector state unavailable');
        }),
      },
      companionId: 'companion-a',
      maxPageLimit: 20,
      logger,
    });

    const page = await adapter.readPage({ companionId: 'companion-a', offset: 0, limit: 4 });

    expect(page.health).toMatchObject({
      condition: 'degraded',
      indexState: 'unavailable',
      degradationReasons: ['index_unavailable', 'reindex_required'],
    });
    expect(logger.error).toHaveBeenCalledWith('Automata Bus vector state read failed', {
      error: 'vector state unavailable',
    });
  });

  it('composes the content-safe current-finding lesson projection', async () => {
    const database = pool();
    const adapter = new PostgresAdminAutomataBusReadAdapter({
      pool: database.pool,
      vector: vector(),
      companionId: 'companion-a',
      maxPageLimit: 20,
    });

    const projection = await adapter.query({
      companionId: 'companion-a',
      audience: 'operator',
      maxSensitivity: 'personal',
    });

    expect(projection).toMatchObject({
      sourceFindingCount: 1,
      groups: [{
        promptRevision: 'sha256:prompt-r1',
        lessonCode: 'read-before-edit',
        sourceFindingIds: ['event-attributed'],
        evidenceIds: [expect.stringMatching(/^sha256:/u)],
      }],
    });
    expect(JSON.stringify(projection)).not.toContain(event.body.claim);
    expect(JSON.stringify(projection)).not.toContain(event.body.evidence[0]?.summary);
    expect(JSON.stringify(projection)).not.toContain(event.body.evidence[0]?.reference);
  });

  it('rejects cross-companion and over-bound pages before SQL', async () => {
    const database = pool();
    const adapter = new PostgresAdminAutomataBusReadAdapter({
      pool: database.pool,
      vector: vector(),
      companionId: 'companion-a',
      maxPageLimit: 20,
    });
    await expect(adapter.readPage({ companionId: 'companion-b', offset: 0, limit: 1 }))
      .rejects.toThrow('companion scope mismatch');
    await expect(adapter.readPage({ companionId: 'companion-a', offset: 19, limit: 2 }))
      .rejects.toThrow('page exceeds maxPageLimit');
    expect(database.query).not.toHaveBeenCalled();
  });
});
