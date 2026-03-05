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

  it('loads persisted config when env overrides are absent', () => {
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
      });
      writeJson(join(dataDir, 'scheduler.json'), {
        tickIntervalMs: 45_000,
        heartbeatIntervalMs: 900_000,
        salienceDecayIntervalMs: 120_000,
      });

      const resolved = resolveRuntimeSchedulerConfig({
        dataDir,
        seedDir,
        env: {},
      });

      expect(resolved).toEqual({
        tickIntervalMs: 45_000,
        heartbeatIntervalMs: 900_000,
        salienceDecayIntervalMs: 120_000,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies env overrides above persisted values', () => {
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
      });
      writeJson(join(dataDir, 'scheduler.json'), {
        tickIntervalMs: 10_000,
        heartbeatIntervalMs: 20_000,
        salienceDecayIntervalMs: 30_000,
      });

      const resolved = resolveRuntimeSchedulerConfig({
        dataDir,
        seedDir,
        env: {
          SCHEDULER_TICK_INTERVAL_MS: '4000',
          SCHEDULER_HEARTBEAT_INTERVAL_MS: '5000',
          MAINTENANCE_INTERVAL_MS: '6000',
        },
      });

      expect(resolved).toEqual({
        tickIntervalMs: 4_000,
        heartbeatIntervalMs: 5_000,
        salienceDecayIntervalMs: 6_000,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
