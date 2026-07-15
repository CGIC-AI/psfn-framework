import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createOwnerFileConfigStore } from './config-store.js';
import {
  SCHEDULER_FILE_NAME,
  loadSchedulerSeedDefaults,
} from './scheduler-config.js';
import { verifyStartupOwnerFiles } from './startup-owner-files.js';
import {
  PER_COMPANION_OWNER_FILES,
  buildSettingsContractData,
  ownerFileScope,
} from './settings-contract.js';
import { verifySettingsContractGuard } from './settings-contract-guard.js';
import { SYSTEM_CONFIG_OWNER_FILES } from '../../persistence/backups/system-config-tree.js';

// Bead dnll.3: scheduler.json circadian config (heartbeat cadence, rest window,
// morning wake, freeTime, sleepConsolidation) is a per-companion owner file
// rooted at companionDataDir (not the shared systemDataDir), so two fleet
// companions on one release can hold distinct wake/rest schedules.

const SEED_DIR = './config';
const roots: string[] = [];

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** Write a valid scheduler.json whose morning-wake time individuates it. */
function writeSchedulerFile(dir: string, morningWakeLocalTime: string): void {
  const config = loadSchedulerSeedDefaults({ seedDir: SEED_DIR });
  config.temporalWakeup.morningWake.localTime = morningWakeLocalTime;
  writeFileSync(
    join(dir, SCHEDULER_FILE_NAME),
    JSON.stringify(config),
    'utf-8',
  );
}

afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('scheduler per-companion rooting (dnll.3)', () => {
  it('reads the scheduler config from companionDataDir, not systemDataDir', () => {
    const systemDataDir = makeDir('psfn-sched-system-');
    const companionDataDir = makeDir('psfn-sched-companion-');
    // Different wake times in each root; the store must read the companion one.
    writeSchedulerFile(systemDataDir, '06:00');
    writeSchedulerFile(companionDataDir, '09:30');

    const store = createOwnerFileConfigStore({ dataDir: systemDataDir, companionDataDir });

    expect(store.loadScheduler().temporalWakeup.morningWake.localTime).toBe('09:30');
    expect(store.loadStartupScheduler().temporalWakeup.morningWake.localTime).toBe('09:30');
  });

  it('writes the scheduler config to companionDataDir, not systemDataDir', () => {
    const systemDataDir = makeDir('psfn-sched-system-');
    const companionDataDir = makeDir('psfn-sched-companion-');
    writeSchedulerFile(companionDataDir, '09:30');

    const next = loadSchedulerSeedDefaults({ seedDir: SEED_DIR });
    next.temporalWakeup.morningWake.localTime = '05:15';

    const store = createOwnerFileConfigStore({ dataDir: systemDataDir, companionDataDir });
    store.saveScheduler(next);

    // The companion file changed; the system root never gains one.
    const reread = createOwnerFileConfigStore({ dataDir: systemDataDir, companionDataDir });
    expect(reread.loadScheduler().temporalWakeup.morningWake.localTime).toBe('05:15');
    expect(() =>
      createOwnerFileConfigStore({ dataDir: systemDataDir, companionDataDir: systemDataDir })
        .loadScheduler(),
    ).toThrow(/Missing required JSON owner file/);
  });

  it('lets two fleet companions hold different wake schedules from one shared system root', () => {
    const systemDataDir = makeDir('psfn-sched-system-');
    const companionA = makeDir('psfn-sched-companion-a-');
    const companionB = makeDir('psfn-sched-companion-b-');
    writeSchedulerFile(companionA, '07:00');
    writeSchedulerFile(companionB, '11:45');

    const storeA = createOwnerFileConfigStore({ dataDir: systemDataDir, companionDataDir: companionA });
    const storeB = createOwnerFileConfigStore({ dataDir: systemDataDir, companionDataDir: companionB });

    expect(storeA.loadScheduler().temporalWakeup.morningWake.localTime).toBe('07:00');
    expect(storeB.loadScheduler().temporalWakeup.morningWake.localTime).toBe('11:45');
  });

  it('fails closed when the per-companion scheduler file is missing even if the system root has one', () => {
    const systemDataDir = makeDir('psfn-sched-system-');
    const companionDataDir = makeDir('psfn-sched-companion-');
    // System root has a scheduler file; companion root does not.
    writeSchedulerFile(systemDataDir, '06:00');

    const store = createOwnerFileConfigStore({ dataDir: systemDataDir, companionDataDir });
    expect(() => store.loadScheduler()).toThrow(/Missing required JSON owner file/);
  });

  it('verifyStartupOwnerFiles validates scheduler at companionDataDir', () => {
    const systemDataDir = makeDir('psfn-sched-system-');
    const companionDataDir = makeDir('psfn-sched-companion-');
    // System root deliberately has an INVALID scheduler; only the companion root is valid.
    writeFileSync(join(systemDataDir, SCHEDULER_FILE_NAME), JSON.stringify({ tickIntervalMs: 'nope' }), 'utf-8');
    writeSchedulerFile(companionDataDir, '09:30');

    const result = verifyStartupOwnerFiles({
      dataDir: systemDataDir,
      companionDataDir,
      seedDir: SEED_DIR,
      multiCompanion: true,
    });
    const schedulerError = result.errors.find((e) => e.includes('scheduler'));
    // The companion scheduler file is valid; the invalid system-root file is ignored.
    expect(schedulerError).toBeUndefined();

    // And a missing companion file fails the scheduler check.
    const emptyCompanion = makeDir('psfn-sched-companion-empty-');
    const missingResult = verifyStartupOwnerFiles({
      dataDir: systemDataDir,
      companionDataDir: emptyCompanion,
      seedDir: SEED_DIR,
      multiCompanion: true,
    });
    expect(missingResult.errors.some((e) => e.includes('scheduler'))).toBe(true);
  });

  it('marks scheduler.json as a per-companion owner file in the settings contract', () => {
    expect(PER_COMPANION_OWNER_FILES.has(SCHEDULER_FILE_NAME)).toBe(true);
    expect(ownerFileScope(SCHEDULER_FILE_NAME)).toBe('perCompanion');

    const contractData = buildSettingsContractData();
    expect(contractData.subsystems.scheduler.scope).toBe('perCompanion');
    // Every subsystem's scope matches the per-companion owner-file registry.
    for (const subsystem of Object.values(contractData.subsystems)) {
      const expected = PER_COMPANION_OWNER_FILES.has(subsystem.ownerFile) ? 'perCompanion' : 'global';
      expect(subsystem.scope).toBe(expected);
    }
  });

  it('contract guard passes and enforces per-companion scheduler owner-file scope consistency', () => {
    expect(verifySettingsContractGuard()).toEqual({ ok: true, errors: [] });

    // Drift the scheduler subsystem scope back to global and the guard fails.
    const contractData = buildSettingsContractData();
    const drifted = {
      ...contractData,
      subsystems: {
        ...contractData.subsystems,
        scheduler: { ...contractData.subsystems.scheduler, scope: 'global' as const },
      },
    };
    const result = verifySettingsContractGuard({ contractData: drifted });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('scheduler.json') && e.includes('perCompanion'))).toBe(true);
  });

  it('excludes scheduler.json from the cluster-global system-config backup slice', () => {
    // The per-companion scheduler file must ride the companion-tree slice, never
    // the shared system-config slice.
    expect(SYSTEM_CONFIG_OWNER_FILES).not.toContain(SCHEDULER_FILE_NAME);
  });
});
