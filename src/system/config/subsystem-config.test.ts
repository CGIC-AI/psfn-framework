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
        regular: ['public'],
        public: ['public'],
      },
      visibilityAllowed: {
        private: ['public', 'personal', 'intimate', 'confidential'],
        semi_private: ['public', 'personal'],
        public: ['public'],
        broadcast: ['public'],
      },
      channelClassification: {
        privatePrefixes: ['custom:'],
        broadcastPrefixes: ['social:'],
        defaultVisibility: 'public',
        visibilityOverrides: {
          exact: {
            'custom:exact-room': 'broadcast',
          },
          prefix: {
            'custom:': 'private',
          },
        },
      },
    };

    expect(saveTrustPolicyConfig(dataDir, expected)).toEqual(expected);
    expect(readJsonFile(join(dataDir, TRUST_POLICY_FILE_NAME))).toEqual(expected);
    expect(loadTrustPolicyConfig(dataDir)).toEqual(expected);
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
