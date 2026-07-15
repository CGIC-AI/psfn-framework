import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CAPABILITY_TIER_FILE_NAME,
} from './capability-tier-config.js';
import { createOwnerFileConfigStore } from './config-store.js';
import { verifyStartupOwnerFiles } from './startup-owner-files.js';
import {
  PER_COMPANION_OWNER_FILES,
  buildSettingsContractData,
  ownerFileScope,
} from './settings-contract.js';
import { verifySettingsContractGuard } from './settings-contract-guard.js';
import { SYSTEM_CONFIG_OWNER_FILES } from '../../persistence/backups/system-config-tree.js';

// Bead dnll.2: capability-tier.json is a per-companion owner file rooted at
// companionDataDir (not the shared systemDataDir), so two fleet companions on
// one release can hold distinct maturation tiers.

const roots: string[] = [];

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function writeTierFile(dir: string, tier: string): void {
  writeFileSync(
    join(dir, CAPABILITY_TIER_FILE_NAME),
    JSON.stringify({ tier, customTokens: [] }),
    'utf-8',
  );
}

afterEach(() => {
  while (roots.length > 0) {
    const dir = roots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('capability-tier per-companion rooting (dnll.2)', () => {
  it('reads the capability tier from companionDataDir, not systemDataDir', () => {
    const systemDataDir = makeDir('psfn-cap-system-');
    const companionDataDir = makeDir('psfn-cap-companion-');
    // Different tiers in each root; the store must read the companion one.
    writeTierFile(systemDataDir, 'autonomous');
    writeTierFile(companionDataDir, 'nursery');

    const store = createOwnerFileConfigStore({ dataDir: systemDataDir, companionDataDir });

    expect(store.loadCapabilityTier().tier).toBe('nursery');
    expect(store.loadStartupCapabilityTier().tier).toBe('nursery');
  });

  it('writes the capability tier to companionDataDir, not systemDataDir', () => {
    const systemDataDir = makeDir('psfn-cap-system-');
    const companionDataDir = makeDir('psfn-cap-companion-');
    writeTierFile(companionDataDir, 'nursery');

    const store = createOwnerFileConfigStore({ dataDir: systemDataDir, companionDataDir });
    store.saveCapabilityTier({ tier: 'apprentice', customTokens: [] });

    // The companion file changed; the system root never gains one.
    const reread = createOwnerFileConfigStore({ dataDir: systemDataDir, companionDataDir });
    expect(reread.loadCapabilityTier().tier).toBe('apprentice');
    expect(() =>
      createOwnerFileConfigStore({ dataDir: systemDataDir, companionDataDir: systemDataDir })
        .loadCapabilityTier(),
    ).toThrow(/Missing required JSON owner file/);
  });

  it('lets two fleet companions hold different tiers from one shared system root', () => {
    const systemDataDir = makeDir('psfn-cap-system-');
    const companionA = makeDir('psfn-cap-companion-a-');
    const companionB = makeDir('psfn-cap-companion-b-');
    writeTierFile(companionA, 'nursery');
    writeTierFile(companionB, 'autonomous');

    const storeA = createOwnerFileConfigStore({ dataDir: systemDataDir, companionDataDir: companionA });
    const storeB = createOwnerFileConfigStore({ dataDir: systemDataDir, companionDataDir: companionB });

    expect(storeA.loadCapabilityTier().tier).toBe('nursery');
    expect(storeB.loadCapabilityTier().tier).toBe('autonomous');
  });

  it('fails closed when the per-companion tier file is missing even if the system root has one', () => {
    const systemDataDir = makeDir('psfn-cap-system-');
    const companionDataDir = makeDir('psfn-cap-companion-');
    // System root has a tier file; companion root does not.
    writeTierFile(systemDataDir, 'autonomous');

    const store = createOwnerFileConfigStore({ dataDir: systemDataDir, companionDataDir });
    expect(() => store.loadCapabilityTier()).toThrow(/Missing required JSON owner file/);
  });

  it('verifyStartupOwnerFiles validates capability-tier at companionDataDir', () => {
    const systemDataDir = makeDir('psfn-cap-system-');
    const companionDataDir = makeDir('psfn-cap-companion-');
    // System root deliberately has an INVALID tier; only the companion root is valid.
    writeFileSync(join(systemDataDir, CAPABILITY_TIER_FILE_NAME), JSON.stringify({ tier: 'not-a-tier' }), 'utf-8');
    writeTierFile(companionDataDir, 'nursery');

    const result = verifyStartupOwnerFiles({
      dataDir: systemDataDir,
      companionDataDir,
      seedDir: './config',
      multiCompanion: true,
    });
    const capabilityError = result.errors.find((e) => e.includes('capability-tier'));
    // The companion tier file is valid; the invalid system-root file is ignored.
    expect(capabilityError).toBeUndefined();

    // And a missing companion file fails the capability-tier check.
    const emptyCompanion = makeDir('psfn-cap-companion-empty-');
    const missingResult = verifyStartupOwnerFiles({
      dataDir: systemDataDir,
      companionDataDir: emptyCompanion,
      seedDir: './config',
      multiCompanion: true,
    });
    expect(missingResult.errors.some((e) => e.includes('capability-tier'))).toBe(true);
  });

  it('marks capability-tier.json as a per-companion owner file in the settings contract', () => {
    expect(PER_COMPANION_OWNER_FILES.has(CAPABILITY_TIER_FILE_NAME)).toBe(true);
    expect(ownerFileScope(CAPABILITY_TIER_FILE_NAME)).toBe('perCompanion');

    const contractData = buildSettingsContractData();
    expect(contractData.subsystems.capabilities.scope).toBe('perCompanion');
    // Every other subsystem remains cluster-global.
    for (const [id, subsystem] of Object.entries(contractData.subsystems)) {
      if (id === 'capabilities') continue;
      expect(subsystem.scope).toBe('global');
    }
  });

  it('contract guard passes and enforces per-companion owner-file scope consistency', () => {
    expect(verifySettingsContractGuard()).toEqual({ ok: true, errors: [] });

    // Drift the capabilities subsystem scope back to global and the guard fails.
    const contractData = buildSettingsContractData();
    const drifted = {
      ...contractData,
      subsystems: {
        ...contractData.subsystems,
        capabilities: { ...contractData.subsystems.capabilities, scope: 'global' as const },
      },
    };
    const result = verifySettingsContractGuard({ contractData: drifted });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('capability-tier.json') && e.includes('perCompanion'))).toBe(true);
  });

  it('excludes capability-tier.json from the cluster-global system-config backup slice', () => {
    // The per-companion tier file must ride the companion-tree slice, never the
    // shared system-config slice.
    expect(SYSTEM_CONFIG_OWNER_FILES).not.toContain(CAPABILITY_TIER_FILE_NAME);
  });
});
