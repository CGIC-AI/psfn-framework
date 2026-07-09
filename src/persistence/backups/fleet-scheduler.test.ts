// ── Unit tests for multi-companion fleet-backup scheduler wiring (sprint 10, W2) ──
// Covers leader election, per-companion path anchoring, group-mode selection, and
// partial-failure propagation on the scheduled-backup lane. The fleet cycle
// itself is covered end-to-end in fleet.test.ts; here we prove the WIRING that
// selects and drives it.

import { describe, expect, it, vi } from 'vitest';
import type { Scheduler } from '../../core/scheduler/scheduler.js';
import type { CompanionsFleetConfig } from '../../system/config/companions-config.js';
import type { BackupRuntimeConfig } from './config.js';
import {
  FleetBackupPartialFailureError,
  SCHEDULED_BACKUP_TASK_ID,
  type FleetBackupRunOptions,
  type FleetBackupRunResult,
  type FleetBackupUnitOutcome,
} from './service.js';
import {
  buildFleetBackupRunOptions,
  deriveFleetAnchorDir,
  isFleetBackupLeader,
  registerScheduledFleetBackupTask,
  resolveGroupCompanionDataDir,
} from './fleet-scheduler.js';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';

function makeFleet(): CompanionsFleetConfig {
  return {
    companions: [
      {
        companionId: COMPANION_A,
        companionDataDir: `companion-data/${COMPANION_A}`,
        characterCardPath: `companion-data/${COMPANION_A}/character.json`,
        postgresSchema: 'companion_alpha',
      },
      {
        companionId: COMPANION_B,
        companionDataDir: `companion-data/${COMPANION_B}`,
        characterCardPath: `companion-data/${COMPANION_B}/character.json`,
        postgresSchema: 'companion_beta',
      },
    ],
  };
}

function makeBackupConfig(overrides: Partial<BackupRuntimeConfig> = {}): BackupRuntimeConfig {
  return {
    intervalMs: 60_000,
    maxRotatingBackups: 9,
    maxWeeklyBackups: 2,
    maxMonthlyBackups: 1,
    rootDir: '/runtime/backups',
    mirrorDir: '',
    verifyRestore: false,
    groupMode: false,
    encryption: {
      mode: 'required',
      keyRef: { kind: 'env', envName: 'PSFN_BACKUP_TEST_KEY' },
      passphrase: 'test-pass',
    },
    ...overrides,
  };
}

describe('isFleetBackupLeader', () => {
  it('elects the first companion in manifest order', () => {
    const fleet = makeFleet();
    expect(isFleetBackupLeader(COMPANION_A, fleet)).toBe(true);
    expect(isFleetBackupLeader(COMPANION_B, fleet)).toBe(false);
  });

  it('fails closed when this process carries no companion id', () => {
    expect(() => isFleetBackupLeader(undefined, makeFleet())).toThrow(/COMPANION_ID/);
    expect(() => isFleetBackupLeader('   ', makeFleet())).toThrow(/COMPANION_ID/);
  });

  it('fails closed when the process companion id is absent from the fleet', () => {
    expect(() => isFleetBackupLeader('99999999-9999-4999-8999-999999999999', makeFleet()))
      .toThrow(/not present in the fleet manifest/);
  });
});

describe('deriveFleetAnchorDir', () => {
  it('strips the manifest-relative suffix to recover the persistence base', () => {
    expect(deriveFleetAnchorDir(
      `companion-data/${COMPANION_A}`,
      `/runtime/companion-data/${COMPANION_A}`,
    )).toBe('/runtime');
  });

  it('fails closed when the resolved dir does not carry the manifest suffix', () => {
    expect(() => deriveFleetAnchorDir(
      `companion-data/${COMPANION_A}`,
      '/runtime/somewhere-else/x',
    )).toThrow(/does not end with manifest path|not under a base/);
  });
});

describe('resolveGroupCompanionDataDir', () => {
  it('returns the common parent of every companion dir', () => {
    expect(resolveGroupCompanionDataDir(
      [`/runtime/companion-data/${COMPANION_A}`, `/runtime/companion-data/${COMPANION_B}`],
      '/runtime/system-data',
    )).toBe('/runtime/companion-data');
  });

  it('fails closed if the group parent would swallow the system-data root', () => {
    expect(() => resolveGroupCompanionDataDir(
      ['/runtime/a', '/runtime/b'],
      '/runtime/system-data',
    )).toThrow(/system-data root/);
  });

  it('fails closed when dirs share no meaningful parent', () => {
    expect(() => resolveGroupCompanionDataDir(
      ['/alpha/x', '/beta/y'],
      '/gamma/system-data',
    )).toThrow(/filesystem root/);
  });
});

