import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AUTOMATA_BUS_POSTGRES_SCHEMA_STATEMENTS } from '../../../faculties/automata/bus/postgres-schema.js';
import { PostgresAutomataBusStore } from '../../../faculties/automata/bus/postgres-store.js';
import type { AutomataBusEvent } from '../../../faculties/automata/bus/contract.js';
import {
  AUTOMATA_TERMINAL_HANDOFF_SOURCE,
  AUTOMATA_TERMINAL_NO_FINDING_SOURCE,
} from '../../../faculties/automata/terminal-lifecycle.js';
import { createPostgresPool, runPostgresMigrations } from '../../../persistence/postgres.js';
import { POSTGRES_VECTOR_EXTENSION_MIGRATION } from '../../../persistence/postgres/vector-extension-migration.js';
import {
  PGVECTOR_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { readAutomataClassActivity } from './automata-class-activity-sql.js';

const INTEGRATION_TIMEOUT_MS = 120_000;

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: PGVECTOR_POSTGRES_TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, INTEGRATION_TIMEOUT_MS);

function finding(input: {
  companionId: string;
  sequence: number;
  automatonClass: string;
  runId: string;
  occurredAt: string;
  source?: string;
}): AutomataBusEvent {
  return {
    schemaVersion: 1,
    eventId: `event-${input.sequence}`,
    companionId: input.companionId,
    sequence: input.sequence,
    occurredAt: input.occurredAt,
    mustUnderstand: [],
    context: {
      automatonClass: input.automatonClass,
      runId: input.runId,
      taskId: 'task',
      sessionIds: [],
      artifactRefs: [],
    },
    type: 'finding',
    body: {
      claim: 'Private claim text that must never leave the aggregate.',
      provenance: 'computed',
      evidence: [{ kind: 'artifact', reference: `artifact:${input.runId}`, summary: 'Run lineage' }],
      verification: { status: 'pending' },
      ...(input.source ? { source: input.source } : {}),
    },
  } as AutomataBusEvent;
}

describe('readAutomataClassActivity (Postgres)', () => {
  it('aggregates useful, empty, and worker activity per class inside the window, per companion', async () => {
    if (!harness) throw new Error('Postgres harness unavailable');
    const database = await harness.createDatabase();
    const pool = createPostgresPool(database.databaseUrl, {
      applicationName: 'automata-class-activity-integration',
      allowExitOnIdle: true,
      max: 4,
    });
    try {
      await runPostgresMigrations(pool, [
        POSTGRES_VECTOR_EXTENSION_MIGRATION,
        ...AUTOMATA_BUS_POSTGRES_SCHEMA_STATEMENTS,
      ]);
      const store = new PostgresAutomataBusStore(pool);
      const useful = AUTOMATA_TERMINAL_HANDOFF_SOURCE;
      const empty = AUTOMATA_TERMINAL_NO_FINDING_SOURCE;
      const plan: Array<[string, number, string, string, string, string | undefined]> = [
        // companion, sequence, class, run, occurredAt, source
        ['companion-a', 1, 'memory.extraction', 'run-old', '2026-09-01T00:00:00.000Z', useful],
        ['companion-a', 2, 'memory.extraction', 'run-1', '2026-09-20T00:00:00.000Z', useful],
        ['companion-a', 3, 'memory.extraction', 'run-2', '2026-09-20T01:00:00.000Z', empty],
        ['companion-a', 4, 'memory.extraction', 'run-2', '2026-09-20T01:00:00.000Z', undefined],
        ['companion-a', 5, 'memory.extraction', 'run-3', '2026-09-21T00:00:00.000Z', useful],
        ['companion-a', 6, 'memory.extraction', 'run-4', '2026-09-22T00:00:00.000Z', empty],
        ['companion-a', 7, 'memory.extraction', 'run-5', '2026-09-23T00:00:00.000Z', empty],
        ['companion-a', 8, 'scheduler.free_time', 'run-6', '2026-09-23T00:00:00.000Z', empty],
        // The same logical ids under another companion must never leak across.
        ['companion-b', 1, 'memory.extraction', 'run-1', '2026-09-20T00:00:00.000Z', empty],
        ['companion-b', 2, 'memory.extraction', 'run-9', '2026-09-20T00:00:00.000Z', empty],
      ];
      for (const [companionId, sequence, automatonClass, runId, occurredAt, source] of plan) {
        await store.append({
          companionId,
          event: finding({
            companionId,
            sequence,
            automatonClass,
            runId,
            occurredAt,
            ...(source ? { source } : {}),
          }),
          audiences: ['eligible-automata', 'operator'],
          sensitivity: 'confidential',
        });
      }

      const read = await readAutomataClassActivity(pool, 'companion-a', {
        companionId: 'companion-a',
        windowStartMs: Date.parse('2026-09-10T00:00:00.000Z'),
        terminalRunIds: ['run-1', 'run-5', 'run-7', 'run-9'],
      });

      expect(read.classes).toEqual([
        {
          automatonClass: 'memory.extraction',
          usefulHandoffs: 2,
          noFindingHandoffs: 3,
          workerFindings: 1,
          lastUsefulAt: '2026-09-21T00:00:00.000Z',
          emptyStreak: 2,
        },
        {
          automatonClass: 'scheduler.free_time',
          usefulHandoffs: 0,
          noFindingHandoffs: 1,
          workerFindings: 0,
          lastUsefulAt: null,
          emptyStreak: 1,
        },
      ]);
      // run-9 has a handoff only under companion-b; run-7 has none at all.
      expect([...read.handoffRunIds].sort()).toEqual(['run-1', 'run-5']);
      expect(JSON.stringify(read)).not.toContain('Private claim text');

      const other = await readAutomataClassActivity(pool, 'companion-b', {
        companionId: 'companion-b',
        windowStartMs: 0,
        terminalRunIds: ['run-1', 'run-5'],
      });
      expect(other.classes).toEqual([expect.objectContaining({
        automatonClass: 'memory.extraction',
        usefulHandoffs: 0,
        noFindingHandoffs: 2,
        emptyStreak: 2,
      })]);
      expect(other.handoffRunIds).toEqual(['run-1']);

      await expect(readAutomataClassActivity(pool, 'companion-a', {
        companionId: 'companion-b',
        windowStartMs: 0,
        terminalRunIds: [],
      })).rejects.toThrow('companion scope mismatch');
    } finally {
      await pool.end();
    }
  }, INTEGRATION_TIMEOUT_MS);
});
