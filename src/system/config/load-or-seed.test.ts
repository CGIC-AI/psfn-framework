import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOrSeedJson } from './load-or-seed.js';

interface TestConfig {
  enabled: boolean;
}

function validateTestConfig(value: unknown, sourcePath: string): TestConfig {
  if (!value || typeof value !== 'object') {
    throw new Error(`Invalid object at ${sourcePath}`);
  }
  const enabled = (value as Record<string, unknown>).enabled;
  if (typeof enabled !== 'boolean') {
    throw new Error(`Missing boolean "enabled" at ${sourcePath}`);
  }
  return { enabled };
}

describe('loadOrSeedJson', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) continue;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function setupPaths(): { dataPath: string; seedPath: string } {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-load-or-seed-'));
    tempDirs.push(dir);
    return {
      dataPath: join(dir, 'runtime.json'),
      seedPath: join(dir, 'seed.json'),
    };
  }

  it('seeds data file when it does not exist', () => {
    const { dataPath, seedPath } = setupPaths();
    writeFileSync(seedPath, JSON.stringify({ enabled: true }), 'utf-8');

    const result = loadOrSeedJson({
      dataPath,
      seedPath,
      validate: validateTestConfig,
    });

    expect(result).toEqual({ enabled: true });
    expect(JSON.parse(readFileSync(dataPath, 'utf-8'))).toEqual({ enabled: true });
  });

  it('fails closed when existing data file contains invalid JSON', () => {
    const { dataPath, seedPath } = setupPaths();
    writeFileSync(seedPath, JSON.stringify({ enabled: true }), 'utf-8');
    writeFileSync(dataPath, '{"enabled":', 'utf-8');

    expect(() => loadOrSeedJson({
      dataPath,
      seedPath,
      validate: validateTestConfig,
    })).toThrow('Refusing to reseed invalid JSON config');

    expect(readFileSync(dataPath, 'utf-8')).toBe('{"enabled":');
  });

  it('fails closed when existing data file fails validation', () => {
    const { dataPath, seedPath } = setupPaths();
    writeFileSync(seedPath, JSON.stringify({ enabled: true }), 'utf-8');
    writeFileSync(dataPath, JSON.stringify({ enabled: 'yes' }), 'utf-8');

    expect(() => loadOrSeedJson({
      dataPath,
      seedPath,
      validate: validateTestConfig,
    })).toThrow('Refusing to reseed invalid JSON config');

    expect(JSON.parse(readFileSync(dataPath, 'utf-8'))).toEqual({ enabled: 'yes' });
  });
});
