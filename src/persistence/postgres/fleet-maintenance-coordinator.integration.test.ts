import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createFleetMaintenanceCoordinator,
} from '../../core/scheduler/fleet-maintenance-coordinator.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { bootstrapSharedSchema } from './shared-schema.js';
import { PostgresFleetMaintenanceStore } from './fleet-maintenance-store.js';

const PROCESS_FIXTURE = fileURLToPath(
  new URL('./test-fixtures/fleet-maintenance-process.ts', import.meta.url),
);

const FLEET = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
] as const;

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness();
});

afterAll(async () => {
  await harness?.stop();
});

async function freshDatabaseUrl(): Promise<string> {
  if (!harness) throw new Error('Postgres test harness is not available');
  const database = await harness.createDatabase();
  await bootstrapSharedSchema(database.databaseUrl);
  return database.databaseUrl;
}

interface ProcessResponse<T> {
  requestId?: number;
  ready?: boolean;
  ok?: boolean;
  result?: T;
  error?: { name: string; message: string };
}

class FleetMaintenanceProcess {
  private nextRequestId = 1;
  private exited = false;

  private constructor(
    private readonly child: ChildProcess,
    private readonly stderr: { value: string },
  ) {
    child.once('exit', () => {
      this.exited = true;
    });
  }

