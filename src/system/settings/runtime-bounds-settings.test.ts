import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSettingsForm } from './form.js';
import { applySettings, getRuntimeSettingsSnapshot } from './runtime.js';
import type { SubstrateConfig } from '../config/runtime-config-contracts.js';

// psfn-framework-bxnyu — the eight settings.json runtime bounds S12 added.
//
// Each one is resolved by a fail-closed require* helper somewhere in the
// runtime, so the seed default and the form bounds are load-bearing: a value
// the form admits but the seed does not carry, or a seed value the form would
// reject, is a boot that either refuses or silently disagrees with the Garden
// control an operator edits it through. These pin the whole owner-file → form →
// SubstrateConfig → snapshot chain for all eight, and the fail-closed
// validation on either side of every bound.

const SEED = JSON.parse(
  readFileSync(join(process.cwd(), 'config', 'settings.seed.json'), 'utf8'),
) as Record<string, unknown>;

function parse(entries: Record<string, string>) {
  return parseSettingsForm(new URLSearchParams(entries));
}

/** Operator-chosen values, all distinct from the seed so nothing passes by luck. */
const VALID = {
  healthEventStreamMaxRows: '7500',
  postgresStoreReadinessRetryAttempts: '9',
  postgresStoreReadinessRetryBackoffMs: '2500',
  custodySnapshotRetentionDays: '30',
  sharedWorkspaceListPageSize: '250',
  sharedWorkspaceListPageBytes: '4000000',
  satelliteHeartbeatStaleAfterMs: '90000',
  sessionTombstoneAuthorityOwners: '128',
} as const;

const EXPECTED = {
  healthEventStreamMaxRows: 7_500,
  postgresStoreReadinessRetryAttempts: 9,
  postgresStoreReadinessRetryBackoffMs: 2_500,
  custodySnapshotRetentionDays: 30,
  sharedWorkspaceListPageSize: 250,
  sharedWorkspaceListPageBytes: 4_000_000,
  satelliteHeartbeatStaleAfterMs: 90_000,
  sessionTombstoneAuthorityOwners: 128,
} as const;

type BoundedSettingKey = keyof typeof EXPECTED;
const BOUNDED_SETTING_KEYS = Object.keys(EXPECTED) as BoundedSettingKey[];
/**
 * The subset settings.seed.json carries, and therefore the subset the owner
 * migration and the boot-time contract adaptation can backfill.
 * `satelliteHeartbeatStaleAfterMs` is the exception: it resolves to a code
 * default when the owner file is silent, so it is asserted separately.
 */
const SEED_BACKED_SETTING_KEYS = BOUNDED_SETTING_KEYS
  .filter(key => key !== 'satelliteHeartbeatStaleAfterMs');

describe('S12 runtime bound settings — form validation (fail closed)', () => {
  it('accepts in-range values and parses them as integers', () => {
    const [settings, errors] = parse({ ...VALID });

    expect(errors).toEqual([]);
    for (const key of BOUNDED_SETTING_KEYS) {
      expect(settings[key]).toBe(EXPECTED[key]);
    }
  });

  it.each([
    ['healthEventStreamMaxRows', '99'],
    ['healthEventStreamMaxRows', '1000001'],
    // "No retry" is one attempt, so zero is not a legal budget.
    ['postgresStoreReadinessRetryAttempts', '0'],
    ['postgresStoreReadinessRetryAttempts', '21'],
    ['postgresStoreReadinessRetryBackoffMs', '99'],
    ['postgresStoreReadinessRetryBackoffMs', '60001'],
    ['custodySnapshotRetentionDays', '0'],
    ['custodySnapshotRetentionDays', '3651'],
    ['sharedWorkspaceListPageSize', '0'],
    ['sharedWorkspaceListPageSize', '10001'],
    // A page budget below the 1,000,000-byte per-artifact cap could never
    // serve one maximum-size approved artifact.
    ['sharedWorkspaceListPageBytes', '999999'],
    ['sharedWorkspaceListPageBytes', '1000000001'],
    ['satelliteHeartbeatStaleAfterMs', '4999'],
    ['satelliteHeartbeatStaleAfterMs', '3600001'],
    ['sessionTombstoneAuthorityOwners', '0'],
    ['sessionTombstoneAuthorityOwners', '100001'],
  ])('rejects out-of-range %s=%s loudly (no silent clamp)', (field, value) => {
    const [, errors] = parse({ [field]: value });
    expect(errors.some(error => error.includes(field))).toBe(true);
  });

  it('admits exactly one maximum-size approved artifact as the smallest page budget', () => {
    // The bound the form comment reasons from: MAX_ARTIFACT_BYTES in
    // shared-workspace-store.ts is 1_000_000 (1 MB, decimal — not 1 MiB), so
    // 1,000,000 is legal and anything under it is not.
    const [settings, errors] = parse({ sharedWorkspaceListPageBytes: '1000000' });

    expect(errors).toEqual([]);
    expect(settings.sharedWorkspaceListPageBytes).toBe(1_000_000);
  });
});

describe('S12 runtime bound settings — owner-file → config → snapshot wiring', () => {
  it('threads operator values into SubstrateConfig and back out through the snapshot', () => {
    const [settings, errors] = parse({ ...VALID });
    expect(errors).toEqual([]);

    const config = {} as SubstrateConfig;
    applySettings(config, settings);
    const snapshot = getRuntimeSettingsSnapshot(config);

    for (const key of BOUNDED_SETTING_KEYS) {
      expect(config[key]).toBe(EXPECTED[key]);
      expect(snapshot[key]).toBe(EXPECTED[key]);
    }
  });

  it('carries the canonical seed defaults through the same chain', () => {
    // The seed is what the owner-file migration and the boot-time contract
    // adaptation both write, so a seed value the form would reject is a fleet
    // that boots on a number its own Garden control refuses to accept back.
    const seedEntries = Object.fromEntries(
      SEED_BACKED_SETTING_KEYS.map(key => [key, String(SEED[key])]),
    );
    const [settings, errors] = parse(seedEntries);
    expect(errors).toEqual([]);

    const config = {} as SubstrateConfig;
    applySettings(config, settings);
    const snapshot = getRuntimeSettingsSnapshot(config);

    for (const key of SEED_BACKED_SETTING_KEYS) {
      expect(SEED[key]).toBeTypeOf('number');
      expect(snapshot[key]).toBe(SEED[key]);
    }
  });

  it('keeps the code-defaulted satellite staleness bound inside the form range', () => {
    // Unlike its seven siblings this one has no settings.seed.json entry: the
    // owner file may override it, but an absent key resolves to
    // DEFAULT_SATELLITE_HEARTBEAT_STALE_AFTER_MS in load-config.ts. That means
    // no migration ever backfills it, and the only way the code default and
    // the Garden control can disagree is if the default leaves the form range.
    expect(SEED.satelliteHeartbeatStaleAfterMs).toBeUndefined();
    const [settings, errors] = parse({ satelliteHeartbeatStaleAfterMs: '120000' });
    expect(errors).toEqual([]);
    expect(settings.satelliteHeartbeatStaleAfterMs).toBe(120_000);
  });
});
