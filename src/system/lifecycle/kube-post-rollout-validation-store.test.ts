import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  POST_ROLLOUT_VALIDATION_HISTORY_LIMIT,
  readPostRolloutValidationLatest,
  writePostRolloutValidationVerdict,
} from './kube-post-rollout-validation-store.js';
import type { PostRolloutValidationRecord } from './kube-post-rollout-validation.js';
import {
  resolvePostRolloutValidationHistoryPath,
  resolvePostRolloutValidationLatestPath,
} from '../../persistence/layout.js';

function record(overrides: Partial<PostRolloutValidationRecord> = {}): PostRolloutValidationRecord {
  return {
    schemaVersion: 1,
    namespace: 'psfn',
    release: 'psfn',
    sourceCommit: 'a'.repeat(40),
    imageReference: 'localhost/psfn-framework:0.1.0-kube-aaaaaaaa',
    imageRevisionLabel: 'a'.repeat(40),
    helmRevision: 9,
    trigger: 'deploy_pipeline',
    startedAt: 1,
    completedAt: 2,
    overall: 'passed',
    healthy: true,
    recommendedAction: 'none',
    checks: [],
    failedChecks: [],
    ...overrides,
  };
}

describe('post-rollout validation store', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'psfn-post-rollout-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the latest verdict atomically and reads it back', () => {
    const verdict = record();
    writePostRolloutValidationVerdict(dir, verdict);
    expect(readPostRolloutValidationLatest(dir)).toEqual(verdict);
    // The latest path is the stable cross-workstream contract x5rt.8 reads.
    const onDisk = JSON.parse(readFileSync(resolvePostRolloutValidationLatestPath(dir), 'utf-8'));
    expect(onDisk.healthy).toBe(true);
  });

  it('persists both healthy and unhealthy verdicts so rollback always has a signal', () => {
    writePostRolloutValidationVerdict(dir, record({ healthy: true, overall: 'passed', recommendedAction: 'none' }));
    writePostRolloutValidationVerdict(dir, record({
      healthy: false,
      overall: 'failed',
      recommendedAction: 'rollback',
      failedChecks: ['model_route'],
    }));
    const latest = readPostRolloutValidationLatest(dir);
    expect(latest?.healthy).toBe(false);
    expect(latest?.recommendedAction).toBe('rollback');
    expect(latest?.failedChecks).toEqual(['model_route']);
  });

  it('returns null when no verdict has been written', () => {
    expect(readPostRolloutValidationLatest(dir)).toBeNull();
  });

  it('bounds the history file', () => {
    for (let i = 0; i < POST_ROLLOUT_VALIDATION_HISTORY_LIMIT + 5; i += 1) {
      writePostRolloutValidationVerdict(dir, record({ helmRevision: i + 1 }));
    }
    const lines = readFileSync(resolvePostRolloutValidationHistoryPath(dir), 'utf-8')
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(POST_ROLLOUT_VALIDATION_HISTORY_LIMIT);
    const first = JSON.parse(lines[0]) as PostRolloutValidationRecord;
    // Oldest retained entry is revision 6 (first 5 dropped).
    expect(first.helmRevision).toBe(6);
  });
});
