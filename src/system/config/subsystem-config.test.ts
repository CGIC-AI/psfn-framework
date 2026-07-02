import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CAPABILITY_TIER_FILE_NAME,
  loadCapabilityTierConfig,
  saveCapabilityTierConfig,
} from './capability-tier-config.js';
import {
  MODELS_FILE_NAME,
  loadModelsConfig,
  saveModelsConfig,
} from './models-config.js';
import {
  PROVIDERS_FILE_NAME,
  loadProvidersConfig,
  saveProvidersConfig,
} from './providers-config.js';
import {
  SCHEDULER_FILE_NAME,
  loadSchedulerConfig,
  saveSchedulerConfig,
} from './scheduler-config.js';
import {
  SKILLS_FILE_NAME,
  loadSkillsConfig,
  saveSkillsConfig,
} from './skills-config.js';
import {
  TRUST_POLICY_FILE_NAME,
  loadTrustPolicyConfig,
  saveTrustPolicyConfig,
} from './trust-policy-config.js';

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

describe('subsystem config round-trip', () => {
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

  it('round-trips models.json without drift', () => {
    const dataDir = makeDataDir('psfn-models-config-');
    const expected = {
      schemaVersion: 1,
      budgetPolicy: {
        enabled: true,
        dailyUsdLimit: 3,
        monthlyUsdLimit: 60,
        currency: 'USD',
      },
      models: [
        {
          id: 'primary',
          rank: 100,
          identity: {
            model: 'openai/gpt-4.1-mini',
            provider: 'openrouter',
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
          capabilities: { maxOutputTokens: 4096, contextWindow: 128_000 },
          tuning: { maxOutputTokens: 4096 },
        },
        {
          id: 'extraction',
          rank: 80,
          identity: {
            model: 'deepseek/deepseek-v3.2',
            provider: 'openrouter',
            source: { type: 'openrouter' },
          },
          purposes: [
            { purpose: 'background', primary: true },
            { purpose: 'memory', primary: true },
            { purpose: 'extraction', primary: true },
            { purpose: 'import_processing', primary: true },
          ],
          capabilities: { maxOutputTokens: 2048, contextWindow: 128_000 },
          tuning: { maxOutputTokens: 2048 },
        },
      ],
    };

    const saved = saveModelsConfig(dataDir, expected, { defaultContextWindow: 128_000 });
    expect(saved.modelRegistry).toEqual(expected);
    expect(saved.modelRoleAssignments.chat).toBe('primary');
    expect(saved.modelRoleAssignments.background).toBe('extraction');
    expect(saved.modelRoleAssignments.memory).toBe('extraction');
    expect(saved.modelRoleAssignments.extraction).toBe('extraction');
    expect(saved.modelRoleAssignments.import_processing).toBe('extraction');
    expect(saved.modelRoleAssignments.moa).toBe('primary');
    expect(readJsonFile(join(dataDir, MODELS_FILE_NAME))).toEqual(expected);
    expect(loadModelsConfig(dataDir, { defaultContextWindow: 128_000 }).modelRegistry).toEqual(expected);
  });

  it('round-trips the registry-wide promptCaching policy and validates it fail-closed', () => {
    const dataDir = makeDataDir('psfn-models-prompt-caching-');
    const base = {
      schemaVersion: 1,
      models: [
        {
          id: 'primary',
          rank: 100,
          identity: {
            model: 'openai/gpt-4.1-mini',
            provider: 'openrouter',
            source: { type: 'openrouter' },
          },
          purposes: [
            { purpose: 'chat', primary: true },
            { purpose: 'summary', primary: true },
            { purpose: 'reasoning', primary: true },
            { purpose: 'longContext', primary: true },
            { purpose: 'vision', primary: true },
            { purpose: 'moa', primary: true },
            { purpose: 'background', primary: true },
            { purpose: 'memory', primary: true },
            { purpose: 'extraction', primary: true },
            { purpose: 'import_processing', primary: true },
          ],
          capabilities: { maxOutputTokens: 4096, contextWindow: 128_000 },
          tuning: { maxOutputTokens: 4096 },
        },
      ],
    };

    const enabled = {
      ...base,
      promptCaching: { enabled: true, retention: 'long', scope: 'channel' },
    };
    const saved = saveModelsConfig(dataDir, enabled, { defaultContextWindow: 128_000 });
    expect(saved.modelRegistry.promptCaching).toEqual({ enabled: true, retention: 'long', scope: 'channel' });
    expect(readJsonFile(join(dataDir, MODELS_FILE_NAME))).toEqual(enabled);
    expect(loadModelsConfig(dataDir, { defaultContextWindow: 128_000 }).modelRegistry.promptCaching)
      .toEqual({ enabled: true, retention: 'long', scope: 'channel' });

    // Absent policy stays absent (default OFF; no silent defaulting).
    const withoutPolicy = saveModelsConfig(dataDir, base, { defaultContextWindow: 128_000 });
    expect(withoutPolicy.modelRegistry.promptCaching).toBeUndefined();

    // Fail-closed validation.
    expect(() => saveModelsConfig(dataDir, { ...base, promptCaching: { enabled: 'maybe' } }, { defaultContextWindow: 128_000 }))
      .toThrow(/promptCaching\.enabled: expected boolean/);
    expect(() => saveModelsConfig(dataDir, { ...base, promptCaching: { enabled: true, retention: 'forever' } }, { defaultContextWindow: 128_000 }))
      .toThrow(/promptCaching\.retention: expected one of none, short, long/);
    expect(() => saveModelsConfig(dataDir, { ...base, promptCaching: { enabled: true, scope: 'global' } }, { defaultContextWindow: 128_000 }))
      .toThrow(/promptCaching\.scope: expected one of channel, request/);
    expect(() => saveModelsConfig(dataDir, { ...base, promptCaching: [] }, { defaultContextWindow: 128_000 }))
      .toThrow(/promptCaching: expected object/);
  });

  it('validates the distributed models seed with promptCaching disabled by default', () => {
    const dataDir = makeDataDir('psfn-models-seed-prompt-caching-');
    const seed = readJsonFile<Record<string, unknown>>(join('config', 'models.seed.json'));
    writeFileSync(join(dataDir, MODELS_FILE_NAME), JSON.stringify(seed, null, 2));
    const loaded = loadModelsConfig(dataDir, { defaultContextWindow: 128_000 });
    expect(loaded.modelRegistry.promptCaching).toEqual({ enabled: false });
  });

  it('fails closed when canonical primary-per-purpose invariant is violated', () => {
    const dataDir = makeDataDir('psfn-models-config-invalid-');
    const invalid = {
      schemaVersion: 1,
      models: [
        {
          id: 'primary',
          rank: 100,
          identity: {
            model: 'openai/gpt-4.1-mini',
            provider: 'openrouter',
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
          capabilities: { maxOutputTokens: 4096, contextWindow: 128_000 },
          tuning: { maxOutputTokens: 4096 },
        },
        {
          id: 'extraction',
          rank: 80,
          identity: {
            model: 'deepseek/deepseek-v3.2',
            provider: 'openrouter',
            source: { type: 'openrouter' },
          },
          purposes: [
            { purpose: 'chat', primary: true },
            { purpose: 'background', primary: true },
            { purpose: 'memory', primary: true },
            { purpose: 'extraction', primary: true },
            { purpose: 'import_processing', primary: true },
          ],
          capabilities: { maxOutputTokens: 2048, contextWindow: 128_000 },
          tuning: { maxOutputTokens: 2048 },
        },
      ],
    };

    expect(() => saveModelsConfig(dataDir, invalid)).toThrow('must have exactly one primary model');
  });

  it('fails closed when canonical budget policy is invalid', () => {
    const dataDir = makeDataDir('psfn-models-config-invalid-budget-');
    const invalid = {
      schemaVersion: 1,
      budgetPolicy: {
        enabled: true,
        dailyUsdLimit: 100,
        monthlyUsdLimit: 10,
      },
      models: [
        {
          id: 'primary',
          rank: 100,
          identity: {
            model: 'openai/gpt-4.1-mini',
            provider: 'openrouter',
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
          capabilities: { maxOutputTokens: 4096, contextWindow: 128_000 },
          tuning: { maxOutputTokens: 4096 },
        },
        {
          id: 'extraction',
          rank: 80,
          identity: {
            model: 'deepseek/deepseek-v3.2',
            provider: 'openrouter',
            source: { type: 'openrouter' },
          },
          purposes: [
            { purpose: 'background', primary: true },
            { purpose: 'memory', primary: true },
            { purpose: 'extraction', primary: true },
            { purpose: 'import_processing', primary: true },
          ],
          capabilities: { maxOutputTokens: 2048, contextWindow: 128_000 },
          tuning: { maxOutputTokens: 2048 },
        },
      ],
    };

    expect(() => saveModelsConfig(dataDir, invalid)).toThrow('monthlyUsdLimit must be >= dailyUsdLimit');
  });

  it('round-trips scheduler.json without drift', () => {
    const dataDir = makeDataDir('psfn-scheduler-config-');
    const expected = {
      tickIntervalMs: 1_500,
      heartbeatIntervalMs: 9_000,
      salienceDecayIntervalMs: 12_000,
      artifactLifecycle: {
        scratchpadRetentionDays: 14,
        generatedMediaRetentionDays: 30,
        workspaceTempRetentionDays: 14,
        cleanupBatchSize: 128,
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
    };

    expect(saveSchedulerConfig(dataDir, expected)).toEqual(expected);
    expect(readJsonFile(join(dataDir, SCHEDULER_FILE_NAME))).toEqual(expected);
    expect(loadSchedulerConfig(dataDir)).toEqual(expected);
  });

  it('round-trips skills.json without drift', () => {
    const dataDir = makeDataDir('psfn-skills-config-');
    const expected = {
      enabled: true,
      directories: ['skills'],
      extraDirectories: ['history/skills'],
      maxLoadedSkills: 16,
      maxSkillChars: 12_000,
      disabledSkills: ['git-ops'],
    };

    expect(saveSkillsConfig(dataDir, expected)).toEqual(expected);
    expect(readJsonFile(join(dataDir, SKILLS_FILE_NAME))).toEqual(expected);
    expect(loadSkillsConfig(dataDir)).toEqual(expected);
  });

  it('round-trips trust-policy.json without drift', () => {
    const dataDir = makeDataDir('psfn-trust-policy-config-');
    const expected = {
      trustCeiling: {
        primary: ['public', 'personal', 'intimate', 'confidential'],
        trusted: ['public', 'personal'],
        regular: ['public', 'personal'],
        public: ['public'],
      },
      visibilityAllowed: {
        private: ['public', 'personal', 'intimate', 'confidential'],
        invite_only: ['public', 'personal'],
        public: ['public'],
      },
      audienceScopeThresholds: {
        fewMax: 8,
        manyMax: 80,
      },
      participantRelationshipConfidenceThreshold: 0.8,
      channelClassification: {
        privatePrefixes: ['custom:'],
        broadcastPrefixes: ['social:'],
        defaultVisibility: 'public',
        visibilityOverrides: {
          exact: {
            'custom:exact-room': { privacy: 'public', broadcast: true },
          },
          prefix: {
            'custom:': { privacy: 'private', broadcast: false },
          },
        },
      },
    };

    expect(saveTrustPolicyConfig(dataDir, expected)).toEqual(expected);
    expect(readJsonFile(join(dataDir, TRUST_POLICY_FILE_NAME))).toEqual(expected);
    expect(loadTrustPolicyConfig(dataDir)).toEqual(expected);
  });

  it('normalizes bare channel-privacy override strings to {privacy, broadcast} pairs', () => {
    const dataDir = makeDataDir('psfn-trust-policy-bare-override-');
    const withBareStrings = {
      trustCeiling: {
        primary: ['public', 'personal', 'intimate', 'confidential'],
        trusted: ['public', 'personal'],
        regular: ['public', 'personal'],
        public: ['public'],
      },
      visibilityAllowed: {
        private: ['public', 'personal', 'intimate', 'confidential'],
        invite_only: ['public', 'personal'],
        public: ['public'],
      },
      channelClassification: {
        privatePrefixes: ['custom:'],
        broadcastPrefixes: ['social:'],
        defaultVisibility: 'invite_only',
        visibilityOverrides: {
          exact: { 'custom:exact-room': 'public' },
          prefix: { 'custom:': 'private' },
        },
      },
    };

    const saved = saveTrustPolicyConfig(dataDir, withBareStrings);
    expect(saved.channelClassification.visibilityOverrides.exact['custom:exact-room'])
      .toEqual({ privacy: 'public', broadcast: false });
    expect(saved.channelClassification.visibilityOverrides.prefix['custom:'])
      .toEqual({ privacy: 'private', broadcast: false });
    expect(loadTrustPolicyConfig(dataDir).channelClassification.visibilityOverrides.exact['custom:exact-room'])
      .toEqual({ privacy: 'public', broadcast: false });
  });

  it('migrates the known old default trust-policy regular ceiling', () => {
    const dataDir = makeDataDir('psfn-trust-policy-migrate-');
    const oldDefault = {
      trustCeiling: {
        primary: ['public', 'personal', 'intimate', 'confidential'],
        trusted: ['public', 'personal'],
        regular: ['public'],
        public: ['public'],
      },
      visibilityAllowed: {
        private: ['public', 'personal', 'intimate', 'confidential'],
        invite_only: ['public', 'personal'],
        public: ['public'],
        broadcast: ['public'],
      },
      channelClassification: {
        privatePrefixes: ['api:', 'sillytavern:', 'openwebui:', 'shard:', 'internal:'],
        broadcastPrefixes: ['twitter:', 'social:'],
        defaultVisibility: 'invite_only',
        visibilityOverrides: {
          exact: {},
          prefix: {},
        },
      },
    };
    writeFileSync(join(dataDir, TRUST_POLICY_FILE_NAME), JSON.stringify(oldDefault, null, 2), 'utf-8');

    const loaded = loadTrustPolicyConfig(dataDir);

    expect(loaded.trustCeiling.regular).toEqual(['public', 'personal']);
    expect(readJsonFile<{ trustCeiling: { regular: string[] } }>(
      join(dataDir, TRUST_POLICY_FILE_NAME),
    ).trustCeiling.regular)
      .toEqual(['public', 'personal']);
  });

  it('preserves valid custom trust policies that are not the known old default', () => {
    const dataDir = makeDataDir('psfn-trust-policy-custom-');
    const custom = {
      trustCeiling: {
        primary: ['public', 'personal', 'intimate', 'confidential'],
        trusted: ['public', 'personal'],
        regular: ['public'],
        public: ['public'],
      },
      visibilityAllowed: {
        private: ['public', 'personal', 'intimate', 'confidential'],
        invite_only: ['public'],
        public: ['public'],
      },
      channelClassification: {
        privatePrefixes: ['custom:'],
        broadcastPrefixes: ['social:'],
        defaultVisibility: 'invite_only',
        visibilityOverrides: {
          exact: {},
          prefix: {},
        },
      },
    };
    writeFileSync(join(dataDir, TRUST_POLICY_FILE_NAME), JSON.stringify(custom, null, 2), 'utf-8');

    expect(loadTrustPolicyConfig(dataDir)).toEqual({
      ...custom,
      // Absent audienceScopeThresholds resolve to the documented defaults.
      audienceScopeThresholds: { fewMax: 10, manyMax: 100 },
      // Absent participantRelationshipConfidenceThreshold resolves to 0.7.
      participantRelationshipConfidenceThreshold: 0.7,
    });
    expect(readJsonFile(join(dataDir, TRUST_POLICY_FILE_NAME))).toEqual(custom);
  });

  it('migrates legacy semi_private/broadcast trust-policy vocabulary at load', () => {
    const dataDir = makeDataDir('psfn-trust-policy-vocab-');
    const legacy = {
      trustCeiling: {
        primary: ['public', 'personal', 'intimate', 'confidential'],
        trusted: ['public', 'personal'],
        regular: ['public', 'personal'],
        public: ['public'],
      },
      visibilityAllowed: {
        private: ['public', 'personal', 'intimate', 'confidential'],
        semi_private: ['public', 'personal'],
        public: ['public'],
        // Legacy broadcast row equal to the public row: dropped at load.
        broadcast: ['public'],
      },
      channelClassification: {
        privatePrefixes: ['custom:'],
        broadcastPrefixes: ['social:'],
        defaultVisibility: 'semi_private',
        visibilityOverrides: {
          exact: { 'custom:room': 'semi_private', 'custom:megaphone': 'broadcast' },
          prefix: { 'legacy:': 'semi_private' },
        },
      },
    };
    writeFileSync(join(dataDir, TRUST_POLICY_FILE_NAME), JSON.stringify(legacy, null, 2), 'utf-8');

    const loaded = loadTrustPolicyConfig(dataDir);

    expect(loaded.visibilityAllowed.invite_only).toEqual(['public', 'personal']);
    expect(Object.keys(loaded.visibilityAllowed)).not.toContain('semi_private');
    expect(Object.keys(loaded.visibilityAllowed)).not.toContain('broadcast');
    expect(loaded.channelClassification.defaultVisibility).toBe('invite_only');
    expect(loaded.channelClassification.visibilityOverrides.exact['custom:room'])
      .toEqual({ privacy: 'invite_only', broadcast: false });
    expect(loaded.channelClassification.visibilityOverrides.exact['custom:megaphone'])
      .toEqual({ privacy: 'public', broadcast: true });
    expect(loaded.channelClassification.visibilityOverrides.prefix['legacy:'])
      .toEqual({ privacy: 'invite_only', broadcast: false });

    // The migration is persisted so the retired vocabulary never survives on disk.
    const persisted = readJsonFile<{
      visibilityAllowed: Record<string, string[]>;
      channelClassification: {
        defaultVisibility: string;
        visibilityOverrides: { exact: Record<string, unknown> };
      };
    }>(join(dataDir, TRUST_POLICY_FILE_NAME));
    expect(Object.keys(persisted.visibilityAllowed)).not.toContain('semi_private');
    expect(Object.keys(persisted.visibilityAllowed)).not.toContain('broadcast');
    expect(persisted.channelClassification.defaultVisibility).toBe('invite_only');
    expect(persisted.channelClassification.visibilityOverrides.exact['custom:megaphone'])
      .toEqual({ privacy: 'public', broadcast: true });
  });

  it('fails closed when a legacy broadcast visibility row differs from the public row', () => {
    const dataDir = makeDataDir('psfn-trust-policy-broadcast-row-diff-');
    const divergent = {
      trustCeiling: {
        primary: ['public', 'personal', 'intimate', 'confidential'],
        trusted: ['public', 'personal'],
        regular: ['public', 'personal'],
        public: ['public'],
      },
      visibilityAllowed: {
        private: ['public', 'personal', 'intimate', 'confidential'],
        invite_only: ['public', 'personal'],
        public: ['public'],
        // Dropping this silently would change gating; the load must throw.
        broadcast: ['public', 'personal'],
      },
      channelClassification: {
        privatePrefixes: [],
        broadcastPrefixes: [],
        defaultVisibility: 'invite_only',
        visibilityOverrides: { exact: {}, prefix: {} },
      },
    };
    writeFileSync(join(dataDir, TRUST_POLICY_FILE_NAME), JSON.stringify(divergent, null, 2), 'utf-8');

    expect(() => loadTrustPolicyConfig(dataDir)).toThrow(/broadcast.*differs from.*public/);
  });

  it('fails closed when trust-policy defines both semi_private and invite_only', () => {
    const dataDir = makeDataDir('psfn-trust-policy-vocab-conflict-');
    const conflicted = {
      trustCeiling: {
        primary: ['public', 'personal', 'intimate', 'confidential'],
        trusted: ['public', 'personal'],
        regular: ['public', 'personal'],
        public: ['public'],
      },
      visibilityAllowed: {
        private: ['public', 'personal', 'intimate', 'confidential'],
        semi_private: ['public', 'personal'],
        invite_only: ['public'],
        public: ['public'],
        broadcast: ['public'],
      },
      channelClassification: {
        privatePrefixes: [],
        broadcastPrefixes: [],
        defaultVisibility: 'invite_only',
        visibilityOverrides: { exact: {}, prefix: {} },
      },
    };
    writeFileSync(join(dataDir, TRUST_POLICY_FILE_NAME), JSON.stringify(conflicted, null, 2), 'utf-8');

    expect(() => loadTrustPolicyConfig(dataDir)).toThrow(/semi_private and invite_only/);
  });

  it('rejects saving trust-policy with the retired semi_private vocabulary', () => {
    const dataDir = makeDataDir('psfn-trust-policy-vocab-save-');
    const legacy = {
      trustCeiling: {
        primary: ['public', 'personal', 'intimate', 'confidential'],
        trusted: ['public', 'personal'],
        regular: ['public', 'personal'],
        public: ['public'],
      },
      visibilityAllowed: {
        private: ['public', 'personal', 'intimate', 'confidential'],
        semi_private: ['public', 'personal'],
        public: ['public'],
        broadcast: ['public'],
      },
      channelClassification: {
        privatePrefixes: [],
        broadcastPrefixes: [],
        defaultVisibility: 'semi_private',
        visibilityOverrides: { exact: {}, prefix: {} },
      },
    };

    expect(() => saveTrustPolicyConfig(dataDir, legacy)).toThrow();
  });

  it('rejects saving trust-policy with the retired broadcast visibility row', () => {
    const dataDir = makeDataDir('psfn-trust-policy-broadcast-save-');
    const legacy = {
      trustCeiling: {
        primary: ['public', 'personal', 'intimate', 'confidential'],
        trusted: ['public', 'personal'],
        regular: ['public', 'personal'],
        public: ['public'],
      },
      visibilityAllowed: {
        private: ['public', 'personal', 'intimate', 'confidential'],
        invite_only: ['public', 'personal'],
        public: ['public'],
        broadcast: ['public'],
      },
      channelClassification: {
        privatePrefixes: [],
        broadcastPrefixes: [],
        defaultVisibility: 'invite_only',
        visibilityOverrides: { exact: {}, prefix: {} },
      },
    };

    expect(() => saveTrustPolicyConfig(dataDir, legacy)).toThrow(/unsupported keys: broadcast/);
  });

  it('validates audienceScopeThresholds fail-closed', () => {
    const dataDir = makeDataDir('psfn-trust-policy-thresholds-');
    const base = {
      trustCeiling: {
        primary: ['public', 'personal', 'intimate', 'confidential'],
        trusted: ['public', 'personal'],
        regular: ['public', 'personal'],
        public: ['public'],
      },
      visibilityAllowed: {
        private: ['public', 'personal', 'intimate', 'confidential'],
        invite_only: ['public', 'personal'],
        public: ['public'],
      },
      channelClassification: {
        privatePrefixes: [],
        broadcastPrefixes: [],
        defaultVisibility: 'invite_only',
        visibilityOverrides: { exact: {}, prefix: {} },
      },
    };

    expect(() => saveTrustPolicyConfig(dataDir, {
      ...base,
      audienceScopeThresholds: { fewMax: 0, manyMax: 100 },
    })).toThrow(/fewMax/);
    expect(() => saveTrustPolicyConfig(dataDir, {
      ...base,
      audienceScopeThresholds: { fewMax: 10, manyMax: 10 },
    })).toThrow(/manyMax/);
    expect(() => saveTrustPolicyConfig(dataDir, {
      ...base,
      audienceScopeThresholds: { fewMax: 10, manyMax: 100, extra: true },
    })).toThrow(/unsupported keys/);
  });

  it('round-trips capability-tier.json without drift', () => {
    const dataDir = makeDataDir('psfn-capability-tier-config-');
    const expected = {
      tier: 'custom',
      customTokens: ['identity.read', 'git.read'],
    };

    expect(saveCapabilityTierConfig(dataDir, expected)).toEqual(expected);
    expect(readJsonFile(join(dataDir, CAPABILITY_TIER_FILE_NAME))).toEqual(expected);
    expect(loadCapabilityTierConfig(dataDir)).toEqual(expected);
  });

  it('round-trips providers.json without drift', () => {
    const dataDir = makeDataDir('psfn-providers-config-');
    const expected = {
      schemaVersion: 1,
      providers: [
        {
          id: 'litellm',
          type: 'litellm_proxy',
          enabled: true,
          label: 'LiteLLM Proxy',
          apiBaseUrl: 'http://127.0.0.1:4000/v1',
          apiKeyRef: {
            kind: 'env',
            envName: 'LITELLM_API_KEY',
          },
        },
        {
          id: 'openrouter',
          type: 'openrouter',
          enabled: true,
          label: 'OpenRouter',
          apiBaseUrl: 'https://openrouter.ai/api/v1',
          modelsApiUrl: 'https://openrouter.ai/api/v1/models',
          apiKeyRef: {
            kind: 'env',
            envName: 'OPENROUTER_API_KEY',
          },
        },
      ],
    };

    const saved = saveProvidersConfig(dataDir, expected);
    expect(saved.registry).toEqual(expected);
    expect(saved.litellmBaseUrl).toBe('http://127.0.0.1:4000/v1');
    expect(saved.litellmApiKeyRef).toEqual({
      kind: 'env',
      envName: 'LITELLM_API_KEY',
    });
    expect(saved.openRouterModelsApiUrl).toBe('https://openrouter.ai/api/v1/models');
    expect(readJsonFile(join(dataDir, PROVIDERS_FILE_NAME))).toEqual(expected);
    expect(loadProvidersConfig(dataDir).registry).toEqual(expected);
  });

  it('loads current providers.json owner files without legacy enabled flags as active', () => {
    const dataDir = makeDataDir('psfn-providers-config-no-enabled-');
    writeFileSync(join(dataDir, PROVIDERS_FILE_NAME), JSON.stringify({
      schemaVersion: 1,
      providers: [
        {
          id: 'openrouter',
          type: 'openrouter',
          label: 'OpenRouter',
          apiBaseUrl: 'https://openrouter.ai/api/v1',
          modelsApiUrl: 'https://openrouter.ai/api/v1/models',
          apiKeyRef: {
            kind: 'env',
            envName: 'OPENROUTER_API_KEY',
          },
        },
      ],
    }));

    const loaded = loadProvidersConfig(dataDir);
    expect(loaded.registry.providers).toEqual([
      expect.objectContaining({
        id: 'openrouter',
        type: 'openrouter',
        enabled: true,
      }),
    ]);
    expect(loaded.openRouterApiBaseUrl).toBe('https://openrouter.ai/api/v1');
    expect(loaded.openRouterModelsApiUrl).toBe('https://openrouter.ai/api/v1/models');
  });
});