  static async start(input: {
    databaseUrl: string;
    companionId: string;
    fleetCompanionIds: readonly string[];
  }): Promise<FleetMaintenanceProcess> {
    const child = fork(PROCESS_FIXTURE, [], {
      execArgv: ['--import', 'tsx'],
      env: {
        ...process.env,
        FLEET_MAINTENANCE_DATABASE_URL: input.databaseUrl,
        FLEET_MAINTENANCE_COMPANION_ID: input.companionId,
        FLEET_MAINTENANCE_COMPANION_IDS: JSON.stringify(input.fleetCompanionIds),
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const stderr = { value: '' };
    child.stderr?.on('data', chunk => {
      stderr.value += String(chunk);
    });
    await new Promise<void>((resolve, reject) => {
      const onMessage = (raw: unknown): void => {
        const response = raw as ProcessResponse<unknown>;
        if (response.ready === true) {
          cleanup();
          resolve();
        }
      };
      const onExit = (code: number | null): void => {
        cleanup();
        reject(new Error(
          `fleet maintenance child exited before ready (${code}): ${stderr.value}`,
        ));
      };
      const cleanup = (): void => {
        child.off('message', onMessage);
        child.off('exit', onExit);
      };
      child.on('message', onMessage);
      child.once('exit', onExit);
    });
    return new FleetMaintenanceProcess(child, stderr);
  }

  async request<T>(command: Record<string, unknown>): Promise<T> {
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    return await new Promise<T>((resolve, reject) => {
      const onMessage = (raw: unknown): void => {
        const response = raw as ProcessResponse<T>;
        if (response.requestId !== requestId) return;
        cleanup();
        if (response.ok === true) {
          resolve(response.result as T);
        } else {
          const error = new Error(response.error?.message ?? 'fleet maintenance child failed');
          error.name = response.error?.name ?? 'Error';
          reject(error);
        }
      };
      const onExit = (code: number | null): void => {
        cleanup();
        reject(new Error(`fleet maintenance child exited (${code}): ${this.stderr.value}`));
      };
      const cleanup = (): void => {
        this.child.off('message', onMessage);
        this.child.off('exit', onExit);
      };
      this.child.on('message', onMessage);
      this.child.once('exit', onExit);
      this.child.send({ ...command, requestId });
    });
  }

  async shutdown(): Promise<void> {
    if (this.exited) return;
    await this.request<void>({ action: 'shutdown' });
    await new Promise<void>(resolve => this.child.once('exit', () => resolve()));
    expect(this.stderr.value).toBe('');
  }

  async crash(): Promise<void> {
    if (this.exited) return;
    const exited = new Promise<void>(resolve => this.child.once('exit', () => resolve()));
    this.child.kill('SIGKILL');
    await exited;
  }
}

function fleetOfSize(size: number): string[] {
  return Array.from({ length: size }, (_unused, index) => (
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
  ));
}

describe('Postgres fleet maintenance coordinator', () => {
  it('grants one baton in manifest order across independent connections', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const stores = await Promise.all(FLEET.map(
      () => PostgresFleetMaintenanceStore.connect(databaseUrl),
    ));
    const coordinators = stores.map((store, index) => createFleetMaintenanceCoordinator({
      store,
      companionId: FLEET[index]!,
      fleetCompanionIds: FLEET,
    }));
    const nowMs = Date.parse('2026-08-29T04:00:00.000Z');

    try {
      await Promise.all(coordinators.map(coordinator => coordinator.announceDemand({
        nowMs,
        demandExpiresAtMs: nowMs + 60_000,
      })));
      const outcomes = await Promise.all(coordinators.map(coordinator => (
        coordinator.tryAcquire({
          nowMs: nowMs + 1,
          leaseExpiresAtMs: nowMs + 30_000,
          phase: 'episode-drain',
        })
      )));

      expect(outcomes.filter(outcome => outcome.outcome === 'acquired')).toEqual([
        expect.objectContaining({
          outcome: 'acquired',
          lease: expect.objectContaining({ companionId: FLEET[0], fencingToken: 1 }),
        }),
      ]);
    } finally {
      await Promise.all(stores.map(store => store.close()));
    }
  });

  it('checkpoints at a foreground yield boundary and rejects the released fence', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const [firstStore, secondStore] = await Promise.all([
      PostgresFleetMaintenanceStore.connect(databaseUrl),
      PostgresFleetMaintenanceStore.connect(databaseUrl),
    ]);
    const first = createFleetMaintenanceCoordinator({
      store: firstStore,
      companionId: FLEET[0],
      fleetCompanionIds: FLEET,
    });
    const second = createFleetMaintenanceCoordinator({
      store: secondStore,
      companionId: FLEET[1],
      fleetCompanionIds: FLEET,
    });
    const nowMs = Date.parse('2026-08-29T05:00:00.000Z');

    try {
      await Promise.all([first, second].map(coordinator => coordinator.announceDemand({
        nowMs,
        demandExpiresAtMs: nowMs + 60_000,
      })));
      const acquired = await first.tryAcquire({
        nowMs: nowMs + 1,
        leaseExpiresAtMs: nowMs + 20_000,
        phase: 'sleeptime-drain',
      });
      if (acquired.outcome !== 'acquired') throw new Error('first companion did not acquire');

      const renewed = await first.renew({
        lease: acquired.lease,
        nowMs: nowMs + 2,
        leaseExpiresAtMs: nowMs + 25_000,
      });
      expect(renewed.expiresAtMs).toBe(nowMs + 25_000);

      expect(await first.requestForegroundPreemption({ nowMs: nowMs + 2 })).toBe(true);
      const checkpointed = await first.commitCheckpoint({
        lease: renewed,
        nowMs: nowMs + 3,
        leaseExpiresAtMs: nowMs + 30_000,
        phase: 'session-2:wiki-pass',
        checkpointRef: 'sleeptime-workset:revision-7',
      });
      expect(checkpointed).toMatchObject({
        disposition: 'yield_requested',
        lease: {
          phase: 'session-2:wiki-pass',
          checkpointRef: 'sleeptime-workset:revision-7',
          preemptRequested: true,
        },
      });

      await first.release({
        lease: checkpointed.lease,
        nowMs: nowMs + 4,
        outcome: 'yield',
      });
      const next = await second.tryAcquire({
        nowMs: nowMs + 5,
        leaseExpiresAtMs: nowMs + 30_000,
        phase: 'episode-drain',
      });
      expect(next).toMatchObject({
        outcome: 'acquired',
        lease: { companionId: FLEET[1], fencingToken: 2 },
      });
      await expect(first.commitCheckpoint({
        lease: checkpointed.lease,
        nowMs: nowMs + 6,
        leaseExpiresAtMs: nowMs + 30_000,
        phase: 'stale-write',
        checkpointRef: 'must-not-commit',
      })).rejects.toThrow(/fencing authority was lost/u);
      expect(await first.readCheckpoint()).toMatchObject({
        companionId: FLEET[0],
        phase: 'session-2:wiki-pass',
        checkpointRef: 'sleeptime-workset:revision-7',
        fencingToken: 1,
      });
    } finally {
      await Promise.all([firstStore.close(), secondStore.close()]);
    }
  });

  it.each([3, 5, 10])(
    'bounds lease concurrency and eventually serves %i real companion processes',
    async (fleetSize) => {
      const databaseUrl = await freshDatabaseUrl();
      const fleet = fleetOfSize(fleetSize);
      const processes = await Promise.all(fleet.map(companionId => (
        FleetMaintenanceProcess.start({ databaseUrl, companionId, fleetCompanionIds: fleet })
      )));
      const nowMs = Date.parse('2026-08-29T06:00:00.000Z');
      try {
        await Promise.all(processes.map(process => process.request<void>({
          action: 'announce',
          nowMs,
          demandExpiresAtMs: nowMs + 120_000,
        })));
        const served: string[] = [];
        for (let round = 0; round < fleetSize; round += 1) {
          const outcomes = await Promise.all(processes.map(process => process.request<{
            outcome: 'acquired' | 'waiting';
            lease?: import('../../core/scheduler/fleet-maintenance-coordinator.js').FleetMaintenanceLease;
          }>({
            action: 'acquire',
            nowMs: nowMs + round * 10 + 1,
            leaseExpiresAtMs: nowMs + 60_000,
            phase: 'fleet-load-proof',
          })));
          const acquired = outcomes.filter(
            (outcome): outcome is typeof outcome & { lease: NonNullable<typeof outcome.lease> } => (
              outcome.outcome === 'acquired' && outcome.lease !== undefined
            ),
          );
          expect(acquired).toHaveLength(1);
          expect(acquired[0]!.lease.companionId).toBe(fleet[round]);
          served.push(acquired[0]!.lease.companionId);
          const winner = fleet.indexOf(acquired[0]!.lease.companionId);
          await processes[winner]!.request<void>({
            action: 'release',
            lease: acquired[0]!.lease,
            nowMs: nowMs + round * 10 + 2,
            outcome: 'complete',
          });
        }
        expect(served).toEqual(fleet);
      } finally {
        await Promise.all(processes.map(process => process.shutdown()));
      }
    },
  );

  it('expires a crashed holder, rejects its stale fence, and resumes its checkpoint after restart', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const fleet = fleetOfSize(2);
    const first = await FleetMaintenanceProcess.start({
      databaseUrl,
      companionId: fleet[0]!,
      fleetCompanionIds: fleet,
    });
    const second = await FleetMaintenanceProcess.start({
      databaseUrl,
      companionId: fleet[1]!,
      fleetCompanionIds: fleet,
    });
    let restarted: FleetMaintenanceProcess | null = null;
    const nowMs = Date.parse('2026-08-29T07:00:00.000Z');
    try {
      await Promise.all([
        first.request<void>({
          action: 'announce',
          nowMs,
          demandExpiresAtMs: nowMs + 100,
        }),
        second.request<void>({
          action: 'announce',
          nowMs,
          demandExpiresAtMs: nowMs + 10_000,
        }),
      ]);
      const acquired = await first.request<{
        outcome: 'acquired';
        lease: import('../../core/scheduler/fleet-maintenance-coordinator.js').FleetMaintenanceLease;
      }>({
        action: 'acquire',
        nowMs: nowMs + 1,
        leaseExpiresAtMs: nowMs + 50,
        phase: 'sleeptime-drain',
      });
      const checkpointed = await first.request<{
        lease: import('../../core/scheduler/fleet-maintenance-coordinator.js').FleetMaintenanceLease;
      }>({
        action: 'checkpoint',
        lease: acquired.lease,
        nowMs: nowMs + 2,
        leaseExpiresAtMs: nowMs + 50,
        phase: 'session-4:dream-pass',
        checkpointRef: 'sleeptime-workset:revision-12',
      });
      await first.crash();

      expect(await second.request<{ outcome: string; reason: string }>({
        action: 'acquire',
        nowMs: nowMs + 49,
        leaseExpiresAtMs: nowMs + 500,
        phase: 'episode-drain',
      })).toMatchObject({ outcome: 'waiting', reason: 'held' });
      const takeover = await second.request<{
        outcome: 'acquired';
        lease: import('../../core/scheduler/fleet-maintenance-coordinator.js').FleetMaintenanceLease;
      }>({
        action: 'acquire',
        nowMs: nowMs + 101,
        leaseExpiresAtMs: nowMs + 500,
        phase: 'episode-drain',
      });
      expect(takeover.lease).toMatchObject({ companionId: fleet[1], fencingToken: 2 });

      restarted = await FleetMaintenanceProcess.start({
        databaseUrl,
        companionId: fleet[0]!,
        fleetCompanionIds: fleet,
      });
      await expect(restarted.request({
        action: 'checkpoint',
        lease: checkpointed.lease,
        nowMs: nowMs + 102,
        leaseExpiresAtMs: nowMs + 600,
        phase: 'stale-replay',
        checkpointRef: 'must-not-commit',
      })).rejects.toMatchObject({ name: 'FleetMaintenanceFenceLostError' });
      await second.request<void>({
        action: 'release',
        lease: takeover.lease,
        nowMs: nowMs + 103,
        outcome: 'complete',
      });
      await restarted.request<void>({
        action: 'announce',
        nowMs: nowMs + 104,
        demandExpiresAtMs: nowMs + 10_000,
      });
      const resumed = await restarted.request<{
        outcome: 'acquired';
        lease: import('../../core/scheduler/fleet-maintenance-coordinator.js').FleetMaintenanceLease;
      }>({
        action: 'acquire',
        nowMs: nowMs + 105,
        leaseExpiresAtMs: nowMs + 700,
        phase: 'new-work-must-not-replace-checkpoint',
      });
      expect(resumed.lease).toMatchObject({
        companionId: fleet[0],
        fencingToken: 3,
        phase: 'session-4:dream-pass',
        checkpointRef: 'sleeptime-workset:revision-12',
      });
    } finally {
      await Promise.all([
        first.shutdown(),
        second.shutdown(),
        ...(restarted ? [restarted.shutdown()] : []),
      ]);
    }
  });

  it('skips manifest companions that do not announce healthy demand', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const fleet = fleetOfSize(3);
    const processes = await Promise.all(fleet.map(companionId => (
      FleetMaintenanceProcess.start({ databaseUrl, companionId, fleetCompanionIds: fleet })
    )));
    const nowMs = Date.parse('2026-08-29T08:00:00.000Z');
    try {
      await Promise.all([processes[0]!, processes[2]!].map(process => process.request<void>({
        action: 'announce',
        nowMs,
        demandExpiresAtMs: nowMs + 10_000,
      })));
      const first = await processes[0]!.request<{
        outcome: 'acquired';
        lease: import('../../core/scheduler/fleet-maintenance-coordinator.js').FleetMaintenanceLease;
      }>({
        action: 'acquire',
        nowMs: nowMs + 1,
        leaseExpiresAtMs: nowMs + 5_000,
        phase: 'fleet-order-proof',
      });
      await processes[0]!.request<void>({
        action: 'release',
        lease: first.lease,
        nowMs: nowMs + 2,
        outcome: 'complete',
      });
      const next = await Promise.all(processes.map(process => process.request<{
        outcome: 'acquired' | 'waiting';
        lease?: import('../../core/scheduler/fleet-maintenance-coordinator.js').FleetMaintenanceLease;
      }>({
        action: 'acquire',
        nowMs: nowMs + 3,
        leaseExpiresAtMs: nowMs + 5_000,
        phase: 'fleet-order-proof',
      })));
      const winner = next.find(outcome => outcome.outcome === 'acquired');
      expect(winner?.lease?.companionId).toBe(fleet[2]);
    } finally {
      await Promise.all(processes.map(process => process.shutdown()));
    }
  });
});
