import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BACKGROUND_WORK_LEASE_EXPIRY_LIMIT,
  createBackgroundWorkIdentity,
  fingerprintBackgroundWorkPayload,
  type ClaimedBackgroundWorkJob,
  type EnqueueBackgroundWorkInput,
  type MemoryExtractionBackgroundPayload,
} from '../../core/agent/background-work/types.js';
import { createBackgroundWorkRunRedeliveryOracle } from '../../core/agent/background-work/automata-run-redelivery.js';
import { createBackgroundWorkAutomataLifecycle } from '../../app/agent/automata-background-work-lifecycle.js';
import {
  AUTOMATA_RUN_PROCESS_RESTART_REASON,
  AutomataRunRegistry,
} from '../../faculties/automata/run-registry.js';
import { loadAutomataPolicySeedDefaults } from '../../system/config/automata-policy-config.js';
import { createPostgresPool, runPostgresMigrations } from '../postgres.js';
import { POSTGRES_AUTOMATA_MIGRATIONS } from './migrations.js';
import { POSTGRES_VECTOR_EXTENSION_MIGRATION } from './vector-extension-migration.js';
import { PostgresAutomataRunStore } from './automata-run-store.js';
import { PostgresBackgroundWorkStore } from './background-work-store.js';
import {
  PGVECTOR_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';

const COMPANION_ID = 'companion-public-example';
const LEASE_MS = 10_000;
const INTEGRATION_TIMEOUT_MS = 120_000;

function memoryInput(turnId: string): EnqueueBackgroundWorkInput & { payload: MemoryExtractionBackgroundPayload } {
  const logicalSessionId = `session-${turnId}`;
  const payload: MemoryExtractionBackgroundPayload = {
    schemaVersion: 1,
    kind: 'memory_extraction',
    source: {
      schemaVersion: 1,
      logicalSessionId,
      channelId: logicalSessionId,
      turnId,
      requestId: `request-${turnId}`,
      turnRecordFingerprint: 'a'.repeat(64),
      createdAtMs: 100,
    },
  };
  return {
    ...createBackgroundWorkIdentity({ logicalSessionId, turnId, kind: payload.kind }),
    logicalSessionId,
    kind: payload.kind,
    payload,
    payloadFingerprint: fingerprintBackgroundWorkPayload(payload),
    sourceTurnId: turnId,
    sourceRequestId: `request-${turnId}`,
    sourceChannelId: logicalSessionId,
    createdAtMs: 100,
    maxAttempts: 3,
  };
}

interface Fixture {
  jobs: PostgresBackgroundWorkStore;
  runStore: PostgresAutomataRunStore;
  hydrate(nowMs: number): Promise<AutomataRunRegistry>;
  close(): Promise<void>;
}

describe('background-work restart linkage for lease_retry Automata runs', () => {
  let harness: PostgresTestHarness;

  beforeAll(async () => {
    harness = await startPostgresTestHarness({ image: PGVECTOR_POSTGRES_TEST_IMAGE });
  }, INTEGRATION_TIMEOUT_MS);

  afterAll(async () => {
    await harness.stop();
  }, INTEGRATION_TIMEOUT_MS);

  async function fixture(): Promise<Fixture> {
    const database = await harness.createDatabase();
    const owner = createPostgresPool(database.databaseUrl, {
      applicationName: 'background-work-run-linkage-migrations',
      allowExitOnIdle: true,
      max: 1,
    });
    try {
      await runPostgresMigrations(owner, [POSTGRES_VECTOR_EXTENSION_MIGRATION, ...POSTGRES_AUTOMATA_MIGRATIONS]);
    } finally {
      await owner.end();
    }
    const jobs = await PostgresBackgroundWorkStore.connect(database.databaseUrl);
    const runStore = await PostgresAutomataRunStore.connect(database.databaseUrl, COMPANION_ID);
    return {
      jobs,
      runStore,
      hydrate: async nowMs => await AutomataRunRegistry.hydrate({
        companionId: COMPANION_ID,
        policy: loadAutomataPolicySeedDefaults(),
        store: runStore,
        redelivery: createBackgroundWorkRunRedeliveryOracle(jobs),
        nowMs,
      }),
      close: async () => {
        await jobs.close();
        await runStore.close();
      },
    };
  }

  async function claim(jobs: PostgresBackgroundWorkStore, nowMs: number): Promise<ClaimedBackgroundWorkJob> {
    const claimed = await jobs.claimNext({
      leaseOwner: 'previous-process',
      nowMs,
      leaseDurationMs: LEASE_MS,
      excludedLogicalSessionIds: [],
    });
    if (!claimed) throw new Error('expected a claimable background-work job');
    return claimed;
  }

  it('matches only non-terminal jobs by request, job, or turn identity and reports boundary crossing', async () => {
    const { jobs, close } = await fixture();
    try {
      const live = memoryInput('turn-live');
      const crossed = memoryInput('turn-crossed');
      const done = memoryInput('turn-done');
      await jobs.enqueue(live);
      const liveClaim = await claim(jobs, 200);
      expect(liveClaim.jobId).toBe(live.jobId);
      await jobs.complete({
        jobId: liveClaim.jobId,
        leaseOwner: liveClaim.leaseOwner,
        expectedRevision: liveClaim.revision,
        nowMs: 210,
      });
      await jobs.enqueue(crossed);
      const boundaryClaim = await claim(jobs, 220);
      await jobs.beginEffect({
        jobId: boundaryClaim.jobId,
        effectKey: 'memory-extraction',
        leaseOwner: boundaryClaim.leaseOwner,
        expectedRevision: boundaryClaim.revision,
        nowMs: 220,
      });
      expect(await jobs.commitEffectBoundary({
        jobId: boundaryClaim.jobId,
        effectKey: 'memory-extraction',
        leaseOwner: boundaryClaim.leaseOwner,
        expectedRevision: boundaryClaim.revision,
        nowMs: 220,
      })).toBe('crossed');
      expect(boundaryClaim.jobId).toBe(crossed.jobId);
      await jobs.enqueue(done);

      const rows = await jobs.listNonTerminalJobsForRunLinkage({
        sourceRequestIds: [`request-turn-live`],
        jobIds: [boundaryClaim.jobId],
        sourceTurnIds: ['turn-done', 'turn-unknown'],
      });
      // turn-live completed (terminal) and is excluded even though its request id matches.
      expect(rows.map(row => row.jobId).sort()).toEqual([boundaryClaim.jobId, done.jobId].sort());
      expect(rows.find(row => row.jobId === boundaryClaim.jobId)).toMatchObject({
        kind: 'memory_extraction',
        state: 'running',
        sourceTurnId: boundaryClaim.sourceTurnId,
        leaseExpiresAtMs: 220 + LEASE_MS,
        leaseExpiryCount: 0,
        boundaryCrossed: true,
      });
      expect(rows.find(row => row.jobId === done.jobId)).toMatchObject({
        state: 'queued',
        sourceRequestId: 'request-turn-done',
        attemptCount: 0,
        boundaryCrossed: false,
      });
      expect(rows.find(row => row.jobId === done.jobId)).not.toHaveProperty('leaseExpiresAtMs');
    } finally {
      await close();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('fails runs no live job owns, keeps a reclaimable run, and lets redelivery re-enter it', async () => {
    const { jobs, hydrate, close } = await fixture();
    try {
      // Previous process: one reclaimable job, one poison claim that has
      // exhausted its lease-expiry budget, and one orchestrator-owned run with
      // no job at all (the production orphan shape).
      const reclaimable = memoryInput('turn-reclaimable');
      const exhausted = memoryInput('turn-exhausted');
      await jobs.enqueue(exhausted);
      let nowMs = 200;
      for (let expiry = 0; expiry < BACKGROUND_WORK_LEASE_EXPIRY_LIMIT - 1; expiry += 1) {
        await claim(jobs, nowMs);
        nowMs += LEASE_MS;
        expect((await jobs.recoverExpired({ nowMs })).recoveredCount).toBe(1);
      }
      await jobs.enqueue(reclaimable);
      const previous = await hydrate(nowMs);
      const lifecycle = createBackgroundWorkAutomataLifecycle(previous);
      const exhaustedClaim = await claim(jobs, nowMs);
      expect(exhaustedClaim.jobId).toBe(exhausted.jobId);
      await lifecycle.onClaimed({ job: exhaustedClaim, payload: exhausted.payload });
      const reclaimableClaim = await claim(jobs, nowMs);
      expect(reclaimableClaim.jobId).toBe(reclaimable.jobId);
      await lifecycle.onClaimed({ job: reclaimableClaim, payload: reclaimable.payload });
      await previous.register({
        runId: 'turn-orphan:memory-extraction',
        automatonClass: 'memory.extraction',
        workerId: 'memory-extraction',
        taskId: 'session-orphan',
        taskLabel: 'Memory extraction',
        taskSummary: 'Memory extraction triggered by response_turn',
        sessionIds: ['session-orphan'],
        createdAtMs: 100,
      });
      await previous.transition('turn-orphan:memory-extraction', {
        status: 'running',
        reason: 'memory_extraction_started',
      });

      // The process dies; its leases expire before the new process starts.
      const restartMs = nowMs + LEASE_MS + 1;
      const restarted = await hydrate(restartMs);

      expect(restarted.getRun('request-turn-reclaimable')?.status).toBe('running');
      for (const runId of ['request-turn-exhausted', 'turn-orphan:memory-extraction']) {
        expect(restarted.getRun(runId)).toMatchObject({
          status: 'failed',
          statusReason: AUTOMATA_RUN_PROCESS_RESTART_REASON,
          outcome: 'blocked',
          failureReason: expect.stringContaining('no live background-work job owns this run'),
        });
      }

      // The first supervisor tick agrees: it re-leases the reclaimable job and
      // dead-letters the exhausted one.
      const recovery = await jobs.recoverExpired({ nowMs: restartMs });
      expect(recovery.terminalJobs.map(job => job.jobId)).toEqual([exhausted.jobId]);

      // Redelivery re-enters the kept run under the same id and settles it.
      const redelivered = await claim(jobs, restartMs);
      expect(redelivered.jobId).toBe(reclaimable.jobId);
      const restartedLifecycle = createBackgroundWorkAutomataLifecycle(restarted);
      await restartedLifecycle.onClaimed({ job: redelivered, payload: reclaimable.payload });
      await restartedLifecycle.onCompleted({ job: redelivered, payload: reclaimable.payload });
      expect(restarted.getRun('request-turn-reclaimable')).toMatchObject({
        status: 'completed',
        statusReason: 'background_work_completed',
      });

      // A later restart has nothing left to reconcile.
      const settled = await hydrate(restartMs + 1);
      expect(settled.listRuns({ status: 'running' })).toEqual([]);
    } finally {
      await close();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('terminalizes the linked runs of a job the sweep dead-letters in a live process (vxllk)', async () => {
    const { jobs, hydrate, close } = await fixture();
    try {
      const exhausted = memoryInput('turn-live-poison');
      await jobs.enqueue(exhausted);
      let nowMs = 200;
      for (let expiry = 0; expiry < BACKGROUND_WORK_LEASE_EXPIRY_LIMIT - 1; expiry += 1) {
        await claim(jobs, nowMs);
        nowMs += LEASE_MS;
        expect((await jobs.recoverExpired({ nowMs })).recoveredCount).toBe(1);
      }
      // One live registry for the whole scenario: no restart hydrate runs.
      const live = await hydrate(nowMs);
      const lifecycle = createBackgroundWorkAutomataLifecycle(live);
      const lastClaim = await claim(jobs, nowMs);
      await lifecycle.onClaimed({ job: lastClaim, payload: exhausted.payload });
      await live.register({
        runId: 'turn-live-poison:memory-extraction',
        automatonClass: 'memory.extraction',
        workerId: 'memory-extraction',
        taskId: 'session-turn-live-poison',
        taskLabel: 'Memory extraction',
        taskSummary: 'Memory extraction triggered by response_turn',
        sessionIds: ['session-turn-live-poison'],
        createdAtMs: nowMs,
      });

      // The claiming process dies mid-lifetime; the live supervisor's sweep
      // dead-letters the job and terminalizes what it could have opened.
      nowMs += LEASE_MS + 1;
      const recovery = await jobs.recoverExpired({ nowMs });
      expect(recovery.terminalJobs.map(job => job.jobId)).toEqual([exhausted.jobId]);
      for (const job of recovery.terminalJobs) {
        await lifecycle.onExpiredTerminal({ job, reasonCode: job.reasonCode });
      }

      expect(live.listRuns({ status: 'running' })).toEqual([]);
      expect(live.listRuns({ status: 'queued' })).toEqual([]);
      for (const runId of ['request-turn-live-poison', 'turn-live-poison:memory-extraction']) {
        expect(live.getRun(runId)).toMatchObject({ status: 'failed', statusReason: 'background_work_failed' });
      }
      // Durable, not just in-memory: a fresh hydrate sees the same terminal state.
      const reloaded = await hydrate(nowMs + 1);
      expect(reloaded.getRun('request-turn-live-poison')).toMatchObject({ status: 'failed' });
    } finally {
      await close();
    }
  }, INTEGRATION_TIMEOUT_MS);
});
