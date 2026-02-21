import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadSettings,
  saveSettings,
  applySettings,
  parseSettingsForm,
  getRuntimeSettingsSnapshot,
  isRuntimeSettingKey,
  RUNTIME_SETTINGS_KEYS,
  normalizeEditableSettings,
} from './settings.js';
import type { SubstrateConfig } from './types.js';

function makeConfig(): SubstrateConfig {
  return {
    primaryModel: 'z-ai/glm-5',
    primaryProvider: 'openrouter',
    extractionModel: 'deepseek/deepseek-v3.2',
    extractionProvider: 'openrouter',
    discordToken: '',
    discordBotId: '123',
    characterCardPath: '',
    dataDir: './data',
    databasePath: '',
    sessionHistoryBudgetPct: 6,
    memoryRetrievalBudgetPct: 2,
    sessionMessageLimit: 30,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    primaryMaxTokens: 16384,
    extractionMaxTokens: 8192,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    memoryBudgetPct: 20,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    modelCatalog: {
      primary: {
        model: 'z-ai/glm-5',
        provider: 'openrouter',
        defaults: { maxTokens: 16384, contextWindow: 128_000 },
        overrides: { maxTokens: 16384 },
      },
      extraction: {
        model: 'deepseek/deepseek-v3.2',
        provider: 'openrouter',
        defaults: { maxTokens: 8192 },
        overrides: { maxTokens: 8192 },
      },
    },
    modelRoleAssignments: {
      chat: 'primary',
      background: 'extraction',
      extraction: 'extraction',
      summary: 'primary',
      reasoning: 'primary',
      longContext: 'primary',
    },
    modelRoster: {
      chat: { model: 'z-ai/glm-5', provider: 'openrouter', maxTokens: 16384, contextWindow: 128_000 },
      background: { model: 'deepseek/deepseek-v3.2', provider: 'openrouter', maxTokens: 8192 },
    },
    retryMaxAttempts: 3,
    retryBaseDelayMs: 2000,
  };
}

