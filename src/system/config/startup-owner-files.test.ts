import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveSettings } from '../settings.js';
import { loadModelsConfig, saveModelsConfig } from './models-config.js';
import { loadProvidersConfig, saveProvidersConfig } from './providers-config.js';
import { loadTrustPolicyConfig, saveTrustPolicyConfig } from './trust-policy-config.js';
import {
  DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG,
  saveSchedulerConfig,
} from './scheduler-config.js';
import { loadCapabilityTierConfig, saveCapabilityTierConfig } from './capability-tier-config.js';
import {
  loadChargePolicySeedDefaults,
  saveChargePolicyConfig,
} from './charge-policy-config.js';
import { makeTestFatiguePolicyConfig } from '../../test-support/charge-policy.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  loadStartupCapabilityTierOwnerFile,
  loadStartupChargePolicyOwnerFile,
  loadStartupModelsOwnerFile,
  loadStartupProvidersOwnerFile,
  loadStartupRuntimeSettingsOwnerFile,
  loadStartupTrustPolicyOwnerFile,
  loadStartupSchedulerOwnerFile,
  verifyStartupFleetOwnerFiles,
  verifyStartupOwnerFiles,
} from './startup-owner-files.js';
import {
  resolveCompanionFleetPaths,
  validateCompanionsConfig,
} from './companions-config.js';

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
    'intake-policy.json',
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

  function createFleetOwnerFixture(): {
    rootDir: string;
    systemDataDir: string;
    companionA: string;
    companionB: string;
    companionAId: string;
    companionBId: string;
    fleet: ReturnType<typeof resolveCompanionFleetPaths>;
  } {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-owner-fleet-'));
    const systemDataDir = join(rootDir, 'system-data');
    const companionA = join(rootDir, 'companions/a');
    const companionB = join(rootDir, 'companions/b');
    const companionAId = '11111111-1111-4111-8111-111111111111';
    const companionBId = '22222222-2222-4222-8222-222222222222';
    const rawFleet = {
      companions: [
        {
          companionId: companionAId,
          companionDataDir: 'companions/a',
          characterCardPath: 'companions/a/character-card.json',
          postgresSchema: 'companion_a',
        },
        {
          companionId: companionBId,
          companionDataDir: 'companions/b',
          characterCardPath: 'companions/b/character-card.json',
          postgresSchema: 'companion_b',
        },
      ],
    };
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(companionA, { recursive: true });
    mkdirSync(companionB, { recursive: true });
    tempDirs.push(rootDir);
    writeRequiredOwnerExamples(systemDataDir, [
      'scheduler.json',
      'capability-tier.json',
      'charge-policy.json',
      'skills.json',
    ]);
    for (const companionRoot of [companionA, companionB]) {
      for (const ownerFile of [
        'scheduler.json',
        'capability-tier.json',
        'charge-policy.json',
        'skills.json',
      ] as const) {
        copyOwnerExample(companionRoot, ownerFile);
      }
    }
    writeFileSync(
      join(systemDataDir, 'companions.json'),
      `${JSON.stringify(rawFleet, null, 2)}\n`,
      'utf8',
    );
    const fleet = resolveCompanionFleetPaths(
      validateCompanionsConfig(rawFleet, join(systemDataDir, 'companions.json')),
      rootDir,
      [{ label: 'systemDataDir', path: systemDataDir }],
    );
    return {
      rootDir,
      systemDataDir,
      companionA,
      companionB,
      companionAId,
      companionBId,
      fleet,
    };
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
      backgroundMaintenance: {
        intervalMs: 123_000,
        ambientPresence: {
          minIdleMinutes: 180,
          minNoteIntervalMinutes: 360,
        },
        concernGrooming: {
          maxActiveConcerns: 7,
        },
      },
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
      reflectionNovelty: {
        minNewEntries: 1,
      },
      wikiPass: {
        enabled: true,
        reviewWindowHours: 36,
        minNewCanonicalEpisodes: 1,
        minNewDurableMemories: 3,
        maxEntriesPerRun: 3,
        maxSourceEpisodes: 12,
        maxSourceMemories: 30,
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
        maxPriorCandidates: 24,
      },
      sleepConsolidation: {
        reviewWindowDays: 60,
        refinementWindowHours: 36,
        adjacencyGapMinutes: 45,
        maxRefinementsPerRun: 8,
        maxConsolidationsPerRun: 6,
        transcriptMessageLimit: 200,
        maxTranscriptCharsPerEpisode: 6000,
      },
      arcFormation: {
        passIntervalDays: 6,
        reviewWindowDays: 30,
        minConfidence: 0.5,
        maxArcsPerRun: 12,
        maxEpisodesPerRun: 60,
      },
      socialGraphBuilder: {
        coPresenceMinSessions: 3,
        coPresenceWindowMinutes: 1440,
        scanMemoryLimit: 500,
      },
      temporalWakeup: {
        enabled: true,
        activeChannelLookbackHours: 72,
        morningWake: {
          enabled: true,
          timing: 'fixed',
          localTime: '08:00',
          timezone: 'local',
          minPartnerIdleMinutes: 60,
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
        wakeSummary: {
          sessionSummaryMaxTokens: 160,
          continuitySummaryMaxTokens: 160,
          continuityMinEntries: 2,
        },
      },
      freeTime: {
        enabled: true,
        minBlockIntervalMinutes: 240,
        maxBlocksPerDay: 3,
        seedText: 'You have some time to yourself.',
        quietHours: {
          enabled: true,
          checkIntervalMs: 900_000,
        },
        idle: {
          enabled: true,
          checkIntervalMs: 900_000,
          minIdleMinutes: 180,
        },
        budget: {
          maxTurns: 6,
          maxChargeUnits: 8,
        },
        returnNote: {
          summaryMaxTokens: 160,
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
      icpAutonomy: DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG,
    };
    saveSchedulerConfig(rootDir, scheduler);

    const capabilityTier = loadCapabilityTierConfig(rootDir);
    saveCapabilityTierConfig(rootDir, capabilityTier);
    const chargePolicy = saveChargePolicyConfig(rootDir, {
      schemaVersion: 1,
      runChargeQuotaByLane: {
        interactive: 18,
        companion_social: 12,
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
        companionSocialContinuation: 1,
      },
      surfaceRationales: {
        paidImageGeneration: 'External image generation spends paid provider credits.',
        analysisWorkbenchExtensionBand: 'Extended analysis workbench loops reserve scarce deep-analysis budget after the first pass.',
        subagentLaunch: 'Spawning a subagent reserves a separate runtime budget.',
        shardLaunch: 'Launching a shard consumes worker coordination overhead.',
        externalModelConsult: 'Consulting an external model uses a paid API boundary.',
        moaRoundBase: 'Each MOA round carries coordination overhead even before model spend.',
        companionSocialContinuation: 'Autonomous companion continuation spends relationship-sensitive social budget.',
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
      icpCostBreaker: loadChargePolicySeedDefaults().icpCostBreaker,
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

  it('validates system owners once and every exact resolved fleet companion root', () => {
    const fixture = createFleetOwnerFixture();
    const seedDir = join(process.cwd(), 'config');
    for (const ownerFile of [
      'scheduler.json',
      'capability-tier.json',
      'charge-policy.json',
      'skills.json',
    ]) {
      writeFileSync(join(fixture.systemDataDir, ownerFile), '{"decoy":true}\n', 'utf8');
    }

    expect(verifyStartupFleetOwnerFiles({
      dataDir: fixture.systemDataDir,
      seedDir,
      defaultContextWindow: 128_000,
      fleetAuth: false,
      fleet: fixture.fleet,
    })).toEqual({ ok: true, errors: [] });

    writeFileSync(
      join(fixture.systemDataDir, 'settings.json'),
      '{"capabilityTier":"nursery"}\n',
      'utf8',
    );
    const drifted = verifyStartupFleetOwnerFiles({
      dataDir: fixture.systemDataDir,
      seedDir,
      defaultContextWindow: 128_000,
      fleetAuth: false,
      fleet: fixture.fleet,
    });
    expect(drifted.errors.filter(error => error.startsWith('settings owner-file'))).toHaveLength(1);
  });

  it('names the exact companion whose owner is missing or malformed without cross-root fallback', () => {
    const fixture = createFleetOwnerFixture();
    const seedDir = join(process.cwd(), 'config');
    copyOwnerExample(fixture.systemDataDir, 'scheduler.json');
    rmSync(join(fixture.companionA, 'scheduler.json'));
    writeFileSync(join(fixture.companionB, 'skills.json'), '{"enabled":"invalid"}\n', 'utf8');

    const result = verifyStartupFleetOwnerFiles({
      dataDir: fixture.systemDataDir,
      seedDir,
      defaultContextWindow: 128_000,
      fleetAuth: false,
      fleet: fixture.fleet,
    });

    expect(result.ok).toBe(false);
    const companionAError = result.errors.find(error => error.includes(fixture.companionAId));
    const companionBError = result.errors.find(error => error.includes(fixture.companionBId));
    expect(companionAError).toContain('scheduler owner-file validation failed');
    expect(companionAError).toContain(join(fixture.companionA, 'scheduler.json'));
    expect(companionBError).toContain('skills owner-file validation failed');
    expect(companionBError).toContain(join(fixture.companionB, 'skills.json'));
    expect(result.errors.some(error => (
      error.includes(fixture.companionAId)
      && error.includes(fixture.companionB)
    ))).toBe(false);
  });

  it('requires the fleet to pass canonical unknown, duplicate, and overlap validation first', () => {
    const baseEntry = {
      companionId: '11111111-1111-4111-8111-111111111111',
      companionDataDir: 'companions/a',
      characterCardPath: 'companions/a/character-card.json',
      postgresSchema: 'companion_a',
    };
    expect(() => validateCompanionsConfig({
      companions: [{ ...baseEntry, unknownOwnerRoot: 'system-data' }],
    }, 'companions.json')).toThrow(/unknown key/i);
    expect(() => validateCompanionsConfig({
      companions: [baseEntry, { ...baseEntry, postgresSchema: 'companion_b' }],
    }, 'companions.json')).toThrow(/duplicate companionId/);
    expect(() => validateCompanionsConfig({
      companions: [
        baseEntry,
        {
          ...baseEntry,
          companionId: '22222222-2222-4222-8222-222222222222',
          companionDataDir: 'companions/a/nested',
          characterCardPath: 'companions/a/nested/character-card.json',
          postgresSchema: 'companion_b',
        },
      ],
    }, 'companions.json')).toThrow(/must not overlap/);
  });

  it('reports stale scheduler drift before split startup begins', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-owner-files-drift-'));
    const seedDir = join(process.cwd(), 'config');
    mkdirSync(rootDir, { recursive: true });
    tempDirs.push(rootDir);
    writeRequiredOwnerExamples(rootDir, ['scheduler.json']);

    const scheduler = JSON.parse(
      readFileSync(join(seedDir, 'scheduler.seed.json'), 'utf8'),
    ) as unknown;
    if (!isRecord(scheduler)) {
      throw new Error('scheduler seed fixture must be an object');
    }
    delete scheduler.episodicProcessing;

    writeFileSync(
      join(rootDir, 'scheduler.json'),
      `${JSON.stringify(scheduler, null, 2)}\n`,
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
    expect(result.errors[0]).toContain('episodicProcessing must be an object');
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
        salienceDecayIntervalMs: 123_000,
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
    expect(result.errors[0]).toContain('salienceDecayIntervalMs->scheduler.json');
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
          companion_social: 12,
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
