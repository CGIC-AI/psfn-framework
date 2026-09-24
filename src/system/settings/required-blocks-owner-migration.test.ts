import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SETTINGS_FILE_NAME } from './contracts.js';
import { loadSettings } from './io.js';
import { canonicalOwnerFileMode } from '../config/owner-file-modes.js';
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

  it('removes retired local-crawler keys, reports only booleans, and stays idempotent (xvtc1)', () => {
    const { dataDir, filePath } = prepare({
      sessionHistoryBudgetPct: 9,
      webFetchAllowInternalNetwork: false,
      webFetchLocalCrawlerEnabled: true,
      webFetchLocalCrawlerAllowHttp: true,
      webFetchLocalCrawlerHostAllowlist: ['comfyui.internal.example'],
    });
    chmodSync(filePath, 0o640);
    const before = readFileSync(filePath, 'utf8');
    // Startup keeps failing closed until the migration actually runs.
    expect(() => loadSettings(dataDir)).toThrow(/retired local-crawler web-fetch keys/);

    const planned = migrateRequiredSettingsBlocks({ dataDir });
    expect(planned).toMatchObject({
      mode: 'dry-run',
      status: 'planned',
      removedPaths: [
        'webFetchLocalCrawlerEnabled',
        'webFetchLocalCrawlerAllowHttp',
        'webFetchLocalCrawlerHostAllowlist',
      ],
      retiredLocalCrawler: {
        webFetchLocalCrawlerEnabled: true,
        webFetchAllowInternalNetwork: false,
      },
    });
    // Key names and booleans only: no retired or unrelated setting value leaks.
    expect(JSON.stringify(planned)).not.toContain('comfyui.internal.example');
    expect(readFileSync(filePath, 'utf8')).toBe(before);
    expect(() => loadSettings(dataDir)).toThrow(/retired local-crawler web-fetch keys/);

    expect(migrateRequiredSettingsBlocks({ dataDir, apply: true })).toMatchObject({
      mode: 'apply',
      status: 'applied',
      removedPaths: expect.arrayContaining(['webFetchLocalCrawlerEnabled']),
      retiredLocalCrawler: { webFetchLocalCrawlerEnabled: true },
    });
    const migrated = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    for (const key of Object.keys(migrated)) expect(key).not.toMatch(/^webFetchLocalCrawler/);
    expect(migrated.sessionHistoryBudgetPct).toBe(9);
    expect(migrated.webFetchAllowInternalNetwork).toBe(false);
    expect(statSync(filePath).mode & 0o777)
      .toBe(canonicalOwnerFileMode({ ownerFileName: SETTINGS_FILE_NAME, scope: 'system' }));
    expect(() => loadSettings(dataDir)).not.toThrow();

    const bytes = readFileSync(filePath, 'utf8');
    const settled = migrateRequiredSettingsBlocks({ dataDir, apply: true });
    expect(settled).toMatchObject({ status: 'not_needed' });
    expect(settled).not.toHaveProperty('removedPaths');
    expect(settled).not.toHaveProperty('retiredLocalCrawler');
    expect(readFileSync(filePath, 'utf8')).toBe(bytes);
  });

  it('reports a disabled retired crawler lane without inventing an enabled one', () => {
    const { dataDir } = prepare({ webFetchLocalCrawlerAllowHttp: false });
    expect(migrateRequiredSettingsBlocks({ dataDir })).toMatchObject({
      removedPaths: ['webFetchLocalCrawlerAllowHttp'],
      retiredLocalCrawler: {
        webFetchLocalCrawlerEnabled: false,
        webFetchAllowInternalNetwork: false,
      },
    });
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

  it('upgrades the legacy EmoSim proactivity block while preserving its policy thresholds', () => {
    const { dataDir, filePath } = prepare({
      emosimProactivity: {
        enabled: false,
        thresholdProfile: {
          profileId: 'emosim-would-message-v1',
          socialNeedThreshold: 0.73,
          attachmentIntensityThreshold: 0.52,
          sustainMs: 1_900_000,
          cooldownMs: 22_000_000,
        },
      },
    });
    const result = migrateRequiredSettingsBlocks({ dataDir, apply: true });
    expect(result).toMatchObject({
      status: 'applied',
      updatedPaths: ['emosimProactivity'],
    });
    const migrated = JSON.parse(readFileSync(filePath, 'utf8')) as {
      emosimProactivity: {
        mode: string;
        enabled?: boolean;
        thresholdProfile: Record<string, unknown>;
      };
    };
    expect(migrated.emosimProactivity.enabled).toBeUndefined();
    expect(migrated.emosimProactivity.mode).toBe('off');
    expect(migrated.emosimProactivity.thresholdProfile).toMatchObject({
      schemaVersion: 1,
      profileId: 'emosim-would-message-v1',
      revision: 'legacy-owner-upgrade.v1',
      applicableSource: {
        model: 'emo_sim',
        version: 'emo_sim/server.py#http-api.v1',
      },
      socialNeedThreshold: 0.73,
      attachmentIntensityThreshold: 0.52,
      sustainMs: 1_900_000,
      cooldownMs: 22_000_000,
    });
    expect(migrateRequiredSettingsBlocks({ dataDir, apply: true })).toMatchObject({
      status: 'not_needed',
    });
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
