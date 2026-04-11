import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './load-config.js';
import { hydrateJsonBackedRuntimeConfig } from './runtime-config.js';

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

describe('hydrateJsonBackedRuntimeConfig', () => {
  it('prefers owner-file models and runtime settings over ignored env defaults', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-runtime-config-'));
    TEMP_DIRS.push(dataDir);

    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
      thinkMaxTokens: 180000,
      thinkMaxWallTimeMs: 180000,
      thinkMaxSubQueries: 12,
    }), 'utf8');
    writeFileSync(join(dataDir, 'models.json'), JSON.stringify({
      schemaVersion: 1,
      models: [
        {
          id: 'primary',
          rank: 100,
          identity: {
            provider: 'openrouter',
            model: 'google/gemini-3-flash-preview',
            source: { type: 'openrouter' },
          },
          purposes: [
            { purpose: 'chat', primary: true },
            { purpose: 'summary', primary: true },
            { purpose: 'reasoning', primary: true },
            { purpose: 'longContext', primary: true },
            { purpose: 'vision', primary: true },
            { purpose: 'moa', primary: true },
          ],
          capabilities: {
            maxOutputTokens: 12288,
            contextWindow: 1048576,
          },
          tuning: {
            maxOutputTokens: 12288,
          },
        },
        {
          id: 'extraction',
          rank: 80,
          identity: {
            provider: 'openrouter',
            model: 'deepseek/deepseek-v3.2',
            source: { type: 'openrouter' },
          },
          purposes: [
            { purpose: 'background', primary: true },
            { purpose: 'memory', primary: true },
            { purpose: 'extraction', primary: true },
            { purpose: 'import_processing', primary: true },
          ],
          capabilities: {
            maxOutputTokens: 8192,
            contextWindow: 128000,
          },
          tuning: {
            maxOutputTokens: 8192,
          },
        },
      ],
    }), 'utf8');

    process.env.DATA_DIR = dataDir;
    process.env.CONFIG_DIR = 'config';
    process.env.PRIMARY_MODEL = 'env-primary-should-be-ignored';
    process.env.THINK_MAX_TOKENS = '999999';
    process.env.THINK_MAX_WALL_TIME_MS = '999999';
    process.env.THINK_MAX_SUB_QUERIES = '99';

    const config = hydrateJsonBackedRuntimeConfig(loadConfig(), { seedDir: 'config' });

    expect(config.primaryModel).toBe('google/gemini-3-flash-preview');
    expect(config.primaryProvider).toBe('openrouter');
    expect(config.primaryMaxTokens).toBe(12288);
    expect(config.thinkMaxTokens).toBe(180000);
    expect(config.thinkMaxWallTimeMs).toBe(180000);
    expect(config.thinkMaxSubQueries).toBe(12);
  });
});