describe('settings', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'psfn-settings-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('loadSettings', () => {
    it('seeds defaults when file missing', () => {
      const result = loadSettings(tempDir);
      expect(result.sessionHistoryBudgetPct).toBe(6);
      expect(result.memoryRetrievalBudgetPct).toBe(2);
      expect(result.extractionInterval).toBe(5);
      expect(existsSync(join(tempDir, 'settings.json'))).toBe(true);
    });

    it('migrates legacy model fields on load', () => {
      const path = join(tempDir, 'settings.json');
      writeFileSync(path, JSON.stringify({
        primaryModel: 'legacy/chat',
        primaryProvider: 'openrouter',
        primaryMaxTokens: 4096,
        extractionModel: 'legacy/extract',
        extractionProvider: 'openrouter',
        extractionMaxTokens: 2048,
      }), 'utf-8');

      const result = loadSettings(tempDir);
      expect(result.modelCatalog?.primary?.model).toBe('legacy/chat');
      expect(result.modelCatalog?.extraction?.model).toBe('legacy/extract');
      expect(result.modelRoleAssignments?.chat).toBe('primary');
      expect(result.modelRoleAssignments?.extraction).toBe('extraction');
    });

    it('reseeds defaults for invalid JSON', () => {
      const path = join(tempDir, 'settings.json');
      writeFileSync(path, 'not json', 'utf-8');
      const result = loadSettings(tempDir);
      expect(result.sessionHistoryBudgetPct).toBe(6);
      expect(result.memoryRetrievalBudgetPct).toBe(2);
    });

    it('reseeds defaults for array JSON', () => {
      const path = join(tempDir, 'settings.json');
      writeFileSync(path, '[]', 'utf-8');
      const result = loadSettings(tempDir);
      expect(result.sessionHistoryBudgetPct).toBe(6);
      expect(result.memoryRetrievalBudgetPct).toBe(2);
    });
  });

  describe('saveSettings', () => {
    it('writes settings atomically and normalizes model fields', () => {
      const settings = {
        primaryModel: 'test/chat',
        primaryProvider: 'openrouter',
        primaryMaxTokens: 4096,
        extractionInterval: 10,
      };
      saveSettings(tempDir, settings);

      const raw = readFileSync(join(tempDir, 'settings.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.primaryModel).toBe('test/chat');
      expect(parsed.modelCatalog.primary.model).toBe('test/chat');
      expect(parsed.modelRoleAssignments.chat).toBe('primary');
      expect(parsed.extractionInterval).toBe(10);
    });

    it('creates data dir if missing', () => {
      const nested = join(tempDir, 'sub', 'dir');
      saveSettings(nested, { primaryMaxTokens: 1024 });
      expect(existsSync(join(nested, 'settings.json'))).toBe(true);
    });

    it('no .tmp file remains after save', () => {
      saveSettings(tempDir, { primaryModel: 'test' });
      expect(existsSync(join(tempDir, 'settings.json.tmp'))).toBe(false);
    });
  });

  describe('normalizeEditableSettings', () => {
    it('migrates legacy primary/extraction fields into catalog and role assignments', () => {
      const normalized = normalizeEditableSettings({
        primaryModel: 'chat/model',
        primaryProvider: 'openrouter',
        primaryMaxTokens: 6000,
        extractionModel: 'extract/model',
        extractionProvider: 'openrouter',
        extractionMaxTokens: 2000,
      }, {
        defaultContextWindow: 128_000,
      });

      expect(normalized.modelCatalog?.primary).toEqual({
        model: 'chat/model',
        provider: 'openrouter',
        overrides: { maxTokens: 6000, contextWindow: 128_000 },
      });
      expect(normalized.modelCatalog?.extraction).toEqual({
        model: 'extract/model',
        provider: 'openrouter',
        overrides: { maxTokens: 2000 },
      });
      expect(normalized.modelRoleAssignments?.chat).toBe('primary');
      expect(normalized.modelRoleAssignments?.extraction).toBe('extraction');
      expect(normalized.modelRoster?.chat?.model).toBe('chat/model');
      expect(normalized.modelRoster?.background?.model).toBe('extract/model');
    });
  });

  describe('applySettings', () => {
    it('mutates config with defined values', () => {
      const config = makeConfig();
      applySettings(config, { primaryModel: 'new-model', primaryMaxTokens: 4096 });
      expect(config.primaryModel).toBe('new-model');
      expect(config.primaryMaxTokens).toBe(4096);
      expect(config.extractionModel).toBe('deepseek/deepseek-v3.2');
    });

    it('does not modify values when settings are empty', () => {
      const config = makeConfig();
      const originalPrimary = config.primaryModel;
      const originalPrimaryMax = config.primaryMaxTokens;
      const originalExtraction = config.extractionModel;
      const originalExtractionMax = config.extractionMaxTokens;
      const originalSessionLimit = config.sessionMessageLimit;
      const originalMemoryLimit = config.memoryRetrievalLimit;
      applySettings(config, {});
      expect(config.primaryModel).toBe(originalPrimary);
      expect(config.primaryMaxTokens).toBe(originalPrimaryMax);
      expect(config.extractionModel).toBe(originalExtraction);
      expect(config.extractionMaxTokens).toBe(originalExtractionMax);
      expect(config.sessionMessageLimit).toBe(originalSessionLimit);
      expect(config.memoryRetrievalLimit).toBe(originalMemoryLimit);
    });

    it('applies all non-model fields', () => {
      const config = makeConfig();
      applySettings(config, {
        sessionHistoryBudgetPct: 8,
        memoryRetrievalBudgetPct: 3,
        sessionMessageLimit: 50,
        memoryRetrievalLimit: 25,
        extractionInterval: 10,
        retryMaxAttempts: 5,
        retryBaseDelayMs: 4000,
      });
      expect(config.sessionHistoryBudgetPct).toBe(8);
      expect(config.memoryRetrievalBudgetPct).toBe(3);
      expect(config.sessionMessageLimit).toBe(50);
      expect(config.memoryRetrievalLimit).toBe(25);
      expect(config.extractionInterval).toBe(10);
      expect(config.retryMaxAttempts).toBe(5);
      expect(config.retryBaseDelayMs).toBe(4000);
    });

    it('keeps chat model roster synchronized with primary settings', () => {
      const config = makeConfig();
      applySettings(config, {
        primaryModel: 'moonshotai/kimi-k2.5',
        primaryProvider: 'openrouter',
        primaryMaxTokens: 4096,
      });

      expect(config.modelRoster.chat).toEqual({
        model: 'moonshotai/kimi-k2.5',
        provider: 'openrouter',
        maxTokens: 4096,
        contextWindow: 128_000,
      });
    });

    it('keeps background model roster synchronized with extraction settings', () => {
      const config = makeConfig();
      applySettings(config, {
        extractionModel: 'openai/gpt-4.1-mini',
        extractionProvider: 'openrouter',
        extractionMaxTokens: 1024,
      });

      expect(config.modelRoster.background).toEqual({
        model: 'openai/gpt-4.1-mini',
        provider: 'openrouter',
        maxTokens: 1024,
      });
    });

    it('resolves role assignments from model catalog and syncs legacy aliases', () => {
      const config = makeConfig();
      applySettings(config, {
        modelCatalog: {
          lowlatency: {
            model: 'openai/gpt-4.1-mini',
            provider: 'openrouter',
            defaults: { maxTokens: 2048, contextWindow: 128_000 },
          },
          extractionx: {
            model: 'deepseek/deepseek-v3.2',
            provider: 'openrouter',
            defaults: { maxTokens: 3072 },
          },
          thinker: {
            model: 'z-ai/glm-5',
            provider: 'openrouter',
            defaults: { maxTokens: 12000, contextWindow: 256_000 },
            overrides: { maxTokens: 10000 },
          },
        },
        modelRoleAssignments: {
          chat: 'lowlatency',
          background: 'extractionx',
          extraction: 'extractionx',
          summary: 'lowlatency',
          reasoning: 'thinker',
          longContext: 'thinker',
        },
      });

      expect(config.primaryModel).toBe('openai/gpt-4.1-mini');
      expect(config.primaryProvider).toBe('openrouter');
      expect(config.primaryMaxTokens).toBe(2048);

      expect(config.extractionModel).toBe('deepseek/deepseek-v3.2');
      expect(config.extractionProvider).toBe('openrouter');
      expect(config.extractionMaxTokens).toBe(3072);

      expect(config.modelRoster.chat).toEqual({
        model: 'openai/gpt-4.1-mini',
        provider: 'openrouter',
        maxTokens: 2048,
        contextWindow: 128_000,
      });
      expect(config.modelRoster.reasoning).toEqual({
        model: 'z-ai/glm-5',
        provider: 'openrouter',
        maxTokens: 10000,
        contextWindow: 256_000,
      });
      expect(config.modelRoster.longContext).toEqual({
        model: 'z-ai/glm-5',
        provider: 'openrouter',
        maxTokens: 10000,
        contextWindow: 256_000,
      });
    });
  });

  describe('round-trip', () => {
    it('save → load → apply preserves role mappings and aliases', () => {
      saveSettings(tempDir, {
        modelCatalog: {
          main: {
            model: 'z-ai/glm-5',
            provider: 'openrouter',
            defaults: { maxTokens: 5000, contextWindow: 140_000 },
          },
          extract: {
            model: 'deepseek/deepseek-v3.2',
            provider: 'openrouter',
            defaults: { maxTokens: 1200 },
          },
        },
        modelRoleAssignments: {
          chat: 'main',
          extraction: 'extract',
          background: 'extract',
          summary: 'main',
        },
      });

      const loaded = loadSettings(tempDir);
      const config = makeConfig();
      applySettings(config, loaded);

      expect(config.primaryModel).toBe('z-ai/glm-5');
      expect(config.primaryMaxTokens).toBe(5000);
      expect(config.extractionModel).toBe('deepseek/deepseek-v3.2');
      expect(config.extractionMaxTokens).toBe(1200);
    });
  });

  describe('parseSettingsForm', () => {
    it('parses valid legacy form data', () => {
      const params = new URLSearchParams({
        primaryModel: 'test-model',
        primaryProvider: 'openrouter',
        primaryMaxTokens: '4096',
        sessionHistoryBudgetPct: '7',
        memoryRetrievalBudgetPct: '3',
        sessionMessageLimit: '50',
        retryMaxAttempts: '4',
      });
      const [settings, errors] = parseSettingsForm(params);
      expect(errors).toEqual([]);
      expect(settings.primaryModel).toBe('test-model');
      expect(settings.primaryMaxTokens).toBe(4096);
      expect(settings.sessionHistoryBudgetPct).toBe(7);
      expect(settings.memoryRetrievalBudgetPct).toBe(3);
      expect(settings.sessionMessageLimit).toBe(50);
      expect(settings.retryMaxAttempts).toBe(4);
      expect(settings.modelCatalog?.primary?.model).toBe('test-model');
    });

    it('parses roster-v2 catalog and role assignment JSON', () => {
      const params = new URLSearchParams({
        modelCatalogJson: JSON.stringify({
          fast: {
            model: 'openai/gpt-4.1-mini',
            provider: 'openrouter',
            defaults: { maxTokens: 2048, contextWindow: 128000 },
            overrides: { maxTokens: 1536 },
          },
          extract: {
            model: 'deepseek/deepseek-v3.2',
            provider: 'openrouter',
            defaults: { maxTokens: 1024 },
          },
        }),
        modelRoleAssignmentsJson: JSON.stringify({
          chat: 'fast',
          extraction: 'extract',
          background: 'extract',
          summary: 'fast',
        }),
      });

      const [settings, errors] = parseSettingsForm(params);
      expect(errors).toEqual([]);
      expect(settings.modelCatalog?.fast?.overrides?.maxTokens).toBe(1536);
      expect(settings.modelRoleAssignments?.chat).toBe('fast');
      expect(settings.primaryModel).toBe('openai/gpt-4.1-mini');
      expect(settings.extractionModel).toBe('deepseek/deepseek-v3.2');
    });

    it('rejects assignment references to unknown slots', () => {
      const params = new URLSearchParams({
        modelCatalogJson: JSON.stringify({
          known: { model: 'z-ai/glm-5', provider: 'openrouter' },
        }),
        modelRoleAssignmentsJson: JSON.stringify({
          chat: 'missing-slot',
        }),
      });
      const [, errors] = parseSettingsForm(params);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('unknown model slot');
    });

    it('rejects out-of-range values', () => {
      const params = new URLSearchParams({
        primaryMaxTokens: '100',
        sessionHistoryBudgetPct: '0',
        sessionMessageLimit: '999',
        retryBaseDelayMs: '100',
      });
      const [, errors] = parseSettingsForm(params);
      expect(errors.length).toBe(4);
      expect(errors.some(err => err.includes('primaryMaxTokens'))).toBe(true);
      expect(errors.some(err => err.includes('sessionHistoryBudgetPct'))).toBe(true);
      expect(errors.some(err => err.includes('sessionMessageLimit'))).toBe(true);
      expect(errors.some(err => err.includes('retryBaseDelayMs'))).toBe(true);
    });

    it('ignores empty string fields', () => {
      const params = new URLSearchParams({
        primaryModel: '',
        primaryMaxTokens: '',
      });
      const [settings, errors] = parseSettingsForm(params);
      expect(errors).toEqual([]);
      expect(settings.primaryModel).toBeUndefined();
      expect(settings.primaryMaxTokens).toBeUndefined();
    });

    it('rejects NaN values', () => {
      const params = new URLSearchParams({
        primaryMaxTokens: 'abc',
      });
      const [, errors] = parseSettingsForm(params);
      expect(errors.length).toBe(1);
    });
  });

  describe('runtime settings snapshot', () => {
    it('returns only safe runtime settings keys', () => {
      const config = makeConfig();
      config.thinkMaxSubQueries = 7;
      const snapshot = getRuntimeSettingsSnapshot(config);
      expect(Object.keys(snapshot).sort()).toEqual([...RUNTIME_SETTINGS_KEYS].sort());
      expect((snapshot as any).discordToken).toBeUndefined();
    });

    it('normalizes optional values to null when unset', () => {
      const config = makeConfig();
      const snapshot = getRuntimeSettingsSnapshot(config);
      expect(snapshot.thinkMaxTokens).toBeNull();
      expect(snapshot.thinkMaxWallTimeMs).toBeNull();
      expect(snapshot.thinkMaxSubQueries).toBeNull();
    });

    it('resolves budget percentages and nullable hard overrides', () => {
      const config = makeConfig();
      config.sessionHistoryBudgetPct = undefined;
      config.memoryRetrievalBudgetPct = undefined;
      config.sessionMessageLimit = undefined;
      config.memoryRetrievalLimit = undefined;

      const snapshot = getRuntimeSettingsSnapshot(config);
      expect(snapshot.sessionHistoryBudgetPct).toBe(6);
      expect(snapshot.memoryRetrievalBudgetPct).toBe(2);
      expect(snapshot.sessionMessageLimit).toBeNull();
      expect(snapshot.memoryRetrievalLimit).toBeNull();
    });

    it('validates setting key membership', () => {
      expect(isRuntimeSettingKey('thinkMaxSubQueries')).toBe(true);
      expect(isRuntimeSettingKey('discordToken')).toBe(false);
    });
  });
});
