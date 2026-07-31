import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SETTINGS_FILE_NAME } from './contracts.js';
import {
  DEFAULT_LIFECYCLE_KUBERNETES_SETTINGS,
  DEFAULT_WIKI_STARTUP_HYDRATION_SETTINGS,
  migrateRequiredSettingsBlocks,
} from './required-blocks-owner-migration.js';

let root: string | null = null;

function prepare(settings: Record<string, unknown>): { dataDir: string; filePath: string } {
  root = mkdtempSync(join(tmpdir(), 'required-settings-migration-'));
  const filePath = join(root, SETTINGS_FILE_NAME);
  writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`);
  return { dataDir: root, filePath };
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

describe('migrateRequiredSettingsBlocks', () => {
  it('keeps migration defaults equal to the canonical seed blocks', () => {
    const seed = JSON.parse(readFileSync('config/settings.seed.json', 'utf8')) as Record<string, unknown>;
    expect(DEFAULT_WIKI_STARTUP_HYDRATION_SETTINGS).toEqual(seed.wikiStartupHydration);
    expect(DEFAULT_LIFECYCLE_KUBERNETES_SETTINGS).toEqual(seed.lifecycleKubernetes);
  });

  it('plans without writing, then atomically applies and remains idempotent', () => {
    const { dataDir, filePath } = prepare({ sessionHistoryBudgetPct: 9 });
    const before = readFileSync(filePath, 'utf8');
    expect(migrateRequiredSettingsBlocks({ dataDir })).toMatchObject({
      mode: 'dry-run',
      status: 'planned',
      addedPaths: expect.arrayContaining([
        'fsReadMaxBytes',
        'wikiStartupHydration',
        'lifecycleKubernetes',
      ]),
    });
    expect(readFileSync(filePath, 'utf8')).toBe(before);
    expect(migrateRequiredSettingsBlocks({ dataDir, apply: true })).toMatchObject({
      status: 'applied',
    });
    const migrated = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect(migrated.sessionHistoryBudgetPct).toBe(9);
    expect(migrated.wikiStartupHydration).toEqual(DEFAULT_WIKI_STARTUP_HYDRATION_SETTINGS);
    expect(migrated.lifecycleKubernetes).toEqual(DEFAULT_LIFECYCLE_KUBERNETES_SETTINGS);
    expect(migrated.fsReadMaxBytes).toBe(100_000);
    const bytes = readFileSync(filePath, 'utf8');
    const inode = statSync(filePath).ino;
    expect(migrateRequiredSettingsBlocks({ dataDir, apply: true })).toMatchObject({
      status: 'not_needed',
    });
    expect(readFileSync(filePath, 'utf8')).toBe(bytes);
    expect(statSync(filePath).ino).toBe(inode);
  });

  it('preserves a present block while adding only the absent block', () => {
    const customWiki = { recentSessionLimit: 7, recentMessageLimit: 22, maxContextChars: 7_000 };
    const { dataDir, filePath } = prepare({ wikiStartupHydration: customWiki });
    const result = migrateRequiredSettingsBlocks({ dataDir, apply: true });
    expect(result).toMatchObject({
      addedPaths: expect.arrayContaining(['lifecycleKubernetes', 'fsReadMaxBytes']),
    });
    expect(result.addedPaths).not.toContain('wikiStartupHydration');
    const migrated = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect(migrated.wikiStartupHydration).toEqual(customWiki);
  });

  it('fails closed on a malformed present block', () => {
    const { dataDir, filePath } = prepare({ wikiStartupHydration: null });
    const before = readFileSync(filePath, 'utf8');
    expect(() => migrateRequiredSettingsBlocks({ dataDir, apply: true })).toThrow(
      /wikiStartupHydration: expected object/,
    );
    expect(readFileSync(filePath, 'utf8')).toBe(before);
  });

  it('refuses a concurrent owner change before publish', () => {
    const { dataDir, filePath } = prepare({ sessionHistoryBudgetPct: 9 });
    expect(() => migrateRequiredSettingsBlocks({
      dataDir,
      apply: true,
      faultInjection: (stage) => {
        if (stage === 'after_file_sync') writeFileSync(filePath, '{"replacement":true}\n');
      },
    })).toThrow(/changed (identity|while migration was prepared)/);
    expect(readFileSync(filePath, 'utf8')).toBe('{"replacement":true}\n');
  });
});
