import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createSystemConfigRepository } from './system-config-repository.js';

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

describe('createSystemConfigRepository', () => {
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
    return dataDir;
  }

  it('round-trips the system-owned owner file surfaces through one repository object', () => {
    const dataDir = makeDataDir('psfn-system-config-repository-');
    const seedDir = join(process.cwd(), 'config');
    const repo = createSystemConfigRepository({
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
        token: 'telegram-token',
        allowedUsers: [],
        mode: 'polling',
        pollIntervalMs: 1_000,
        webhook: {
          url: 'https://example.test/telegram/webhook',
          secret: 'webhook-secret',
          host: '0.0.0.0',
          port: 8_080,
          path: '/telegram/webhook',
        },
      },
    }));

    const repo = createSystemConfigRepository({
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
});
