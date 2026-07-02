import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveSettings } from '../settings.js';
import { loadModelsConfig, saveModelsConfig } from './models-config.js';
import { loadProvidersConfig, saveProvidersConfig } from './providers-config.js';
import { loadTrustPolicyConfig, saveTrustPolicyConfig } from './trust-policy-config.js';
import { saveSchedulerConfig } from './scheduler-config.js';
import { loadCapabilityTierConfig, saveCapabilityTierConfig } from './capability-tier-config.js';
import { saveChargePolicyConfig } from './charge-policy-config.js';
import { makeTestFatiguePolicyConfig } from '../../test-support/charge-policy.js';
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
  const requiredExampleOwnerFiles = [
    'settings.json',
    'models.json',
    'providers.json',
    'trust-policy.json',
    'scheduler.json',
    'capability-tier.json',
    'charge-policy.json',
    'backup.json',
    'skills.json',
  ] as const;

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function copyOwnerExample(rootDir: string, ownerFile: typeof requiredExampleOwnerFiles[number]): void {
    const exampleFile = ownerFile.replace(/\.json$/, '.seed.json');
    writeFileSync(
      join(rootDir, ownerFile),
      readFileSync(join(process.cwd(), 'config', exampleFile), 'utf8'),
      'utf-8',
    );
  }

  function writeRequiredOwnerExamples(
    rootDir: string,
    except: Array<typeof requiredExampleOwnerFiles[number]> = [],
  ): void {
    const skipped = new Set<string>(except);
    for (const ownerFile of requiredExampleOwnerFiles) {
      if (!skipped.has(ownerFile)) {
        copyOwnerExample(rootDir, ownerFile);
      }
    }
  }

  it('loads the explicit startup owner-file bundle without collapsing ownership boundaries', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-owner-files-'));
    const seedDir = join(process.cwd(), 'config');
    mkdirSync(rootDir, { recursive: true });
    tempDirs.push(rootDir);
    writeRequiredOwnerExamples(rootDir, [
      'settings.json',
      'scheduler.json',
      'charge-policy.json',
    ]);

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
      episodicProcessing: {
        enabled: true,
        startLocalTime: '00:00',
        endLocalTime: '09:00',
        timeZone: 'local',
        inactivityThresholdMinutes: 60,
      },
      nearTurnMemory: {
        direct: { cadenceTurns: 3 },
        group: { minIntervalMinutes: 15, minNewEntries: 8 },
      },
      orientationRewrite: {
        minNewEntriesSinceRewrite: 4,
        refreshAfterQuietDays: 7,
      },
      episodeSynthesis: {
        timerIntervalMinutes: 30,
        turnThreshold: 24,
        minRelevantTurns: 10,
        transcriptMessageLimit: 96,
        maxEpisodesPerRun: 6,
        gapSplitMinutes: 45,
        maxEntriesPerEpisode: 14,
        minConversationalEntries: 2,
        minSingleEntryChars: 120,
        topicSegmentationEnabled: false,
      },
      sleepConsolidation: {
        reviewWindowDays: 60,
        refinementWindowHours: 36,
        adjacencyGapMinutes: 45,
        maxRefinementsPerRun: 8,
        maxConsolidationsPerRun: 6,
      },
      arcFormation: {
        passIntervalDays: 6,
        reviewWindowDays: 30,
        minConfidence: 0.5,
        maxArcsPerRun: 12,
        maxEpisodesPerRun: 60,
      },
      socialGraphBuilder: {
        intervalMs: 1_800_000,
        coPresenceMinSessions: 3,
        coPresenceWindowMinutes: 1440,
        scanMemoryLimit: 500,
      },
      temporalWakeup: {
        enabled: true,
        morningWake: {
          enabled: true,
          timing: 'fixed',
          localTime: '08:00',
          timezone: 'local',
          habit: {
            recentWindowDays: 7,
            extendedWindowDays: 30,
            minSleepGapHours: 4,
            wakeBandStartHour: 3,
            wakeBandEndHour: 12,
            minSampleDays: 4,
            recentWeight: 2,
            extendedWeight: 1,
            lowerQuantile: 0.25,
            upperQuantile: 0.75,
            maxSamplesScanned: 2000,
          },
          catchUpEntryLimit: 32,
          catchUpSummaryMaxTokens: 160,
          fullTurnMaxIdleHours: 72,
        },
        idleRefresher: {
          enabled: true,
          checkIntervalMs: 900_000,
          minIdleMinutes: 240,
          minNoteIntervalMinutes: 240,
        },
      },
      weightedThoughtOutreach: {
        enabled: false,
        checkIntervalMs: 300_000,
        nudgeThreshold: 1,
        maxNudgesPerRun: 1,
        lifecycle: {
          classes: {
            time_sensitive: { baseWeight: 0.5, halflifeMs: 21_600_000 },
            standard: { baseWeight: 0.35, halflifeMs: 86_400_000 },
            trivial: { baseWeight: 0.2, halflifeMs: 259_200_000 },
          },
          reinforcement: { repeatBoost: 0.5, emotionalChargeWeight: 0.75 },
          accumulatedWeightCap: 3,
          contradictionDampeningFactor: 0.6,
          declineDampeningFactor: 0.5,
          relevanceFloor: 0.05,
        },
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
        analysisWorkbenchExtensionBand: 4,
        subagentLaunch: 1,
        shardLaunch: 7,
        externalModelConsult: 1,
        moaRoundBase: 1,
      },
      surfaceRationales: {
        paidImageGeneration: 'External image generation spends paid provider credits.',
        analysisWorkbenchExtensionBand: 'Extended analysis workbench loops reserve scarce deep-analysis budget after the first pass.',
        subagentLaunch: 'Spawning a subagent reserves a separate runtime budget.',
        shardLaunch: 'Launching a shard consumes worker coordination overhead.',
        externalModelConsult: 'Consulting an external model uses a paid API boundary.',
        moaRoundBase: 'Each MOA round carries coordination overhead even before model spend.',
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
      referenceModelClassPricingRationales: {
        cheap_cloud: 'Cheap cloud models are lightly priced to keep them available for routine use.',
        premium_cloud: 'Premium cloud models are intentionally more expensive to reserve for high-value calls.',
      },
      fatigue: makeTestFatiguePolicyConfig(),
    });

    const runtimeSettings = loadStartupRuntimeSettingsOwnerFile({
      dataDir: rootDir,
      seedDir,
    });
    const modelsLoadResult = loadStartupModelsOwnerFile({
      dataDir: rootDir,
      seedDir,
      defaultContextWindow: 128_000,
    });
    const providersLoadResult = loadStartupProvidersOwnerFile({
      dataDir: rootDir,
      seedDir,
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

  it('reports missing owner files before split startup begins', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-owner-files-missing-'));
    const seedDir = join(process.cwd(), 'config');
    mkdirSync(rootDir, { recursive: true });
    tempDirs.push(rootDir);

    const result = verifyStartupOwnerFiles({
      dataDir: rootDir,
      seedDir,
      defaultContextWindow: 128_000,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(requiredExampleOwnerFiles.length);
    expect(result.errors[0]).toContain('Missing required JSON owner file');
    expect(result.errors[0]).toContain('Startup no longer copies distributed seed/example files');
    expect(result.errors[0]).toContain('copy the example template');
  });

  it('reports stale scheduler drift before split startup begins', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-owner-files-drift-'));
    const seedDir = join(process.cwd(), 'config');
    mkdirSync(rootDir, { recursive: true });
    tempDirs.push(rootDir);
    writeRequiredOwnerExamples(rootDir, ['scheduler.json']);

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
    expect(result.errors[0]).toContain('PSFN will not overwrite it from seed/example templates');
  });

  it('fails closed when settings.json contains keys owned by other startup files', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-owner-files-settings-drift-'));
    const seedDir = join(process.cwd(), 'config');
    mkdirSync(rootDir, { recursive: true });
    tempDirs.push(rootDir);
    writeRequiredOwnerExamples(rootDir, ['settings.json']);

    writeFileSync(
      join(rootDir, 'settings.json'),
      `${JSON.stringify({
        maintenanceIntervalMs: 123_000,
        capabilityTier: 'apprentice',
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
    expect(result.errors[0]).toContain('settings.json');
    expect(result.errors[0]).toContain('Unsupported cross-domain keys in settings.json');
    expect(result.errors[0]).toContain('maintenanceIntervalMs->scheduler.json');
    expect(result.errors[0]).toContain('capabilityTier->capability-tier.json');
  });

  it('fails closed when charge-policy.json drifts from the canonical schema', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-owner-files-charge-drift-'));
    const seedDir = join(process.cwd(), 'config');
    mkdirSync(rootDir, { recursive: true });
    tempDirs.push(rootDir);
    writeRequiredOwnerExamples(rootDir, ['charge-policy.json']);

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
