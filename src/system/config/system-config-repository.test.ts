import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createOwnerFileConfigStore } from './config-store.js';

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

describe('createOwnerFileConfigStore', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (!dir) continue;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeDataDir(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir, { recursive: true });
    tempDirs.push(root);
    // Owner files must pre-exist: loading fails closed instead of copying
    // seed templates implicitly, so bootstrap them the documented way.
    for (const ownerFile of ['settings', 'models', 'providers', 'scheduler', 'capability-tier', 'trust-policy', 'charge-policy', 'backup', 'skills']) {
      copyFileSync(
        join(process.cwd(), 'config', `${ownerFile}.seed.json`),
        join(dataDir, `${ownerFile}.json`),
      );
    }
    return dataDir;
  }

  it('round-trips the system-owned owner file surfaces through one repository object', () => {
    const dataDir = makeDataDir('psfn-system-config-repository-');
    const seedDir = join(process.cwd(), 'config');
    const repo = createOwnerFileConfigStore({
      dataDir,
      seedDir,
      defaultContextWindow: 128_000,
    });

    const runtime = repo.loadRuntimeSettings();
    repo.saveRuntimeSettings(runtime);
    expect(repo.loadRuntimeSettings()).toEqual(runtime);
    expect(readJson(join(dataDir, 'settings.json'))).toEqual(runtime);

    const models = repo.loadModels();
    repo.saveModels(models.modelRegistry);
    expect(repo.loadModels()).toEqual(models);
    expect(readJson(join(dataDir, 'models.json'))).toEqual(models.modelRegistry);

    const providers = repo.loadProviders();
    repo.saveProviders(providers.registry);
    expect(repo.loadProviders()).toEqual(providers);
    expect(readJson(join(dataDir, 'providers.json'))).toEqual(providers.registry);

    const scheduler = repo.loadScheduler();
    repo.saveScheduler(scheduler);
    expect(repo.loadScheduler()).toEqual(scheduler);
    expect(readJson(join(dataDir, 'scheduler.json'))).toEqual(scheduler);

    const capabilities = repo.loadCapabilityTier();
    repo.saveCapabilityTier(capabilities);
    expect(repo.loadCapabilityTier()).toEqual(capabilities);
    expect(readJson(join(dataDir, 'capability-tier.json'))).toEqual(capabilities);

    const chargePolicy = repo.loadChargePolicy();
    repo.saveChargePolicy(chargePolicy);
    expect(repo.loadChargePolicy()).toEqual(chargePolicy);
    expect(readJson(join(dataDir, 'charge-policy.json'))).toEqual(chargePolicy);

    const backup = repo.loadBackup();
    repo.saveBackup(backup);
    expect(repo.loadBackup()).toEqual(backup);
    expect(readJson(join(dataDir, 'backup.json'))).toEqual(backup);

    const skills = repo.loadSkills();
    repo.saveSkills(skills);
    expect(repo.loadSkills()).toEqual(skills);
    expect(readJson(join(dataDir, 'skills.json'))).toEqual(skills);

    const trustPolicy = repo.loadTrustPolicy();
    repo.saveTrustPolicy(trustPolicy);
    expect(repo.loadTrustPolicy()).toEqual(trustPolicy);
    expect(readJson(join(dataDir, 'trust-policy.json'))).toEqual(trustPolicy);

    const channels = {
      discord: {
        heartbeatChannelId: 'heartbeat-123',
      },
      psfnAmica: {
        enabled: false,
      },
      telegram: {
        enabled: false,
        tokenRef: {
          kind: 'env',
          envName: 'TELEGRAM_BOT_TOKEN',
        },
        allowedUsers: [],
        mode: 'polling',
        pollIntervalMs: 1_000,
        webhook: {
          url: 'https://example.test/telegram/webhook',
          secretRef: {
            kind: 'env',
            envName: 'TELEGRAM_WEBHOOK_SECRET',
          },
          host: '0.0.0.0',
          port: 8_080,
          path: '/telegram/webhook',
        },
      },
    };
    repo.saveChannelsOwnerFile(channels);
    expect(repo.loadChannelsOwnerFile()).toEqual(channels);
    expect(readJson(join(dataDir, 'channels.json'))).toEqual(channels);
  });

  it('loads channels.json through the repository surface', () => {
    const dataDir = makeDataDir('psfn-system-config-repository-channels-');
    writeFileSync(join(dataDir, 'channels.json'), JSON.stringify({
      discord: {
        heartbeatChannelId: 'heartbeat-123',
      },
      psfnAmica: {
        enabled: false,
      },
      telegram: {
        enabled: false,
        tokenRef: {
          kind: 'env',
          envName: 'TELEGRAM_BOT_TOKEN',
        },
        allowedUsers: [],
        mode: 'polling',
        pollIntervalMs: 1_000,
        webhook: {
          url: 'https://example.test/telegram/webhook',
          secretRef: {
            kind: 'env',
            envName: 'TELEGRAM_WEBHOOK_SECRET',
          },
          host: '0.0.0.0',
          port: 8_080,
          path: '/telegram/webhook',
        },
      },
    }));

    const repo = createOwnerFileConfigStore({
      dataDir,
    });

    expect(repo.loadChannels()).toMatchObject({
      discord: {
        heartbeatChannelId: 'heartbeat-123',
      },
      telegram: {
        enabled: false,
      },
    });
    expect(existsSync(join(dataDir, 'channels.json'))).toBe(true);
  });

  it('returns the raw channels owner file without materializing credential values', () => {
    const dataDir = makeDataDir('psfn-system-config-repository-channels-owner-file-');
    const payload = {
      telegram: {
        enabled: false,
        tokenRef: {
          kind: 'env',
          envName: 'TELEGRAM_BOT_TOKEN',
        },
        allowedUsers: [],
        mode: 'polling',
        pollIntervalMs: 1_000,
        webhook: {
          url: 'https://example.test/telegram/webhook',
          secretRef: {
            kind: 'env',
            envName: 'TELEGRAM_WEBHOOK_SECRET',
          },
          host: '0.0.0.0',
          port: 8_080,
          path: '/telegram/webhook',
        },
      },
    };
    writeFileSync(join(dataDir, 'channels.json'), JSON.stringify(payload));

    const repo = createOwnerFileConfigStore({
      dataDir,
    });

    expect(repo.loadChannelsOwnerFile()).toEqual(payload);
  });

  it('exposes startup hydration loads through the same config store port', () => {
    const dataDir = makeDataDir('psfn-config-store-startup-');
    const seedDir = join(process.cwd(), 'config');
    const repo = createOwnerFileConfigStore({
      dataDir,
      seedDir,
      defaultContextWindow: 128_000,
    });

    expect(repo.loadStartupRuntimeSettings().runtimeSettings).toEqual(repo.loadRuntimeSettings());
    expect(repo.loadStartupModels().config).toEqual(repo.loadModels());
    expect(repo.loadStartupProviders().config).toEqual(repo.loadProviders());
    expect(repo.loadStartupTrustPolicy()).toEqual(repo.loadTrustPolicy());
    expect(repo.loadStartupScheduler()).toEqual(repo.loadScheduler());
    expect(repo.loadStartupCapabilityTier()).toEqual(repo.loadCapabilityTier());
    expect(repo.loadStartupChargePolicy()).toEqual(repo.loadChargePolicy());
  });
});
