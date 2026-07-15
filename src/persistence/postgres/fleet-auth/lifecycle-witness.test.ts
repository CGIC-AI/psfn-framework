import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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
    witness.publishEnabled(witness.prepareEnable(), lineage, null);
    expect(witness.prepareEnable(lineage).lifecycleTransitionId).toBeUndefined();

    witness.recordDisabledIfPresent();
    const first = witness.prepareEnable(lineage);
    const retry = witness.prepareEnable(lineage);
    expect(first.lifecycleTransitionId).toMatch(/^[0-9a-f]{64}$/);
    expect(retry.lifecycleTransitionId).toBe(first.lifecycleTransitionId);

    witness.publishEnabled(first, lineage, first.lifecycleTransitionId ?? null);
    expect(witness.prepareEnable(lineage).lifecycleTransitionId).toBeUndefined();
  });

  it('refuses a stale enabled publish after another replica records disabled', () => {
    const { root, witness: replicaA } = store();
    const replicaB = new FleetAuthLifecycleWitnessStore(root);
    const lineage = 'b'.repeat(64);
    const initial = replicaA.prepareEnable();
    replicaA.publishEnabled(initial, lineage, null);

    const stalePreparation = replicaA.prepareEnable(lineage);
    replicaB.recordDisabledIfPresent();

    expect(() => replicaA.publishEnabled(stalePreparation, lineage, null))
      .toThrow(/lifecycle witness changed during enabled startup/i);

    const retry = replicaB.prepareEnable(lineage);
    expect(retry.lifecycleTransitionId).toMatch(/^[0-9a-f]{64}$/);
    replicaB.publishEnabled(retry, lineage, retry.lifecycleTransitionId ?? null);
    expect(replicaA.prepareEnable(lineage).lifecycleTransitionId).toBeUndefined();
  });

  it('converges simultaneous ordinary restarts and one shared re-enable transition', () => {
    const { root, witness: replicaA } = store();
    const replicaB = new FleetAuthLifecycleWitnessStore(root);
    const lineage = 'c'.repeat(64);
    const initialA = replicaA.prepareEnable();
    const initialB = replicaB.prepareEnable();
    replicaA.publishEnabled(initialA, lineage, null);
    expect(() => replicaB.publishEnabled(initialB, lineage, null)).not.toThrow();

    const restartA = replicaA.prepareEnable(lineage);
    const restartB = replicaB.prepareEnable(lineage);
    replicaA.publishEnabled(restartA, lineage, null);
    expect(() => replicaB.publishEnabled(restartB, lineage, null)).not.toThrow();

    replicaA.recordDisabledIfPresent();
    const disabledA = replicaA.prepareEnable(lineage);
    replicaB.recordDisabledIfPresent();
    const disabledB = replicaB.prepareEnable(lineage);
    expect(disabledB.lifecycleTransitionId).toBe(disabledA.lifecycleTransitionId);
    replicaA.publishEnabled(disabledA, lineage, disabledA.lifecycleTransitionId ?? null);
    expect(() => replicaB.publishEnabled(
      disabledB,
      lineage,
      disabledB.lifecycleTransitionId ?? null,
    )).not.toThrow();
    expect(replicaA.prepareEnable(lineage).lifecycleTransitionId).toBeUndefined();
  });

  it('reserves one recovery transition when replicas find a floor without a witness', () => {
    const { root, witness: replicaA } = store();
    const replicaB = new FleetAuthLifecycleWitnessStore(root);
    const lineage = 'f'.repeat(64);

    const recoveryA = replicaA.prepareEnable(lineage);
    const recoveryB = replicaB.prepareEnable(lineage);

    expect(recoveryA).toMatchObject({
      observedRevision: 1,
      observedPhase: 'disabled',
      observedAuthorityLineageId: lineage,
    });
    expect(recoveryA.lifecycleTransitionId).toMatch(/^[0-9a-f]{64}$/);
    expect(recoveryB).toEqual(recoveryA);

    replicaA.publishEnabled(
      recoveryA,
      lineage,
      recoveryA.lifecycleTransitionId ?? null,
    );
    expect(() => replicaB.publishEnabled(
      recoveryB,
      lineage,
      recoveryB.lifecycleTransitionId ?? null,
    )).not.toThrow();
    expect(replicaA.prepareEnable(lineage).lifecycleTransitionId).toBeUndefined();
  });

  it('keeps never-enabled feature-off state-free even when its root is read-only', () => {
    const { root, witness } = store();
    chmodSync(root, 0o500);
    try {
      expect(() => witness.recordDisabledIfPresent()).not.toThrow();
      expect(readdirSync(root)).toEqual([]);
    } finally {
      chmodSync(root, 0o700);
    }
  });

  it('fails closed when an existing witness has no floor or the wrong lineage', () => {
    const { witness } = store();
    const lineage = 'd'.repeat(64);
    witness.publishEnabled(witness.prepareEnable(), lineage, null);

    expect(() => witness.prepareEnable()).toThrow(/witness exists.*floor is missing/i);
    expect(() => witness.prepareEnable('e'.repeat(64))).toThrow(/lineage does not match/i);
  });
});
