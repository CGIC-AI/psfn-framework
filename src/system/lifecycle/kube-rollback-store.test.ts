import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  KUBE_ROLLBACK_HISTORY_LIMIT,
  hasRolledBackFrom,
  readKubeRollbackHistory,
  readKubeRollbackLatest,
  writeKubeRollbackRecord,
  type KubeRollbackRecord,
} from './kube-rollback-store.js';

function record(overrides: Partial<KubeRollbackRecord>): KubeRollbackRecord {
  return {
    schemaVersion: 1,
    namespace: 'psfn',
    release: 'psfn',
    trigger: 'automatic',
    fromHelmRevision: 9,
    targetHelmRevision: 8,
    reason: 'post-rollout validation failed',
    validationResult: 'passed',
    outcome: 'succeeded',
    startedAt: 1,
    completedAt: 2,
    ...overrides,
  };
}

describe('kube-rollback-store', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'kube-rollback-store-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns null/[] before anything is written', () => {
    expect(readKubeRollbackLatest(dir)).toBeNull();
    expect(readKubeRollbackHistory(dir)).toEqual([]);
  });

  it('persists latest + bounded history', () => {
    writeKubeRollbackRecord(dir, record({ fromHelmRevision: 9 }));
    writeKubeRollbackRecord(dir, record({ fromHelmRevision: 10, targetHelmRevision: 9 }));
    expect(readKubeRollbackLatest(dir)?.fromHelmRevision).toBe(10);
    const history = readKubeRollbackHistory(dir);
    expect(history.map(r => r.fromHelmRevision)).toEqual([9, 10]);
  });

  it('bounds the history to the retention limit', () => {
    for (let i = 1; i <= KUBE_ROLLBACK_HISTORY_LIMIT + 5; i += 1) {
      writeKubeRollbackRecord(dir, record({ fromHelmRevision: i, targetHelmRevision: i - 1 }));
    }
    const history = readKubeRollbackHistory(dir);
    expect(history).toHaveLength(KUBE_ROLLBACK_HISTORY_LIMIT);
    // Oldest entries dropped, newest kept.
    expect(history[history.length - 1].fromHelmRevision).toBe(KUBE_ROLLBACK_HISTORY_LIMIT + 5);
  });

  it('hasRolledBackFrom matches on (release, fromHelmRevision) regardless of outcome', () => {
    const history: KubeRollbackRecord[] = [
      record({ fromHelmRevision: 9, outcome: 'failed', validationResult: 'failed' }),
      record({ release: 'other', fromHelmRevision: 5 }),
    ];
    expect(hasRolledBackFrom(history, 'psfn', 9)).toBe(true);
    expect(hasRolledBackFrom(history, 'psfn', 8)).toBe(false);
    expect(hasRolledBackFrom(history, 'other', 9)).toBe(false);
    expect(hasRolledBackFrom(history, 'other', 5)).toBe(true);
  });

  it('a manual record without fromHelmRevision does not count toward act-once', () => {
    const history: KubeRollbackRecord[] = [
      record({ trigger: 'manual', fromHelmRevision: undefined }),
    ];
    expect(hasRolledBackFrom(history, 'psfn', 9)).toBe(false);
  });
});
