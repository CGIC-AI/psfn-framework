import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CHARGE_POLICY_FILE_NAME, CHARGE_POLICY_SEED_FILE_NAME } from '../../shared/contracts/charge-policy.js';
import { loadChargePolicyConfig } from './charge-policy-config.js';
import { migrateChargePolicyOwner } from './charge-policy-owner-migration.js';

const SEED_DIR = resolve('config');
let companionDataDir: string | undefined;

afterEach(() => {
  if (companionDataDir) rmSync(companionDataDir, { recursive: true, force: true });
  companionDataDir = undefined;
});

function writeOwner(mutate: (regulation: Record<string, unknown>) => void): string {
  companionDataDir = mkdtempSync(join(tmpdir(), 'charge-policy-owner-migration-'));
  const seed = JSON.parse(readFileSync(join(SEED_DIR, CHARGE_POLICY_SEED_FILE_NAME), 'utf8')) as {
    fatigue: { socialRegulation: Record<string, unknown> };
    runChargeQuotaByLane: Record<string, number>;
  };
  // An owner file seeded before r5, with an operator-chosen quota.
  seed.runChargeQuotaByLane.companion_social = 12;
  mutate(seed.fatigue.socialRegulation);
  const filePath = join(companionDataDir, CHARGE_POLICY_FILE_NAME);
  writeFileSync(filePath, `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o640 });
  return filePath;
}

function socialRegulationOnDisk(filePath: string): Record<string, unknown> {
  return (JSON.parse(readFileSync(filePath, 'utf8')) as {
    fatigue: { socialRegulation: Record<string, unknown> };
  }).fatigue.socialRegulation;
}

describe('migrateChargePolicyOwner (r5 initiation pressure keys)', () => {
  it('adds only the missing keys from the seed, keeps every operator value, and is idempotent', () => {
    const filePath = writeOwner((regulation) => {
      delete regulation.mutualReplyAllowancePerSide;
      regulation.mutualReplyPressureUnits = 0.5;
    });

    expect(migrateChargePolicyOwner({ companionDataDir: companionDataDir!, seedDir: SEED_DIR, apply: false }))
      .toMatchObject({ status: 'planned', addedPaths: ['fatigue.socialRegulation.mutualReplyAllowancePerSide'] });
    expect(socialRegulationOnDisk(filePath)).not.toHaveProperty('mutualReplyAllowancePerSide');

    expect(migrateChargePolicyOwner({ companionDataDir: companionDataDir!, seedDir: SEED_DIR, apply: true }))
      .toMatchObject({ status: 'applied', addedPaths: ['fatigue.socialRegulation.mutualReplyAllowancePerSide'] });
    expect(socialRegulationOnDisk(filePath)).toMatchObject({
      mutualReplyAllowancePerSide: 8,
      mutualReplyPressureUnits: 0.5,
    });
    const loaded = loadChargePolicyConfig(companionDataDir!, { seedDir: SEED_DIR });
    expect(loaded.runChargeQuotaByLane.companion_social).toBe(12);

    expect(migrateChargePolicyOwner({ companionDataDir: companionDataDir!, seedDir: SEED_DIR, apply: true }))
      .toMatchObject({ status: 'not_needed' });
  });

  it('adds both keys to an owner file written before either existed', () => {
    const filePath = writeOwner((regulation) => {
      delete regulation.mutualReplyAllowancePerSide;
      delete regulation.mutualReplyPressureUnits;
    });
    expect(migrateChargePolicyOwner({ companionDataDir: companionDataDir!, seedDir: SEED_DIR, apply: true }))
      .toMatchObject({ status: 'applied' });
    expect(socialRegulationOnDisk(filePath)).toMatchObject({
      mutualReplyAllowancePerSide: 8,
      mutualReplyPressureUnits: 0.2,
    });
  });
});
