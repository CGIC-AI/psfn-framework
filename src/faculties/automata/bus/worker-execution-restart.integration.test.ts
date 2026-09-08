import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresPool, runPostgresMigrations } from '../../../persistence/postgres.js';
import { POSTGRES_AUTOMATA_MIGRATIONS } from '../../../persistence/postgres/migrations.js';
import { POSTGRES_VECTOR_EXTENSION_MIGRATION } from '../../../persistence/postgres/vector-extension-migration.js';
import { PostgresAutomataRunStore } from '../../../persistence/postgres/automata-run-store.js';
import { SENSITIVITY_LEVELS } from '../../../system/trust/types.js';
import {
  PGVECTOR_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { createMemoryExtractionAutomataRunPort } from '../../memory/extraction/memory-extraction-automata-run.js';
import { parseAutomataOwnerPolicy } from '../registry-contract.js';
import { AutomataRunRegistry } from '../run-registry.js';
import {
  AUTOMATA_TERMINAL_HANDOFF_SOURCE,
  AUTOMATA_TERMINAL_NO_FINDING_SOURCE,
} from '../terminal-lifecycle.js';
import type { AutomataBusEvent } from './contract.js';
import type { AutomataBusProductionRuntime } from './production-runtime.js';
import {
  automataBusWorkerBoundsFromOwnerPolicy,
  CanonicalAutomataBusWriter,
  createAutomataTerminalLifecycleAdapter,
  createProductionAutomataBusWorkerAccess,
} from './production-worker-adapter.js';
import { PostgresAutomataBusRuntimeStore } from './runtime-store.js';
import { AUTOMATA_BUS_WORKER_BRIEFING_SCHEMA_VERSION } from './worker-access.js';
import { openAutomataBusWorkerRun } from './worker-execution.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const COMPANION_A = 'companion-public-example-a';
const COMPANION_B = 'companion-public-example-b';
const RUN_ID = 'request-public-example-1';
const TASK_ID = 'channel-public-example';
const SESSION_ID = 'session-public-example';

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: PGVECTOR_POSTGRES_TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, INTEGRATION_TIMEOUT_MS);

function ownerPolicy() {
  return parseAutomataOwnerPolicy(JSON.parse(readFileSync(
    new URL('../../../../config/automata-policy.seed.json', import.meta.url),
    'utf8',
  )));
}

/**
 * Query/index surfaces are stubbed so this test measures exactly one thing: the
 * durable run, terminal event, and idempotency identity surviving a restart of
 * every in-process object. Appends, reads, and run transitions are real.
 */
function stubRuntime(): AutomataBusProductionRuntime {
  return {
    canonical: { getCurrentByEventIds: async () => [] },
    indexing: {
      indexCurrentFinding: async () => {
        throw new Error('Restart certification must not reach the semantic index');
      },
    },
    query: {
      createSpawnBriefing: async () => ({
        text: 'Automata Bus briefing',
        itemCount: 0,
        diagnostics: {
          cache: 'miss',
          semanticPath: 'exact-fallback',
          indexState: 'ready',
          reindexState: 'current',
          modelIdentity: null,
          indexingLag: { pendingCount: 0 },
        },
      }),
      search: async () => ({ results: [] }),
    },
  } as unknown as AutomataBusProductionRuntime;
}

interface Process {
  registry: AutomataRunRegistry;
  store: PostgresAutomataBusRuntimeStore;
  runStore: PostgresAutomataRunStore;
  access: ReturnType<typeof createProductionAutomataBusWorkerAccess>;
  terminal: ReturnType<typeof createAutomataTerminalLifecycleAdapter>;
  close: () => Promise<void>;
}

/** Build every companion-scoped runtime object as a cold process would. */
async function startProcess(databaseUrl: string, companionId: string): Promise<Process> {
  const policy = ownerPolicy();
  const runStore = await PostgresAutomataRunStore.connect(databaseUrl, companionId);
  const registry = await AutomataRunRegistry.hydrate({ companionId, policy, store: runStore });
  const pool = createPostgresPool(databaseUrl, {
    applicationName: `automata-restart-${companionId}`,
    allowExitOnIdle: true,
    max: 2,
  });
  const store = new PostgresAutomataBusRuntimeStore(pool, companionId, registry);
  const runtime = stubRuntime();
  const writer = new CanonicalAutomataBusWriter({ companionId, store, runtime });
  return {
    registry,
    store,
    runStore,
    access: createProductionAutomataBusWorkerAccess({
      companionId,
      registry,
      store,
      runtime,
      writer,
      bounds: automataBusWorkerBoundsFromOwnerPolicy({
        query: policy.bus.query,
        recentRunLimit: policy.recentRunLimit,
      }),
    }),
    terminal: createAutomataTerminalLifecycleAdapter({ companionId, registry, store, writer }),
    close: async () => {
      await store.close();
      await registry.close();
    },
  };
}

/**
 * Uses the current clock so the restarted process hydrates the run from within
 * its retention window, which is the state a real restart observes.
 */
function runPortInput(createdAtMs: number) {
  return {
    runId: RUN_ID,
    taskId: TASK_ID,
    sessionId: SESSION_ID,
    triggerReason: 'response_turn' as const,
    createdAtMs,
  };
}

async function openRun(process: Process, createdAtMs: number) {
  return await openAutomataBusWorkerRun({
    access: process.access,
    run: createMemoryExtractionAutomataRunPort(process.registry, runPortInput(createdAtMs)),
    terminal: process.terminal,
    briefingQuery: 'memory extraction response_turn',
  });
}