describe('buildFleetBackupRunOptions', () => {
  const baseParams = () => ({
    fleet: makeFleet(),
    ownCompanionId: COMPANION_A,
    ownResolvedCompanionDataDir: `/runtime/companion-data/${COMPANION_A}`,
    systemDataDir: '/runtime/system-data',
    postgres: { databaseUrl: 'postgresql://psfn:secret@127.0.0.1:5432/psfn' },
  });

  it('resolves every companion to absolute paths anchored off the leader entry', () => {
    const options = buildFleetBackupRunOptions({ ...baseParams(), backupConfig: makeBackupConfig() });

    expect(options.companions).toHaveLength(2);
    expect(options.companions[0]).toMatchObject({
      companionId: COMPANION_A,
      postgresSchema: 'companion_alpha',
      companionDataDir: `/runtime/companion-data/${COMPANION_A}`,
      characterCardPath: `/runtime/companion-data/${COMPANION_A}/character.json`,
    });
    expect(options.companions[1].companionDataDir).toBe(`/runtime/companion-data/${COMPANION_B}`);
    // Session / journal / card-history derive from each companion's own dir.
    expect(options.companions[0].sessionsDir).toContain(`companion-data/${COMPANION_A}`);
    expect(options.companions[0].memoriesJournalPath).toContain(`companion-data/${COMPANION_A}`);
    expect(options.systemDataDir).toBe('/runtime/system-data');
    expect(options.backupRootDir).toBe('/runtime/backups');
  });

  it('selects per-companion mode (no group root) when groupMode is off', () => {
    const options = buildFleetBackupRunOptions({
      ...baseParams(),
      backupConfig: makeBackupConfig({ groupMode: false }),
    });
    expect(options.groupMode).toBe(false);
    expect(options.groupCompanionDataDir).toBeUndefined();
  });

  it('selects group mode with the common companion-data parent when groupMode is on', () => {
    const options = buildFleetBackupRunOptions({
      ...baseParams(),
      backupConfig: makeBackupConfig({ groupMode: true }),
    });
    expect(options.groupMode).toBe(true);
    expect(options.groupCompanionDataDir).toBe('/runtime/companion-data');
  });

  it('derives a restore-verify scratch db only when verifyRestore is on', () => {
    const off = buildFleetBackupRunOptions({
      ...baseParams(),
      backupConfig: makeBackupConfig({ verifyRestore: false }),
    });
    expect(off.postgres.restoreVerifyDatabaseUrl).toBeUndefined();

    const on = buildFleetBackupRunOptions({
      ...baseParams(),
      backupConfig: makeBackupConfig({ verifyRestore: true }),
    });
    expect(on.postgres.restoreVerifyDatabaseUrl).toBe(
      'postgresql://psfn:secret@127.0.0.1:5432/psfn_restore_verify',
    );
  });

  it('fails closed when this process is not in the fleet', () => {
    expect(() => buildFleetBackupRunOptions({
      ...baseParams(),
      ownCompanionId: '99999999-9999-4999-8999-999999999999',
      backupConfig: makeBackupConfig(),
    })).toThrow(/not present in the fleet manifest/);
  });
});

interface CapturedTask {
  id: string;
  handler: () => Promise<void>;
  skipFirstRun?: boolean;
}

function makeFakeScheduler(captured: CapturedTask[]): Scheduler {
  return {
    register(task: { id: string; handler: () => Promise<void> }, opts?: { skipFirstRun?: boolean }) {
      captured.push({ id: task.id, handler: task.handler, skipFirstRun: opts?.skipFirstRun });
    },
  } as unknown as Scheduler;
}

const FLEET_OPTIONS: FleetBackupRunOptions = {
  postgres: { databaseUrl: 'postgresql://psfn:secret@127.0.0.1:5432/psfn' },
  companions: [{
    companionId: COMPANION_A,
    postgresSchema: 'companion_alpha',
    companionDataDir: `/runtime/companion-data/${COMPANION_A}`,
    sessionsDir: `/runtime/companion-data/${COMPANION_A}/state/sessions`,
  }],
  systemDataDir: '/runtime/system-data',
  backupRootDir: '/runtime/backups',
};

describe('registerScheduledFleetBackupTask', () => {
  it('registers on the shared scheduled-backup lane id', () => {
    const captured: CapturedTask[] = [];
    registerScheduledFleetBackupTask({
      scheduler: makeFakeScheduler(captured),
      fleetOptions: FLEET_OPTIONS,
      config: makeBackupConfig(),
      runFleetBackup: async () => ({
        mode: 'per-companion',
        backupRootDir: '/runtime/backups',
        fleetManifestPath: '/runtime/backups/fleet-backup-manifest.json',
        overallStatus: 'success',
        units: [],
        results: [],
      }),
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].id).toBe(SCHEDULED_BACKUP_TASK_ID);
    expect(captured[0].skipFirstRun).toBe(true);
  });

  it('runs the fleet cycle on the handler and reports success without failure callback', async () => {
    const captured: CapturedTask[] = [];
    const onBackupFailure = vi.fn();
    const runFleetBackup = vi.fn(async (): Promise<FleetBackupRunResult> => ({
      mode: 'per-companion',
      backupRootDir: '/runtime/backups',
      fleetManifestPath: '/runtime/backups/fleet-backup-manifest.json',
      overallStatus: 'success',
      units: [],
      results: [],
    }));
    registerScheduledFleetBackupTask({
      scheduler: makeFakeScheduler(captured),
      fleetOptions: FLEET_OPTIONS,
      config: makeBackupConfig(),
      onBackupFailure,
      runFleetBackup,
    });

    await captured[0].handler();

    expect(runFleetBackup).toHaveBeenCalledWith(FLEET_OPTIONS);
    expect(onBackupFailure).not.toHaveBeenCalled();
  });

  it('propagates a partial fleet failure — surfaces it and never swallows', async () => {
    const captured: CapturedTask[] = [];
    const onBackupFailure = vi.fn();
    const outcomes: FleetBackupUnitOutcome[] = [
      { kind: 'companion', companionId: COMPANION_A, status: 'success' },
      { kind: 'companion', companionId: COMPANION_B, status: 'failure', error: 'tree capture failed' },
    ];
    const partial = new FleetBackupPartialFailureError(
      '/runtime/backups/fleet-backup-manifest.json',
      outcomes,
    );
    registerScheduledFleetBackupTask({
      scheduler: makeFakeScheduler(captured),
      fleetOptions: FLEET_OPTIONS,
      config: makeBackupConfig(),
      onBackupFailure,
      runFleetBackup: async () => { throw partial; },
    });

    await expect(captured[0].handler()).rejects.toBe(partial);
    expect(onBackupFailure).toHaveBeenCalledTimes(1);
    expect(onBackupFailure).toHaveBeenCalledWith(partial);
  });
});
