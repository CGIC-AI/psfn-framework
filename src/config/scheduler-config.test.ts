import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { loadSchedulerSeedDefaults, SCHEDULER_SEED_FILE_NAME } from './scheduler-config.js';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

describe('scheduler config seed defaults', () => {
  it('reads seed defaults without requiring a data directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'scheduler-seed-defaults-'));
    const seedDir = join(root, 'seed');
    mkdirSync(seedDir, { recursive: true });

    try {
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), {
        tickIntervalMs: 60_000,
        heartbeatIntervalMs: 90_000,
        salienceDecayIntervalMs: 123_000,
      });

      expect(loadSchedulerSeedDefaults({ seedDir })).toEqual({
        tickIntervalMs: 60_000,
        heartbeatIntervalMs: 90_000,
        salienceDecayIntervalMs: 123_000,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
