import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveSettings } from '../settings.js';
import { loadModelsConfig, saveModelsConfig } from './models-config.js';
import { loadProvidersConfig, saveProvidersConfig } from './providers-config.js';
import { loadTrustPolicyConfig, saveTrustPolicyConfig } from './trust-policy-config.js';
import { saveSchedulerConfig } from './scheduler-config.js';
import { loadCapabilityTierConfig, saveCapabilityTierConfig } from './capability-tier-config.js';
import { saveChargePolicyConfig } from './charge-policy-config.js';
import {
  loadStartupCapabilityTierOwnerFile,
  loadStartupChargePolicyOwnerFile,
  loadStartupModelsOwnerFile,
  loadStartupProvidersOwnerFile,
  loadStartupRuntimeSettingsOwnerFile,
  loadStartupTrustPolicyOwnerFile,
  loadStartupSchedulerOwnerFile,
  verifyStartupOwnerFiles,
} from './startup-owner-files.js';

describe('startup owner-file loaders', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads the explicit startup owner-file bundle without collapsing ownership boundaries', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-owner-files-'));
    const seedDir = join(process.cwd(), 'config');
    mkdirSync(rootDir, { recursive: true });
    tempDirs.push(rootDir);

    saveSettings(rootDir, {
      sessionHistoryBudgetPct: 41,
      memoryRetrievalBudgetPct: 12,
    });

    const models = loadModelsConfig(rootDir, { defaultContextWindow: 128_000 });
    saveModelsConfig(rootDir, models.modelRegistry, { defaultContextWindow: 128_000 });

    const providers = loadProvidersConfig(rootDir);
    saveProvidersConfig(rootDir, providers.registry);

    const trustPolicy = loadTrustPolicyConfig(rootDir);
    saveTrustPolicyConfig(rootDir, trustPolicy);

    const scheduler = {
      tickIntervalMs: 2_000,
      heartbeatIntervalMs: 8_000,
      salienceDecayIntervalMs: 123_000,
      artifactLifecycle: {
        scratchpadRetentionDays: 7,
        generatedMediaRetentionDays: 30,
        workspaceTempRetentionDays: 3,
        cleanupBatchSize: 50,
      },
    };
    saveSchedulerConfig(rootDir, scheduler);

    const capabilityTier = loadCapabilityTierConfig(rootDir);
    saveCapabilityTierConfig(rootDir, capabilityTier);
    const chargePolicy = saveChargePolicyConfig(rootDir, {
      schemaVersion: 1,
      runChargeQuotaByLane: {
        interactive: 18,
        background: 6,
        maintenance: 0,
        subagent: 4,
        shard: 10,
      },
      surfaceCosts: {
        ownerFileInspection: 0,
        localFilesystem: 0,
        memoryRead: 0,
        memoryWrite: 0,
        localEmbedding: 0,
        externalEmbedding: 0,
        localImageGeneration: 0,
        paidImageGeneration: 5,
        thinkExtensionBand: 1,
        subagentLaunch: 1,
        shardLaunch: 7,
        externalModelConsult: 1,
        moaRoundBase: 1,
      },
      moa: {
        perRoundMultiplierByReferenceModelClass: {
          local: 1,
          subscription: 1,
          cheap_cloud: 1,
          premium_cloud: 2,
        },
      },
      referenceModelClassPricing: {
        local: 0,
        subscription: 0,
        cheap_cloud: 1,
        premium_cloud: 3,
      },
    });

    const runtimeSettings = loadStartupRuntimeSettingsOwnerFile({
      dataDir: rootDir,
      seedDir,
    });
    const modelsLoadResult = loadStartupModelsOwnerFile({
      dataDir: rootDir,
      seedDir,
      defaultContextWindow: 128_000,
      legacySettings: runtimeSettings.settingsDomains.models,
    });
    const providersLoadResult = loadStartupProvidersOwnerFile({
      dataDir: rootDir,
      seedDir,
      legacyLiteLLMBaseUrl: 'http://127.0.0.1:4999/v1',
      legacyOpenRouterModelsApiUrl: 'https://legacy.example.test/openrouter-models',
    });
    const trustPolicyConfig = loadStartupTrustPolicyOwnerFile(rootDir, seedDir);

    expect(runtimeSettings.runtimeSettings.sessionHistoryBudgetPct).toBe(41);
    expect(runtimeSettings.runtimeSettings.memoryRetrievalBudgetPct).toBe(12);
    expect(modelsLoadResult.config.modelRegistry).toEqual(models.modelRegistry);
    expect(providersLoadResult.config.registry).toEqual(providers.registry);
    expect(trustPolicyConfig).toEqual(trustPolicy);
    expect(loadStartupSchedulerOwnerFile(rootDir, seedDir)).toEqual(scheduler);
    expect(loadStartupCapabilityTierOwnerFile(rootDir, seedDir)).toEqual(capabilityTier);
    expect(loadStartupChargePolicyOwnerFile(rootDir, seedDir)).toEqual(chargePolicy);
  });

  it('reports stale scheduler drift before split startup begins', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-owner-files-drift-'));
    const seedDir = join(process.cwd(), 'config');
    mkdirSync(rootDir, { recursive: true });
    tempDirs.push(rootDir);

    writeFileSync(
      join(rootDir, 'scheduler.json'),
      `${JSON.stringify({
        tickIntervalMs: 2_000,
        heartbeatIntervalMs: 8_000,
        salienceDecayIntervalMs: 123_000,
      }, null, 2)}\n`,
      'utf-8',
    );

    const result = verifyStartupOwnerFiles({
      dataDir: rootDir,
      seedDir,
      defaultContextWindow: 128_000,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('scheduler.json');
    expect(result.errors[0]).toContain('artifactLifecycle must be an object');
    expect(result.errors[0]).toContain('Remove or repair it so it can be reseeded');
  });

  it('fails closed when charge-policy.json drifts from the canonical schema', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-owner-files-charge-drift-'));
    const seedDir = join(process.cwd(), 'config');
    mkdirSync(rootDir, { recursive: true });
    tempDirs.push(rootDir);

    writeFileSync(
      join(rootDir, 'charge-policy.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        runChargeQuotaByLane: {
          interactive: 24,
          background: 8,
          maintenance: 0,
          subagent: 6,
          shard: 12,
        },
        surfaceCosts: {
          ownerFileInspection: 0,
        },
        moa: {
          perRoundMultiplierByReferenceModelClass: {
            local: 1,
            subscription: 1,
            cheap_cloud: 1,
            premium_cloud: 2,
          },
        },
        referenceModelClassPricing: {
          local: 0,
          subscription: 0,
          cheap_cloud: 1,
          premium_cloud: 4,
        },
      }, null, 2)}\n`,
      'utf-8',
    );

    const result = verifyStartupOwnerFiles({
      dataDir: rootDir,
      seedDir,
      defaultContextWindow: 128_000,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('charge-policy.json');
    expect(result.errors[0]).toContain('surfaceCosts.localFilesystem must be a finite number >= 0');
  });
});
