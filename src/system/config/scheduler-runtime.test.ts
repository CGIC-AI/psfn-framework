import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { resolveRuntimeSchedulerConfig } from './scheduler-runtime.js';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

describe('resolveRuntimeSchedulerConfig', () => {
  it('requires object-form options with a dataDir', () => {
    expect(() => resolveRuntimeSchedulerConfig('invalid' as unknown as {
      dataDir: string;
    })).toThrow('expects an options object argument');
    expect(() => resolveRuntimeSchedulerConfig({ dataDir: '' })).toThrow('requires options.dataDir');
  });

  it('loads persisted config when runtime env overrides are absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'scheduler-runtime-config-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'seed');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });

    try {
      writeJson(join(seedDir, 'scheduler.seed.json'), {
        tickIntervalMs: 60_000,
        heartbeatIntervalMs: 1_800_000,
        salienceDecayIntervalMs: 300_000,
        artifactLifecycle: {
          scratchpadRetentionDays: 14,
          generatedMediaRetentionDays: 30,
          workspaceTempRetentionDays: 14,
          cleanupBatchSize: 128,
        },
      });
      writeJson(join(dataDir, 'scheduler.json'), {
        tickIntervalMs: 45_000,
        heartbeatIntervalMs: 900_000,
        salienceDecayIntervalMs: 120_000,
        artifactLifecycle: {
          scratchpadRetentionDays: 7,
          generatedMediaRetentionDays: 21,
          workspaceTempRetentionDays: 9,
          cleanupBatchSize: 64,
        },
      });

      const resolved = resolveRuntimeSchedulerConfig({
        dataDir,
        seedDir,
      });

      expect(resolved).toEqual({
        tickIntervalMs: 45_000,
        heartbeatIntervalMs: 900_000,
        salienceDecayIntervalMs: 120_000,
        artifactLifecycle: {
          scratchpadRetentionDays: 7,
          generatedMediaRetentionDays: 21,
          workspaceTempRetentionDays: 9,
          cleanupBatchSize: 64,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores legacy env overrides and keeps persisted scheduler values authoritative', () => {
    const root = mkdtempSync(join(tmpdir(), 'scheduler-runtime-env-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'seed');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });

    try {
      writeJson(join(seedDir, 'scheduler.seed.json'), {
        tickIntervalMs: 60_000,
        heartbeatIntervalMs: 1_800_000,
        salienceDecayIntervalMs: 300_000,
        artifactLifecycle: {
          scratchpadRetentionDays: 14,
          generatedMediaRetentionDays: 30,
          workspaceTempRetentionDays: 14,
          cleanupBatchSize: 128,
        },
      });
      writeJson(join(dataDir, 'scheduler.json'), {
        tickIntervalMs: 10_000,
        heartbeatIntervalMs: 20_000,
        salienceDecayIntervalMs: 30_000,
        artifactLifecycle: {
          scratchpadRetentionDays: 3,
          generatedMediaRetentionDays: 4,
          workspaceTempRetentionDays: 5,
          cleanupBatchSize: 6,
        },
      });

      const resolved = resolveRuntimeSchedulerConfig({
        dataDir,
        seedDir,
      });

      expect(resolved).toEqual({
        tickIntervalMs: 10_000,
        heartbeatIntervalMs: 20_000,
        salienceDecayIntervalMs: 30_000,
        artifactLifecycle: {
          scratchpadRetentionDays: 3,
          generatedMediaRetentionDays: 4,
          workspaceTempRetentionDays: 5,
          cleanupBatchSize: 6,
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
