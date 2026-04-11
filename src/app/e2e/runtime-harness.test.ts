import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createIsolatedE2ERuntime } from './runtime-harness.js';

const ORIGINAL_ENV = { ...process.env };
const TEMP_DIRS: string[] = [];

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv();
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('createIsolatedE2ERuntime', () => {
  it('boots against seeded isolated roots instead of ambient invalid DATA_DIR state', () => {
    const ambientDataDir = mkdtempSync(join(tmpdir(), 'psfn-e2e-ambient-'));
    TEMP_DIRS.push(ambientDataDir);
    writeFileSync(join(ambientDataDir, 'scheduler.json'), JSON.stringify({
      tickIntervalMs: 60_000,
      heartbeatIntervalMs: 300_000,
      salienceDecayIntervalMs: 300_000,
      artifactLifecycle: false,
    }), 'utf8');
    process.env.DATA_DIR = ambientDataDir;

    const runtime = createIsolatedE2ERuntime({
      prefix: 'psfn-e2e-harness-test-',
      seedDir: 'config',
    });

    try {
      expect(runtime.config.dataDir).toBe(runtime.systemDataDir);
      expect(runtime.systemDataDir).not.toBe(ambientDataDir);
      expect(runtime.companionDataDir).not.toBe(ambientDataDir);
      expect(existsSync(join(runtime.systemDataDir, 'scheduler.json'))).toBe(true);

      const scheduler = JSON.parse(
        readFileSync(join(runtime.systemDataDir, 'scheduler.json'), 'utf8'),
      ) as { artifactLifecycle?: unknown };
      expect(typeof scheduler.artifactLifecycle).toBe('object');
    } finally {
      runtime.cleanup();
    }
  });
});
