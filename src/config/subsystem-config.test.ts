import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
      modelCatalog: {
        primary: {
          model: 'openai/gpt-4.1-mini',
          provider: 'openrouter',
          defaults: { maxTokens: 4096, contextWindow: 128_000 },
          routing: { providerOrder: ['parasail', 'openai'] },
        },
        extraction: {
          model: 'deepseek/deepseek-v3.2',
          provider: 'openrouter',
          defaults: { maxTokens: 2048 },
        },
      },
      modelRoleAssignments: {
        chat: 'primary',
        summary: 'primary',
        reasoning: 'primary',
        longContext: 'primary',
        context: 'extraction',
        extraction: 'extraction',
        background: 'extraction',
        import_processing: 'extraction',
      },
    };

    const saved = saveModelsConfig(dataDir, expected, { defaultContextWindow: 128_000 });
    expect(saved).toEqual(expected);
    expect(readJsonFile(join(dataDir, MODELS_FILE_NAME))).toEqual(expected);
    expect(loadModelsConfig(dataDir, { defaultContextWindow: 128_000 })).toEqual(expected);
  });

  it('round-trips scheduler.json without drift', () => {
    const dataDir = makeDataDir('psfn-scheduler-config-');
    const expected = {
      tickIntervalMs: 1_500,
      heartbeatIntervalMs: 9_000,
      salienceDecayIntervalMs: 12_000,
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
});