async function terminalEvents(process: Process): Promise<AutomataBusEvent[]> {
  const history = await process.store.readHistory({
    companionId: process.registry.getCompanionId(),
    audience: 'eligible-automata',
    maxSensitivity: SENSITIVITY_LEVELS.at(-1)!,
  });
  return history.filter(event => (
    event.type === 'finding'
    && (event.body.source === AUTOMATA_TERMINAL_HANDOFF_SOURCE
      || event.body.source === AUTOMATA_TERMINAL_NO_FINDING_SOURCE)
  ));
}

async function withDatabase<T>(operation: (databaseUrl: string) => Promise<T>): Promise<T> {
  if (!harness) throw new Error('Automata restart Postgres harness is unavailable');
  const database = await harness.createDatabase();
  const owner: Pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'automata-restart-migrations',
    allowExitOnIdle: true,
    max: 1,
  });
  try {
    await runPostgresMigrations(owner, [
      POSTGRES_VECTOR_EXTENSION_MIGRATION,
      ...POSTGRES_AUTOMATA_MIGRATIONS,
    ]);
  } finally {
    await owner.end();
  }
  return await operation(database.databaseUrl);
}

describe('governed Automata lifecycle restart certification', () => {
  it('terminalizes exactly once across a full process restart', async () => {
    await withDatabase(async databaseUrl => {
      const createdAtMs = Date.now();
      const first = await startProcess(databaseUrl, COMPANION_A);
      const session = await openRun(first, createdAtMs);
      expect(session.binding.execute).toBe(true);
      expect(session.binding.attempt).toBe(1);
      expect(session.promptBlock).toContain('Automata Bus');
      const settlement = await session.settle({
        lifecycleState: 'completed',
        outcome: 'completed',
        stateReason: 'memory_extraction_completed',
        resultKind: 'final',
        summary: 'Memory extraction process result: parsed=1; accepted=1; written=1.',
      });
      expect(settlement.handoff).toMatchObject({ status: 'recorded', replay: false });
      expect(settlement.terminalized).toBe(true);
      expect(settlement.handoffKind).toBe('useful');
      expect(await terminalEvents(first)).toHaveLength(1);
      const idempotencyKey = settlement.handoff.status === 'recorded'
        ? settlement.handoff.idempotencyKey
        : null;
      expect(idempotencyKey).not.toBeNull();
      await first.close();

      // Restart: nothing in-process survives, only Postgres.
      const second = await startProcess(databaseUrl, COMPANION_A);
      const resumed = await openRun(second, createdAtMs);
      expect(resumed.binding.execute).toBe(false);
      const replay = await resumed.settle({
        lifecycleState: 'completed',
        outcome: 'completed',
        stateReason: 'memory_extraction_completed',
        resultKind: 'final',
        summary: 'A second summary that must never reach the Bus.',
      });
      expect(replay.terminalized).toBe(false);
      const events = await terminalEvents(second);
      expect(events).toHaveLength(1);
      expect(events[0]?.body).toMatchObject({ source: AUTOMATA_TERMINAL_HANDOFF_SOURCE });
      expect(second.registry.getRun(RUN_ID)).toMatchObject({
        companionId: COMPANION_A,
        automatonClass: 'memory.extraction',
        status: 'completed',
        outcome: 'completed',
      });
      await second.close();
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('rejects a cross-companion terminal for another companion\'s run', async () => {
    await withDatabase(async databaseUrl => {
      const owner = await startProcess(databaseUrl, COMPANION_A);
      const session = await openRun(owner, Date.now());
      await session.settle({
        lifecycleState: 'completed',
        outcome: 'completed',
        stateReason: 'memory_extraction_completed',
        resultKind: 'final',
        summary: 'Memory extraction process result: parsed=0.',
      });

      const intruder = await startProcess(databaseUrl, COMPANION_B);
      await expect(intruder.terminal.recordTerminalHandoff({
        idempotencyKey: 'cross-companion-key',
        lineage: {
          automatonClass: 'memory.extraction',
          runId: RUN_ID,
          taskId: TASK_ID,
          workerId: 'memory-extraction',
          sessionIds: [SESSION_ID],
        },
        lifecycleState: 'completed',
        outcome: 'completed',
        stateReason: 'memory_extraction_completed',
        resultKind: 'final',
        handoffKind: 'useful',
        outputRefs: [],
        occurredAtMs: Date.now(),
      })).rejects.toThrow(/is not registered/u);
      expect(await terminalEvents(intruder)).toHaveLength(0);
      expect(await terminalEvents(owner)).toHaveLength(1);
      await intruder.close();
      await owner.close();
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('records a typed no-finding terminal for a run that never wrote to the Bus', async () => {
    await withDatabase(async databaseUrl => {
      const process = await startProcess(databaseUrl, COMPANION_A);
      const session = await openRun(process, Date.now());
      expect(session.observedBusWrites).toBe(0);
      const settlement = await session.settle({
        lifecycleState: 'completed',
        outcome: 'completed',
        stateReason: 'memory_extraction_completed',
        resultKind: 'none',
      });
      expect(settlement.handoffKind).toBe('no_finding');
      const events = await terminalEvents(process);
      expect(events).toHaveLength(1);
      expect(events[0]?.body).toMatchObject({ source: AUTOMATA_TERMINAL_NO_FINDING_SOURCE });
      await process.close();
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('exposes the briefing contract version the runtime accepts', () => {
    expect(AUTOMATA_BUS_WORKER_BRIEFING_SCHEMA_VERSION).toBe(1);
  });
});
