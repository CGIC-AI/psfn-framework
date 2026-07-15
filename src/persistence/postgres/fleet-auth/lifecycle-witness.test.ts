import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FLEET_AUTH_LIFECYCLE_WITNESS_FILE_NAME,
  FleetAuthLifecycleWitnessStore,
} from './lifecycle-witness.js';

describe('fleet auth lifecycle witness', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function store(): { root: string; witness: FleetAuthLifecycleWitnessStore } {
    const root = mkdtempSync(join(tmpdir(), 'psfn-fleet-auth-lifecycle-'));
    chmodSync(root, 0o700);
    roots.push(root);
    return { root, witness: new FleetAuthLifecycleWitnessStore(root) };
  }

  it('does not create state for a deployment that has never enabled fleet auth', () => {
    const { root, witness } = store();
    witness.recordDisabledIfPresent();
    expect(existsSync(join(root, FLEET_AUTH_LIFECYCLE_WITNESS_FILE_NAME))).toBe(false);
  });

  it('emits one stable transition for disable/re-enable and none for ordinary restart', () => {
    const { witness } = store();
    const lineage = 'a'.repeat(64);
    witness.recordEnabled(lineage, null);
    expect(witness.prepareEnable(lineage)).toBeUndefined();

    witness.recordDisabledIfPresent();
    const first = witness.prepareEnable(lineage);
    const retry = witness.prepareEnable(lineage);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(retry).toBe(first);

    witness.recordEnabled(lineage, first!);
    expect(witness.prepareEnable(lineage)).toBeUndefined();
  });
});
