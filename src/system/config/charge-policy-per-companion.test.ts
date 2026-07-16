import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CHARGE_POLICY_FILE_NAME,
  loadChargePolicySeedDefaults,
  saveChargePolicyConfig,
} from './charge-policy-config.js';
import { createOwnerFileConfigStore } from './config-store.js';
import { verifyStartupOwnerFiles } from './startup-owner-files.js';
import {
  PER_COMPANION_OWNER_FILES,
  buildSettingsContractData,
  ownerFileScope,
} from './settings-contract.js';
import { verifySettingsContractGuard } from './settings-contract-guard.js';
import { SYSTEM_CONFIG_OWNER_FILES } from '../../persistence/backups/system-config-tree.js';
import { executePersistenceCutover } from '../../persistence/cutover.js';

const roots: string[] = [];

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function writeChargePolicy(
  dir: string,
  interactiveQuota: number,
  trustedCollaboratorHardCap: number,
): void {
  const policy = loadChargePolicySeedDefaults({ seedDir: './config' });
  policy.runChargeQuotaByLane.interactive = interactiveQuota;
  policy.fatigue.relationshipBudgets.trusted_collaborator_mi = {
    softTarget: Math.max(0, trustedCollaboratorHardCap - 1),
    hardCap: trustedCollaboratorHardCap,
  };
  saveChargePolicyConfig(dir, policy);
}

afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('charge policy per-companion rooting (dnll.8)', () => {
  it('reads and writes charge policy at companionDataDir', () => {
    const systemDataDir = makeDir('psfn-charge-system-');
    const companionDataDir = makeDir('psfn-charge-companion-');
    writeChargePolicy(systemDataDir, 99, 99);
    writeChargePolicy(companionDataDir, 12, 7);

    const store = createOwnerFileConfigStore({ dataDir: systemDataDir, companionDataDir });
    expect(store.loadChargePolicy().runChargeQuotaByLane.interactive).toBe(12);
    expect(store.loadStartupChargePolicy().fatigue.relationshipBudgets.trusted_collaborator_mi.hardCap)
      .toBe(7);

    const next = store.loadChargePolicy();
    next.runChargeQuotaByLane.interactive = 14;
    store.saveChargePolicy(next);
    expect(store.loadChargePolicy().runChargeQuotaByLane.interactive).toBe(14);
    expect(createOwnerFileConfigStore({ dataDir: systemDataDir }).loadChargePolicy()
      .runChargeQuotaByLane.interactive).toBe(99);
  });

  it('lets two companions hold distinct charge and fatigue budgets', () => {
    const systemDataDir = makeDir('psfn-charge-system-');
    const companionA = makeDir('psfn-charge-companion-a-');
    const companionB = makeDir('psfn-charge-companion-b-');
    writeChargePolicy(companionA, 8, 4);
    writeChargePolicy(companionB, 30, 12);

    const policyA = createOwnerFileConfigStore({ dataDir: systemDataDir, companionDataDir: companionA })
      .loadChargePolicy();
    const policyB = createOwnerFileConfigStore({ dataDir: systemDataDir, companionDataDir: companionB })
      .loadChargePolicy();
    expect(policyA.runChargeQuotaByLane.interactive).toBe(8);
    expect(policyB.runChargeQuotaByLane.interactive).toBe(30);
    expect(policyA.fatigue.relationshipBudgets.trusted_collaborator_mi.hardCap).toBe(4);
    expect(policyB.fatigue.relationshipBudgets.trusted_collaborator_mi.hardCap).toBe(12);
  });

  it('fails closed when the companion policy is missing even if the system root has one', () => {
    const systemDataDir = makeDir('psfn-charge-system-');
    const companionDataDir = makeDir('psfn-charge-companion-');
    writeChargePolicy(systemDataDir, 99, 99);

    const store = createOwnerFileConfigStore({ dataDir: systemDataDir, companionDataDir });
    expect(() => store.loadChargePolicy()).toThrow(/Missing required JSON owner file/);
  });

  it('validates the companion policy at startup and ignores a system-root decoy', () => {
    const systemDataDir = makeDir('psfn-charge-system-');
    const companionDataDir = makeDir('psfn-charge-companion-');
    writeFileSync(join(systemDataDir, CHARGE_POLICY_FILE_NAME), '{"schemaVersion":"bad"}', 'utf8');
    writeChargePolicy(companionDataDir, 12, 7);

    const result = verifyStartupOwnerFiles({
      dataDir: systemDataDir,
      companionDataDir,
      seedDir: './config',
      multiCompanion: true,
    });
    expect(result.errors.find(error => error.includes(CHARGE_POLICY_FILE_NAME))).toBeUndefined();

    const emptyCompanion = makeDir('psfn-charge-companion-empty-');
    const missing = verifyStartupOwnerFiles({
      dataDir: systemDataDir,
      companionDataDir: emptyCompanion,
      seedDir: './config',
      multiCompanion: true,
    });
    expect(missing.errors.some(error => error.includes(CHARGE_POLICY_FILE_NAME))).toBe(true);
  });

  it('marks charge policy per-companion and excludes it from the system backup slice', () => {
    expect(PER_COMPANION_OWNER_FILES.has(CHARGE_POLICY_FILE_NAME)).toBe(true);
    expect(ownerFileScope(CHARGE_POLICY_FILE_NAME)).toBe('perCompanion');
    expect(buildSettingsContractData().subsystems.chargePolicy.scope).toBe('perCompanion');
    expect(SYSTEM_CONFIG_OWNER_FILES).not.toContain(CHARGE_POLICY_FILE_NAME);
    expect(verifySettingsContractGuard()).toEqual({ ok: true, errors: [] });
  });

  it('routes legacy charge policy through the registry-driven cutover', () => {
    const root = makeDir('psfn-charge-cutover-');
    const legacySharedDataDir = join(root, 'legacy');
    const systemDataDir = join(root, 'system');
    const companionDataDir = join(root, 'companion');
    writeChargePolicy(legacySharedDataDir, 12, 7);

    executePersistenceCutover({
      systemDataDir,
      companionDataDir,
      legacySharedDataDir,
      legacyCompanionDir: join(root, 'legacy-companion'),
    });

    expect(existsSync(join(companionDataDir, CHARGE_POLICY_FILE_NAME))).toBe(true);
    expect(existsSync(join(systemDataDir, CHARGE_POLICY_FILE_NAME))).toBe(false);
  });
});
