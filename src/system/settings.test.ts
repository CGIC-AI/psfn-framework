import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getCachedJsonValueDiagnostics } from './config/load-or-seed.js';
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
import { createDefaultCompositionalPolicyConfig, type SubstrateConfig } from './config/runtime-config-contracts.js';
import type { CanonicalModelRegistry } from '../shared/contracts/runtime.js';
import { registerStreamingSttProvider } from '../primitives/voice/connectors/stt/index.js';
import { registerStreamingTtsProvider } from '../primitives/voice/connectors/tts/index.js';

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
    moodCongruenceWeight: 0.15,
    sessionMessageLimit: 30,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    primaryMaxTokens: 16384,
    extractionMaxTokens: 8192,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    observationMaskingWindow: 1,
    compactionEmotionalSalienceThresholdPct: 75,
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
      memory: 'extraction',
      context: 'extraction',
      extraction: 'extraction',
      summary: 'primary',
      reasoning: 'primary',
      longContext: 'primary',
    },
    modelRoster: {
      chat: { model: 'z-ai/glm-5', provider: 'openrouter', maxTokens: 16384, contextWindow: 128_000 },
      background: { model: 'deepseek/deepseek-v3.2', provider: 'openrouter', maxTokens: 8192 },
      memory: { model: 'deepseek/deepseek-v3.2', provider: 'openrouter', maxTokens: 8192 },
      context: { model: 'deepseek/deepseek-v3.2', provider: 'openrouter', maxTokens: 8192 },
    },
    retryMaxAttempts: 3,
    retryBaseDelayMs: 2000,
    ttsProvider: 'elevenlabs',
    deepgramApiKey: 'deepgram-key',
    deepgramModel: 'nova-3',
    elevenLabsApiKey: 'elevenlabs-key',
    elevenLabsVoiceId: 'voice-id',
    elevenLabsModelId: 'eleven_turbo_v2_5',
    echoTtsUrl: 'http://127.0.0.1:8001/v1/audio/speech',
    echoTtsVoice: 'echo-default',
    echoTtsPreset: 'normal',
  };
}

function makeCanonicalModelRegistry(options?: {
  primaryTuning?: Record<string, unknown>;
  extractionTuning?: Record<string, unknown>;
}): CanonicalModelRegistry {
  return {
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
        tuning: {
          maxOutputTokens: 4096,
          ...(options?.primaryTuning ?? {}),
        },
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
        tuning: {
          maxOutputTokens: 2048,
          ...(options?.extractionTuning ?? {}),
        },
      },
    ],
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
      expect(result.moodCongruenceWeight).toBe(0.15);
      expect(result.extractionInterval).toBe(5);
      expect(result.observationMaskingWindow).toBe(1);
      expect(result.compositionalPolicy).toEqual(createDefaultCompositionalPolicyConfig());
      expect(existsSync(join(tempDir, 'settings.json'))).toBe(true);
    });

    it('fails closed when legacy model fields are present in settings.json', () => {
      const path = join(tempDir, 'settings.json');
      writeFileSync(path, JSON.stringify({
        primaryModel: 'legacy/chat',
        primaryProvider: 'openrouter',
        primaryMaxTokens: 4096,
        extractionModel: 'legacy/extract',
        extractionProvider: 'openrouter',
        extractionMaxTokens: 2048,
      }), 'utf-8');

      expect(() => loadSettings(tempDir)).toThrow('Legacy model settings are not accepted in this slice');
    });

    it('fails closed for invalid JSON', () => {
      const path = join(tempDir, 'settings.json');
      writeFileSync(path, 'not json', 'utf-8');

      expect(() => loadSettings(tempDir)).toThrow('Refusing to reseed invalid JSON config');
      expect(readFileSync(path, 'utf-8')).toBe('not json');
    });

    it('fails closed for array JSON', () => {
      const path = join(tempDir, 'settings.json');
      writeFileSync(path, '[]', 'utf-8');

      expect(() => loadSettings(tempDir)).toThrow('Refusing to reseed invalid JSON config');
      expect(readFileSync(path, 'utf-8')).toBe('[]');
    });

    it('drops removed runtime settings from persisted settings payloads', () => {
      const path = join(tempDir, 'settings.json');
      writeFileSync(path, JSON.stringify({
        sessionHistoryBudgetPct: 7,
        sessionMessageLimit: 44,
        memoryRetrievalLimit: 11,
        memoryBudgetPct: 24,
        defaultContextWindow: 196_000,
        discordEnabled: true,
        discordHeartbeatChannel: '1234567890',
      }), 'utf-8');

      const loaded = loadSettings(tempDir);
      expect(loaded.sessionHistoryBudgetPct).toBe(7);
      expect((loaded as Record<string, unknown>).sessionMessageLimit).toBeUndefined();
      expect((loaded as Record<string, unknown>).memoryRetrievalLimit).toBeUndefined();
      expect((loaded as Record<string, unknown>).memoryBudgetPct).toBeUndefined();
      expect((loaded as Record<string, unknown>).defaultContextWindow).toBeUndefined();
      expect((loaded as Record<string, unknown>).discordEnabled).toBeUndefined();
      expect((loaded as Record<string, unknown>).discordHeartbeatChannel).toBeUndefined();
      expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({
        sessionHistoryBudgetPct: 7,
        sessionMessageLimit: 44,
        memoryRetrievalLimit: 11,
        memoryBudgetPct: 24,
        defaultContextWindow: 196_000,
        discordEnabled: true,
        discordHeartbeatChannel: '1234567890',
      });
    });

    it('migrates persisted settings missing voice provider keys to explicit disabled selections', () => {
      const path = join(tempDir, 'settings.json');
      writeFileSync(path, JSON.stringify({
        voiceEnabled: false,
        voiceId: '',
        extractionInterval: 7,
      }), 'utf-8');

      const loaded = loadSettings(tempDir);
      expect(loaded.ttsProvider).toBe('disabled');
      expect(loaded.sttProvider).toBe('disabled');
      expect(loaded.extractionInterval).toBe(7);

      const config = makeConfig();
      applySettings(config, loaded);
      expect(config.ttsProvider).toBe('disabled');
      expect(config.sttProvider).toBe('disabled');
    });

    it('returns cached settings on repeated reads without re-reading disk', () => {
      const path = join(tempDir, 'settings.json');
      saveSettings(tempDir, { extractionInterval: 6 });

      expect(loadSettings(tempDir).extractionInterval).toBe(6);
      expect(loadSettings(tempDir).extractionInterval).toBe(6);

      expect(getCachedJsonValueDiagnostics(path)).toEqual({
        hits: 2,
        misses: 0,
        hasCachedValue: true,
      });
    });

    it('refreshes the cache on save so subsequent reads use the new value without re-reading disk', () => {
      const path = join(tempDir, 'settings.json');
      saveSettings(tempDir, { extractionInterval: 4 });
      expect(loadSettings(tempDir).extractionInterval).toBe(4);

      const before = getCachedJsonValueDiagnostics(path);
      saveSettings(tempDir, { extractionInterval: 9 });

      expect(loadSettings(tempDir).extractionInterval).toBe(9);
      expect(loadSettings(tempDir).extractionInterval).toBe(9);

      expect(getCachedJsonValueDiagnostics(path)).toEqual({
        hits: before.hits + 2,
        misses: before.misses,
        hasCachedValue: true,
      });
    });

    it('invalidates the cache when settings.json changes on disk outside the runtime', () => {
      const path = join(tempDir, 'settings.json');
      saveSettings(tempDir, { extractionInterval: 7 });
      const before = getCachedJsonValueDiagnostics(path);

      writeFileSync(path, JSON.stringify({ extractionInterval: 11 }), 'utf-8');

      expect(loadSettings(tempDir).extractionInterval).toBe(11);
      expect(loadSettings(tempDir).extractionInterval).toBe(11);

      expect(getCachedJsonValueDiagnostics(path)).toEqual({
        hits: before.hits + 1,
        misses: before.misses + 1,
        hasCachedValue: true,
      });
    });

    it('fails closed when an external disk change makes persisted settings invalid', () => {
      const path = join(tempDir, 'settings.json');
      saveSettings(tempDir, { extractionInterval: 5 });
      const before = getCachedJsonValueDiagnostics(path);

      writeFileSync(path, 'not json', 'utf-8');

      expect(() => loadSettings(tempDir)).toThrow('Refusing to reseed invalid JSON config');
      expect(readFileSync(path, 'utf-8')).toBe('not json');
      expect(getCachedJsonValueDiagnostics(path)).toEqual({
        hits: before.hits,
        misses: before.misses + 1,
        hasCachedValue: false,
      });
    });
  });

  describe('saveSettings', () => {
    it('writes runtime settings atomically', () => {
      const settings = {
        extractionInterval: 10,
      };
      saveSettings(tempDir, settings);

      const raw = readFileSync(join(tempDir, 'settings.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.primaryModel).toBeUndefined();
      expect(parsed.modelRegistry).toBeUndefined();
      expect(parsed.modelCatalog).toBeUndefined();
      expect(parsed.modelRoleAssignments).toBeUndefined();
      expect(parsed.extractionInterval).toBe(10);
    });

    it('fails closed when asked to persist owner-file settings keys', () => {
      expect(() => saveSettings(tempDir, {
        modelRegistry: makeCanonicalModelRegistry(),
      })).toThrow(
        'Refusing to save non-runtime keys to settings.json: modelRegistry',
      );

      expect(() => saveSettings(tempDir, {
        maintenanceIntervalMs: 120_000,
        capabilityTier: 'autonomous',
      })).toThrow(
        'Refusing to save non-runtime keys to settings.json: maintenanceIntervalMs, capabilityTier',
      );
    });

    it('round-trips the audited runtime owner-file fields through settings.json', () => {
      const settings = {
        sessionMirrorEnabled: false,
        sessionMirrorMaxChars: 512,
        sessionMirrorActiveWindowMs: 42_000,
        sessionMirrorChannelOverrides: {
          discord: false,
        },
        continuityMessageLimit: 7,
        voiceEnabled: true,
        voiceTargetGuildId: 'guild-123',
        voiceTargetUserId: 'user-456',
        voiceReadyCueText: 'ready',
        wyomingShardRouting: {
          enabled: true,
          siteAllowlist: ['site-a'],
        },
        shardToolsets: {
          nursery: ['tool-a'],
        },
      };

      saveSettings(tempDir, settings);

      expect(loadSettings(tempDir)).toMatchObject(settings);
    });

    it('creates data dir if missing', () => {
      const nested = join(tempDir, 'sub', 'dir');
      saveSettings(nested, { extractionInterval: 4 });
      expect(existsSync(join(nested, 'settings.json'))).toBe(true);
    });

    it('no .tmp file remains after save', () => {
      saveSettings(tempDir, { extractionInterval: 6 });
      expect(existsSync(join(tempDir, 'settings.json.tmp'))).toBe(false);
    });
  });

  describe('normalizeEditableSettings', () => {
    it('projects canonical modelRegistry into compatibility fields', () => {
      const normalized = normalizeEditableSettings({
        modelRegistry: {
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
                { purpose: 'background', primary: true },
                { purpose: 'extraction', primary: true },
                { purpose: 'import_processing', primary: true },
              ],
              capabilities: { maxOutputTokens: 2048, contextWindow: 128_000 },
              tuning: { maxOutputTokens: 2048 },
            },
          ],
        },
      }, {
        defaultContextWindow: 128_000,
      });

      expect(normalized.modelRoleAssignments?.chat).toBe('primary');
      expect(normalized.modelRoleAssignments?.background).toBe('extraction');
      expect(normalized.modelRoleAssignments?.memory).toBe('extraction');
      expect(normalized.modelRoleAssignments?.context).toBe('extraction');
      expect(normalized.modelRoleAssignments?.moa).toBe('primary');
      expect(normalized.modelRoster?.chat?.model).toBe('openai/gpt-4.1-mini');
      expect(normalized.modelRoster?.background?.model).toBe('deepseek/deepseek-v3.2');
      expect(normalized.modelRoster?.memory?.model).toBe('deepseek/deepseek-v3.2');
      expect(normalized.primaryModel).toBe('openai/gpt-4.1-mini');
      expect(normalized.extractionModel).toBe('deepseek/deepseek-v3.2');
    });

    it('clamps profile synthesis source memory limit to the minimum source-memory threshold', () => {
      const normalized = normalizeEditableSettings({
        profileSynthesisSourceMemoryLimit: 16,
        profileSynthesisMinSourceMemories: 20,
      });

      expect(normalized.profileSynthesisSourceMemoryLimit).toBe(20);
      expect(normalized.profileSynthesisMinSourceMemories).toBe(20);
    });

    it('fails closed for legacy model fields without canonical modelRegistry', () => {
      expect(() => normalizeEditableSettings({
        primaryModel: 'legacy/chat',
        primaryProvider: 'openrouter',
        primaryMaxTokens: 4096,
      })).toThrow('Legacy model settings are not accepted in this slice');
    });

    it('fails closed when canonical registry violates one-primary-per-purpose', () => {
      expect(() => normalizeEditableSettings({
        modelRegistry: {
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
                { purpose: 'extraction', primary: true },
                { purpose: 'import_processing', primary: true },
              ],
              capabilities: { maxOutputTokens: 2048, contextWindow: 128_000 },
              tuning: { maxOutputTokens: 2048 },
            },
          ],
        },
      })).toThrow('must have exactly one primary model');
    });

    it('accepts canonical budget policy and preserves it under modelRegistry', () => {
      const normalized = normalizeEditableSettings({
        modelRegistry: {
          schemaVersion: 1,
          budgetPolicy: {
            enabled: true,
            dailyUsdLimit: 2.5,
            monthlyUsdLimit: 40,
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
                { purpose: 'extraction', primary: true },
                { purpose: 'import_processing', primary: true },
              ],
              capabilities: { maxOutputTokens: 2048, contextWindow: 128_000 },
              tuning: { maxOutputTokens: 2048 },
            },
          ],
        },
      });

      expect(normalized.modelRegistry?.budgetPolicy).toEqual({
        enabled: true,
        dailyUsdLimit: 2.5,
        monthlyUsdLimit: 40,
        currency: 'USD',
      });
    });

    it('fails closed for invalid canonical budget policy', () => {
      expect(() => normalizeEditableSettings({
        modelRegistry: {
          schemaVersion: 1,
          budgetPolicy: {
            enabled: true,
            dailyUsdLimit: 50,
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
                { purpose: 'extraction', primary: true },
                { purpose: 'import_processing', primary: true },
              ],
              capabilities: { maxOutputTokens: 2048, contextWindow: 128_000 },
              tuning: { maxOutputTokens: 2048 },
            },
          ],
        },
      })).toThrow('monthlyUsdLimit must be >= dailyUsdLimit');
    });

    it('normalizes tuning knob aliases and thinking controls', () => {
      const normalized = normalizeEditableSettings({
        modelRegistry: makeCanonicalModelRegistry({
          primaryTuning: {
            temperature: '0.7',
            top_p: '0.86',
            top_k: '40',
            frequency_penalty: '-0.4',
            repetition_penalty: '1.2',
            thinking: {
              enabled: 'true',
              effort: 'HIGH',
              budget_tokens: '2048',
            },
          },
        }),
      });

      const primaryTuning = normalized.modelRegistry?.models.find(model => model.id === 'primary')?.tuning;
      expect(primaryTuning?.temperature).toBe(0.7);
      expect(primaryTuning?.topP).toBe(0.86);
      expect(primaryTuning?.topK).toBe(40);
      expect(primaryTuning?.frequencyPenalty).toBe(-0.4);
      expect(primaryTuning?.repetitionPenalty).toBe(1.2);
      expect(primaryTuning?.thinkingEnabled).toBe(true);
      expect(primaryTuning?.thinkingEffort).toBe('high');
      expect(primaryTuning?.thinkingBudgetTokens).toBe(2048);
      expect(primaryTuning?.top_p).toBeUndefined();
      expect(primaryTuning?.top_k).toBeUndefined();
      expect(primaryTuning?.frequency_penalty).toBeUndefined();
      expect(primaryTuning?.repetition_penalty).toBeUndefined();
      expect(primaryTuning?.thinking).toBeUndefined();
    });

    it('fails closed for out-of-range tuning knob values', () => {
      expect(() => normalizeEditableSettings({
        modelRegistry: makeCanonicalModelRegistry({
          primaryTuning: { temperature: 2.1 },
        }),
      })).toThrow('settings.modelRegistry.models[0].tuning.temperature');

      expect(() => normalizeEditableSettings({
        modelRegistry: makeCanonicalModelRegistry({
          primaryTuning: { topP: -0.1 },
        }),
      })).toThrow('settings.modelRegistry.models[0].tuning.topP');

      expect(() => normalizeEditableSettings({
        modelRegistry: makeCanonicalModelRegistry({
          primaryTuning: { topK: 0 },
        }),
      })).toThrow('settings.modelRegistry.models[0].tuning.topK');

      expect(() => normalizeEditableSettings({
        modelRegistry: makeCanonicalModelRegistry({
          primaryTuning: { frequencyPenalty: -2.5 },
        }),
      })).toThrow('settings.modelRegistry.models[0].tuning.frequencyPenalty');

      expect(() => normalizeEditableSettings({
        modelRegistry: makeCanonicalModelRegistry({
          primaryTuning: { repetitionPenalty: 2.5 },
        }),
      })).toThrow('settings.modelRegistry.models[0].tuning.repetitionPenalty');

      expect(() => normalizeEditableSettings({
        modelRegistry: makeCanonicalModelRegistry({
          primaryTuning: { thinkingBudgetTokens: 0 },
        }),
      })).toThrow('settings.modelRegistry.models[0].tuning.thinkingBudgetTokens');
    });

    it('fails closed for malformed tuning knob payloads', () => {
      expect(() => normalizeEditableSettings({
        modelRegistry: makeCanonicalModelRegistry({
          primaryTuning: { temperature: 'warm' },
        }),
      })).toThrow('settings.modelRegistry.models[0].tuning.temperature');

      expect(() => normalizeEditableSettings({
        modelRegistry: makeCanonicalModelRegistry({
          primaryTuning: { top_k: '10.5' },
        }),
      })).toThrow('settings.modelRegistry.models[0].tuning.topK');

      expect(() => normalizeEditableSettings({
        modelRegistry: makeCanonicalModelRegistry({
          primaryTuning: { thinkingEnabled: 'sometimes' },
        }),
      })).toThrow('settings.modelRegistry.models[0].tuning.thinkingEnabled');

      expect(() => normalizeEditableSettings({
        modelRegistry: makeCanonicalModelRegistry({
          primaryTuning: { thinkingEffort: 'extreme' },
        }),
      })).toThrow('settings.modelRegistry.models[0].tuning.thinkingEffort');

      expect(() => normalizeEditableSettings({
        modelRegistry: makeCanonicalModelRegistry({
          primaryTuning: { thinking: [] },
        }),
      })).toThrow('settings.modelRegistry.models[0].tuning.thinking');
    });
  });

  describe('applySettings', () => {
    it('mutates config with defined values', () => {
      const config = makeConfig();
      applySettings(config, {
        extractionInterval: 9,
        extractionThresholdPct: 34,
        compactionThresholdPct: 76,
      });
      expect(config.extractionInterval).toBe(9);
      expect(config.extractionThresholdPct).toBe(34);
      expect(config.compactionThresholdPct).toBe(76);
    });

    it('does not modify values when settings are empty', () => {
      const config = makeConfig();
      const originalPrimary = config.primaryModel;
      const originalPrimaryMax = config.primaryMaxTokens;
      const originalExtraction = config.extractionModel;
      const originalExtractionMax = config.extractionMaxTokens;
      const originalMemoryLimit = config.memoryRetrievalLimit;
      applySettings(config, {});
      expect(config.primaryModel).toBe(originalPrimary);
      expect(config.primaryMaxTokens).toBe(originalPrimaryMax);
      expect(config.extractionModel).toBe(originalExtraction);
      expect(config.extractionMaxTokens).toBe(originalExtractionMax);
      expect(config.memoryRetrievalLimit).toBe(originalMemoryLimit);
    });

    it('applies all non-model fields', () => {
      const config = makeConfig();
      applySettings(config, {
        sessionHistoryBudgetPct: 8,
        memoryRetrievalBudgetPct: 3,
        moodCongruenceWeight: 0.4,
        adaptiveContextBudgetsEnabled: true,
        sessionRestartBehavior: 'new_session',
        extractionInterval: 10,
        compactionEmotionalSalienceThresholdPct: 55,
        retryMaxAttempts: 5,
        retryBaseDelayMs: 4000,
      });
      expect(config.sessionHistoryBudgetPct).toBe(8);
      expect(config.memoryRetrievalBudgetPct).toBe(3);
      expect(config.moodCongruenceWeight).toBe(0.4);
      expect(config.adaptiveContextBudgetsEnabled).toBe(true);
      expect(config.sessionRestartBehavior).toBe('new_session');
      expect(config.extractionInterval).toBe(10);
      expect(config.compactionEmotionalSalienceThresholdPct).toBe(55);
      expect(config.retryMaxAttempts).toBe(5);
      expect(config.retryBaseDelayMs).toBe(4000);
    });

    it('normalizes promotedExtendedTools with de-duplication and max slot bound', () => {
      const config = makeConfig();
      applySettings(config, {
        promotedExtendedTools: [
          'repo_status',
          'session_list',
          'repo_status',
          'prompt_layer_list',
          'settings_get',
          'contact_lookup',
        ],
      });

      expect(config.promotedExtendedTools).toEqual([
        'repo_status',
        'session_list',
        'prompt_layer_list',
        'settings_get',
      ]);
    });

    it('applies compositional policy with fail-closed normalization', () => {
      const config = makeConfig();
      applySettings(config, {
        compositionalPolicy: {
          enabled: true,
          allowedTiers: ['autonomous', 'autonomous', 'bogus'],
          allowedChannelTypes: ['api', 'discord', 'bogus'],
          allowedPurposes: ['retrieval', 'retrieval', 'bogus'],
        } as any,
      });

      expect(config.compositionalPolicy).toEqual({
        enabled: true,
        allowedTiers: ['autonomous'],
        allowedChannelTypes: ['api', 'discord'],
        allowedPurposes: ['retrieval'],
      });
    });

    it('applies import-processing routing controls', () => {
      const config = makeConfig({
        openRouterProviderOrder: ['openai'],
        importProcessingRouteMode: 'background',
        importProcessingStrictPolicy: false,
        importProcessingLocalEndpointUrl: 'http://localhost:11434/v1',
        importProcessingLocalModel: 'llama3.2:latest',
      });

      applySettings(config, {
        openRouterProviderOrder: ['parasail', 'openai'],
        importProcessingRouteMode: 'openrouter_zdr',
        importProcessingStrictPolicy: true,
        importProcessingLocalEndpointUrl: 'http://localhost:8080/v1',
        importProcessingLocalModel: 'custom/model',
      });

      expect(config.openRouterProviderOrder).toEqual(['parasail', 'openai']);
      expect(config.importProcessingRouteMode).toBe('openrouter_zdr');
      expect(config.importProcessingStrictPolicy).toBe(true);
      expect(config.importProcessingLocalEndpointUrl).toBe('http://localhost:8080/v1');
      expect(config.importProcessingLocalModel).toBe('custom/model');
    });

    it('applies web fetch lane controls', () => {
      const config = makeConfig();
      applySettings(config, {
        webFetchAllowHttp: true,
        webFetchDomainAllowlist: ['example.com', 'docs.example.com'],
        webFetchLocalCrawlerEnabled: true,
        webFetchLocalCrawlerAllowHttp: true,
        webFetchLocalCrawlerHostAllowlist: ['localhost', '127.0.0.1'],
        webFetchLocalCrawlerDomainAllowlist: ['crawler.local'],
        webFetchTlsCaCertPaths: ['/etc/ssl/local-root.pem'],
      });

      expect(config.webFetchAllowHttp).toBe(true);
      expect(config.webFetchDomainAllowlist).toEqual(['example.com', 'docs.example.com']);
      expect(config.webFetchLocalCrawlerEnabled).toBe(true);
      expect(config.webFetchLocalCrawlerAllowHttp).toBe(true);
      expect(config.webFetchLocalCrawlerHostAllowlist).toEqual(['localhost', '127.0.0.1']);
      expect(config.webFetchLocalCrawlerDomainAllowlist).toEqual(['crawler.local']);
      expect(config.webFetchTlsCaCertPaths).toEqual(['/etc/ssl/local-root.pem']);
    });

    it('applies canonical modelRegistry and projects compatibility model fields', () => {
      const config = makeConfig();
      applySettings(config, {
        modelRegistry: {
          schemaVersion: 1,
          models: [
            {
              id: 'chatfast',
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
              capabilities: { maxOutputTokens: 2048, contextWindow: 128_000 },
              tuning: { maxOutputTokens: 2048 },
            },
            {
              id: 'extract',
              rank: 80,
              identity: {
                model: 'deepseek/deepseek-v3.2',
                provider: 'openrouter',
                source: { type: 'openrouter' },
              },
              purposes: [
                { purpose: 'background', primary: true },
                { purpose: 'extraction', primary: true },
                { purpose: 'import_processing', primary: true },
              ],
              capabilities: { maxOutputTokens: 3072, contextWindow: 128_000 },
              tuning: { maxOutputTokens: 3072 },
            },
          ],
        },
      });

      expect(config.primaryModel).toBe('openai/gpt-4.1-mini');
      expect(config.primaryMaxTokens).toBe(2048);
      expect(config.extractionModel).toBe('deepseek/deepseek-v3.2');
      expect(config.extractionMaxTokens).toBe(3072);
      expect(config.modelRoleAssignments?.chat).toBe('chatfast');
      expect(config.modelRoleAssignments?.background).toBe('extract');
      expect(config.modelRoleAssignments?.memory).toBe('extract');
      expect(config.modelRoster.chat?.model).toBe('openai/gpt-4.1-mini');
      expect(config.modelRoster.background?.model).toBe('deepseek/deepseek-v3.2');
      expect(config.modelRoster.memory?.model).toBe('deepseek/deepseek-v3.2');
      expect(config.modelRegistry?.models).toHaveLength(2);
    });

    it('fails closed when applySettings receives legacy model payloads', () => {
      const config = makeConfig();
      expect(() => applySettings(config, {
        modelCatalog: {
          primary: {
            model: 'openai/gpt-4.1-mini',
            provider: 'openrouter',
            defaults: { maxTokens: 2048 },
          },
        },
      })).toThrow('Legacy model settings payloads are unsupported');
    });

    it('applies explicit voice provider settings including disabled providers', () => {
      const config = makeConfig();
      applySettings(config, {
        ttsProvider: 'disabled',
        sttProvider: 'disabled',
      });

      expect((config as SubstrateConfig & { ttsProvider?: string }).ttsProvider).toBe('disabled');
      expect((config as SubstrateConfig & { sttProvider?: string }).sttProvider).toBe('disabled');
    });

    it('applies memory extraction emotional intensity weight when provided', () => {
      const config = makeConfig();
      applySettings(config, {
        memoryExtractionEmotionalIntensityWeight: 0.35,
      });

      expect(config.memoryExtractionEmotionalIntensityWeight).toBe(0.35);
    });

    it('preserves plugin STT provider ids without core switch edits', () => {
      const config = makeConfig();
      applySettings(config, {
        sttProvider: 'plugin-test',
      });

      expect((config as SubstrateConfig & { sttProvider?: string }).sttProvider).toBe('plugin-test');
    });

    it('preserves plugin TTS provider ids without core switch edits', () => {
      const config = makeConfig();
      applySettings(config, {
        ttsProvider: 'plugin-test',
      });

      expect((config as SubstrateConfig & { ttsProvider?: string }).ttsProvider).toBe('plugin-test');
    });

    it('clears voice override fields when empty strings are provided', () => {
      const config = makeConfig();
      applySettings(config, {
        voiceId: '',
        echoTtsUrl: '',
        echoTtsVoice: '',
        echoTtsPreset: '',
        deepgramModel: '',
      });

      expect(config.elevenLabsVoiceId).toBeUndefined();
      expect(config.echoTtsUrl).toBeUndefined();
      expect(config.echoTtsVoice).toBeUndefined();
      expect(config.echoTtsPreset).toBeUndefined();
      expect(config.deepgramModel).toBeUndefined();
    });
  });

  describe('round-trip', () => {
    it('save → load → apply fails closed when runtime settings payload includes model fields', () => {
      saveSettings(tempDir, {
        extractionInterval: 9,
      });

      const loaded = loadSettings(tempDir);
      const config = makeConfig();
      applySettings(config, loaded);

      expect(loaded.modelCatalog).toBeUndefined();
      expect(loaded.modelRoleAssignments).toBeUndefined();
      expect(loaded.modelRegistry).toBeUndefined();
      expect(config.extractionInterval).toBe(9);
      expect(config.primaryModel).toBe('z-ai/glm-5');
      expect(config.primaryMaxTokens).toBe(16384);
      expect(config.extractionModel).toBe('deepseek/deepseek-v3.2');
      expect(config.extractionMaxTokens).toBe(8192);
    });

    it('save → load → apply preserves explicitly cleared voice fields', () => {
      saveSettings(tempDir, {
        ttsProvider: 'disabled',
        sttProvider: 'disabled',
        voiceId: '',
        echoTtsUrl: '',
        echoTtsVoice: '',
        echoTtsPreset: '',
        deepgramModel: '',
      });

      const loaded = loadSettings(tempDir);
      expect(loaded.ttsProvider).toBe('disabled');
      expect(loaded.sttProvider).toBe('disabled');
      expect(loaded.voiceId).toBe('');
      expect(loaded.echoTtsUrl).toBe('');
      expect(loaded.echoTtsVoice).toBe('');
      expect(loaded.echoTtsPreset).toBe('');
      expect(loaded.deepgramModel).toBe('');

      const config = makeConfig();
      applySettings(config, loaded);
      expect((config as SubstrateConfig & { ttsProvider?: string }).ttsProvider).toBe('disabled');
      expect((config as SubstrateConfig & { sttProvider?: string }).sttProvider).toBe('disabled');
      expect(config.elevenLabsVoiceId).toBeUndefined();
      expect(config.echoTtsUrl).toBeUndefined();
      expect(config.echoTtsVoice).toBeUndefined();
      expect(config.echoTtsPreset).toBeUndefined();
      expect(config.deepgramModel).toBeUndefined();
    });

    it('save → load → apply preserves plugin STT provider ids', () => {
      saveSettings(tempDir, {
        sttProvider: 'plugin-test',
      });

      const loaded = loadSettings(tempDir);
      expect(loaded.sttProvider).toBe('plugin-test');

      const config = makeConfig();
      applySettings(config, loaded);
      expect((config as SubstrateConfig & { sttProvider?: string }).sttProvider).toBe('plugin-test');
    });

    it('save → load → apply preserves plugin TTS provider ids', () => {
      saveSettings(tempDir, {
        ttsProvider: 'plugin-test',
      });

      const loaded = loadSettings(tempDir);
      expect(loaded.ttsProvider).toBe('plugin-test');

      const config = makeConfig();
      applySettings(config, loaded);
      expect((config as SubstrateConfig & { ttsProvider?: string }).ttsProvider).toBe('plugin-test');
    });

    it('save → load preserves the runtime owner file without drifting fields across subsystems', () => {
      const expected = {
        sessionHistoryBudgetPct: 9,
        memoryRetrievalBudgetPct: 4,
        sessionRestartBehavior: 'new_session' as const,
        extractionInterval: 6,
        extractionThresholdPct: 34,
        compactionThresholdPct: 76,
        observationMaskingWindow: 12,
        compactionEmotionalSalienceThresholdPct: 83,
        memoryExtractionMinImportance: 0.35,
        memoryExtractionMinConfidence: 0.45,
        memoryExtractionMinNovelty: 0.25,
        memoryExtractionEmotionalIntensityWeight: 0.15,
        memoryExtractionMaxWrites: 8,
        memoryExtractionTelemetryEnabled: true,
        memoryRetrievalTelemetryEnabled: true,
        profileSynthesisEnabled: true,
        profileSynthesisRefreshIntervalMs: 600_000,
        profileSynthesisCooldownMs: 90_000,
        profileSynthesisMinWrites: 6,
        profileSynthesisMinImportance: 0.4,
        profileSynthesisMinConfidence: 0.5,
        profileSynthesisMinNovelty: 0.3,
        profileSynthesisSourceMemoryLimit: 18,
        profileSynthesisMinSourceMemories: 4,
        thinkMaxTokens: 8_192,
        thinkMaxWallTimeMs: 45_000,
        thinkMaxSubQueries: 5,
        retryMaxAttempts: 4,
        retryBaseDelayMs: 2_500,
        openRouterProviderOrder: ['parasail', 'openai'],
        importProcessingRouteMode: 'local_endpoint' as const,
        importProcessingStrictPolicy: true,
        importProcessingLocalEndpointUrl: 'http://127.0.0.1:4000/v1',
        importProcessingLocalModel: 'llama.cpp/local',
        compositionalPolicy: {
          enabled: true,
          allowedTiers: ['autonomous'],
          allowedChannelTypes: ['api', 'discord'],
          allowedPurposes: ['retrieval', 'think'],
        },
        webFetchAllowHttp: true,
        webFetchDomainAllowlist: ['example.com', 'internal.local'],
        webFetchAllowInternalNetwork: true,
        webFetchTlsCaCertPaths: ['/tmp/root-ca.pem'],
        promotedExtendedTools: ['memory.search', 'contacts.lookup'],
        chatApiBaseUrl: 'https://admin.example.test/api',
        ttsProvider: 'disabled' as const,
        voiceId: '',
        echoTtsUrl: 'http://127.0.0.1:8001/v1/audio/speech',
        echoTtsVoice: 'allison',
        echoTtsPreset: 'wide',
        sttProvider: 'disabled' as const,
        deepgramModel: '',
        discordTriggerWords: 'pixie, hello companion',
        discordTriggerReactions: '👆, 🔥',
        discordTriggerListenWindowMs: 180_000,
        telegramEnabled: true,
        telegramAuthorizedUsers: '123, 456',
        obsidianVaultName: 'companion',
        obsidianCliPath: '/usr/local/bin/obsidian',
        obsidianAutoPublish: true,
        obsidianTimeoutMs: 12_000,
        moaEnabled: true,
        moaReferenceModels: ['openai/gpt-4.1-mini', 'moonshotai/kimi-k2.5'],
        moaAggregatorModel: 'openai/gpt-4.1-mini',
        moaMaxRounds: 3,
        moaMaxTokensPerRound: 2_048,
        moaTimeoutMs: 30_000,
      };

      saveSettings(tempDir, expected);

      const persisted = JSON.parse(readFileSync(join(tempDir, 'settings.json'), 'utf-8'));
      const loaded = loadSettings(tempDir);

      expect(persisted).toEqual(expected);
      expect(loaded).toEqual(expected);
      expect(persisted.primaryModel).toBeUndefined();
      expect(persisted.maintenanceIntervalMs).toBeUndefined();
      expect(persisted.capabilityTier).toBeUndefined();
    });
  });

  describe('voice settings normalization', () => {
    it('preserves empty voice strings as explicit clear values', () => {
      const normalized = normalizeEditableSettings({
        voiceId: ' ',
        echoTtsUrl: ' ',
        echoTtsVoice: ' ',
        echoTtsPreset: ' ',
        deepgramModel: ' ',
      });

      expect(normalized.voiceId).toBe('');
      expect(normalized.echoTtsUrl).toBe('');
      expect(normalized.echoTtsVoice).toBe('');
      expect(normalized.echoTtsPreset).toBe('');
      expect(normalized.deepgramModel).toBe('');
    });
  });

  describe('parseSettingsForm', () => {
    it('fails closed for legacy model form fields', () => {
      const params = new URLSearchParams({
        primaryModel: 'test-model',
        primaryProvider: 'openrouter',
        primaryMaxTokens: '4096',
        sessionHistoryBudgetPct: '7',
        memoryRetrievalBudgetPct: '3',
        moodCongruenceWeight: '0.35',
        retryMaxAttempts: '4',
      });
      const [settings, errors] = parseSettingsForm(params);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('Legacy model settings');
      expect(settings.primaryModel).toBeUndefined();
      expect(settings.primaryMaxTokens).toBe(4096);
    });

    it('rejects removed context control form fields', () => {
      const params = new URLSearchParams({
        sessionMessageLimit: '50',
        memoryRetrievalLimit: '25',
      });

      const [, errors] = parseSettingsForm(params);

      expect(errors).toEqual(expect.arrayContaining([
        'sessionMessageLimit has been removed; session history now trims by token budget only',
        'memoryRetrievalLimit has been removed; memory retrieval now trims by token budget only',
      ]));
    });

    it('parses canonical model registry JSON', () => {
      const params = new URLSearchParams({
        modelRegistryJson: JSON.stringify({
          schemaVersion: 1,
          models: [
            {
              id: 'fast',
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
              capabilities: { maxOutputTokens: 2048, contextWindow: 128000 },
              tuning: { maxOutputTokens: 1536 },
            },
            {
              id: 'extract',
              rank: 80,
              identity: {
                model: 'deepseek/deepseek-v3.2',
                provider: 'openrouter',
                source: { type: 'openrouter' },
              },
              purposes: [
                { purpose: 'background', primary: true },
                { purpose: 'extraction', primary: true },
                { purpose: 'import_processing', primary: true },
              ],
              capabilities: { maxOutputTokens: 1024, contextWindow: 128000 },
              tuning: { maxOutputTokens: 1024 },
            },
          ],
        }),
      });

      const [settings, errors] = parseSettingsForm(params);
      expect(errors).toEqual([]);
      expect(settings.modelRegistry?.models[0]?.id).toBe('fast');
      expect(settings.modelCatalog?.fast.overrides?.maxTokens).toBe(1536);
      expect(settings.modelRoleAssignments?.chat).toBe('fast');
      expect(settings.modelRoleAssignments?.context).toBe('extract');
      expect(settings.primaryModel).toBe('openai/gpt-4.1-mini');
      expect(settings.extractionModel).toBe('deepseek/deepseek-v3.2');
    });

    it('normalizes model tuning knobs from modelRegistryJson', () => {
      const params = new URLSearchParams({
        modelRegistryJson: JSON.stringify(makeCanonicalModelRegistry({
          primaryTuning: {
            temperature: '0.6',
            top_p: '0.9',
            top_k: '32',
            frequency_penalty: '0.1',
            repetition_penalty: '1.1',
            reasoning: {
              effort: 'medium',
              max_tokens: '768',
              enabled: 'true',
            },
          },
        })),
      });

      const [settings, errors] = parseSettingsForm(params);
      expect(errors).toEqual([]);
      const primaryTuning = settings.modelRegistry?.models.find(model => model.id === 'primary')?.tuning;
      expect(primaryTuning?.temperature).toBe(0.6);
      expect(primaryTuning?.topP).toBe(0.9);
      expect(primaryTuning?.topK).toBe(32);
      expect(primaryTuning?.frequencyPenalty).toBe(0.1);
      expect(primaryTuning?.repetitionPenalty).toBe(1.1);
      expect(primaryTuning?.thinkingEffort).toBe('medium');
      expect(primaryTuning?.thinkingBudgetTokens).toBe(768);
      expect(primaryTuning?.thinkingEnabled).toBe(true);
      expect(primaryTuning?.reasoning).toBeUndefined();
    });

    it('parses import-processing routing controls', () => {
      const params = new URLSearchParams({
        importProcessingRouteMode: 'openrouter_zdr',
        importProcessingStrictPolicy: 'true',
        openRouterProviderOrder: 'parasail, openai, parasail',
        importProcessingLocalEndpointUrl: 'http://localhost:11434/v1',
        importProcessingLocalModel: 'llama3.2:latest',
      });

      const [settings, errors] = parseSettingsForm(params);
      expect(errors).toEqual([]);
      expect(settings.importProcessingRouteMode).toBe('openrouter_zdr');
      expect(settings.importProcessingStrictPolicy).toBe(true);
      expect(settings.openRouterProviderOrder).toEqual(['parasail', 'openai']);
      expect(settings.importProcessingLocalEndpointUrl).toBe('http://localhost:11434/v1');
      expect(settings.importProcessingLocalModel).toBe('llama3.2:latest');
    });

    it('parses adaptive context budget toggle', () => {
      const params = new URLSearchParams({
        adaptiveContextBudgetsEnabled: 'true',
      });

      const [settings, errors] = parseSettingsForm(params);
      expect(errors).toEqual([]);
      expect(settings.adaptiveContextBudgetsEnabled).toBe(true);
    });

    it('rejects invalid adaptive context budget toggle value', () => {
      const params = new URLSearchParams({
        adaptiveContextBudgetsEnabled: 'sometimes',
      });

      const [, errors] = parseSettingsForm(params);
      expect(errors).toContain('adaptiveContextBudgetsEnabled must be true or false');
    });

    it('parses web fetch lane controls', () => {
      const params = new URLSearchParams({
        webFetchAllowHttp: 'false',
        webFetchDomainAllowlist: 'example.com, docs.example.com, example.com',
        webFetchLocalCrawlerEnabled: 'true',
        webFetchLocalCrawlerAllowHttp: 'true',
        webFetchLocalCrawlerHostAllowlist: 'localhost,127.0.0.1',
        webFetchLocalCrawlerDomainAllowlist: 'crawler.local',
        webFetchTlsCaCertPaths: '/etc/ssl/root.pem,/etc/ssl/intermediate.pem',
      });

      const [settings, errors] = parseSettingsForm(params);
      expect(errors).toEqual([]);
      expect(settings.webFetchAllowHttp).toBe(false);
      expect(settings.webFetchDomainAllowlist).toEqual(['example.com', 'docs.example.com']);
      expect(settings.webFetchLocalCrawlerEnabled).toBe(true);
      expect(settings.webFetchLocalCrawlerAllowHttp).toBe(true);
      expect(settings.webFetchLocalCrawlerHostAllowlist).toEqual(['localhost', '127.0.0.1']);
      expect(settings.webFetchLocalCrawlerDomainAllowlist).toEqual(['crawler.local']);
      expect(settings.webFetchTlsCaCertPaths).toEqual(['/etc/ssl/root.pem', '/etc/ssl/intermediate.pem']);
    });

    it('requires allowlist when local crawler lane is enabled', () => {
      const params = new URLSearchParams({
        webFetchLocalCrawlerEnabled: 'true',
      });
      const [, errors] = parseSettingsForm(params);
      expect(errors).toContain('webFetchLocalCrawlerEnabled requires host/domain allowlist');
    });

    it('requires local endpoint fields when local import route mode is selected', () => {
      const params = new URLSearchParams({
        importProcessingRouteMode: 'local_endpoint',
        importProcessingStrictPolicy: 'false',
      });
      const [, errors] = parseSettingsForm(params);
      expect(errors).toContain('importProcessingLocalEndpointUrl is required when importProcessingRouteMode=local_endpoint');
      expect(errors).toContain('importProcessingLocalModel is required when importProcessingRouteMode=local_endpoint');
    });

    it('rejects invalid canonical model registry payloads', () => {
      const params = new URLSearchParams({
        modelRegistryJson: JSON.stringify({
          schemaVersion: 1,
          models: [
            {
              id: 'known',
              rank: 100,
              identity: {
                model: 'z-ai/glm-5',
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
              capabilities: { maxOutputTokens: 4096 },
              tuning: { maxOutputTokens: 4096 },
            },
            {
              id: 'missing-background',
              rank: 80,
              identity: {
                model: 'deepseek/deepseek-v3.2',
                provider: 'openrouter',
                source: { type: 'openrouter' },
              },
              purposes: [
                { purpose: 'extraction', primary: true },
                { purpose: 'import_processing', primary: true },
              ],
              capabilities: { maxOutputTokens: 1024 },
              tuning: { maxOutputTokens: 1024 },
            },
          ],
        }),
      });
      const [, errors] = parseSettingsForm(params);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('modelRegistryJson');
    });

    it('rejects malformed model tuning knobs in modelRegistryJson payloads', () => {
      const params = new URLSearchParams({
        modelRegistryJson: JSON.stringify(makeCanonicalModelRegistry({
          primaryTuning: {
            top_k: '10.5',
            thinking: {
              enabled: 'sometimes',
            },
          },
        })),
      });
      const [settings, errors] = parseSettingsForm(params);
      expect(settings.modelRegistry).toBeUndefined();
      expect(errors).toContain('modelRegistryJson must be valid canonical model registry JSON');
    });

    it('rejects out-of-range values', () => {
      const params = new URLSearchParams({
        primaryMaxTokens: '100',
        sessionHistoryBudgetPct: '0',
        extractionThresholdPct: '101',
        compactionThresholdPct: '0',
        retryBaseDelayMs: '100',
        moodCongruenceWeight: '1.2',
      });
      const [, errors] = parseSettingsForm(params);
      expect(errors.length).toBe(6);
      expect(errors.some(err => err.includes('primaryMaxTokens'))).toBe(true);
      expect(errors.some(err => err.includes('sessionHistoryBudgetPct'))).toBe(true);
      expect(errors.some(err => err.includes('extractionThresholdPct'))).toBe(true);
      expect(errors.some(err => err.includes('compactionThresholdPct'))).toBe(true);
      expect(errors.some(err => err.includes('retryBaseDelayMs'))).toBe(true);
      expect(errors.some(err => err.includes('moodCongruenceWeight'))).toBe(true);
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

    it('parses capabilityTier field', () => {
      const params = new URLSearchParams({
        capabilityTier: 'custom',
      });
      const [settings, errors] = parseSettingsForm(params);
      expect(errors).toEqual([]);
      expect(settings.capabilityTier).toBe('custom');
    });

    it('accepts registered STT provider ids', () => {
      const restoreProvider = registerStreamingSttProvider('plugin-test', {
        createConnector: () => ({
          id: 'plugin-test',
          startStream: async () => ({
            transcripts: (async function* emptyTranscripts() {})(),
            writeAudio: async () => {},
            endInput: async () => {},
            cancel: async () => {},
          }),
        }),
        metadata: {
          isConfigured: (config) => Boolean(config.pluginSttToken),
        },
      });

      try {
        const [settings, errors] = parseSettingsForm(new URLSearchParams({
          sttProvider: 'plugin-test',
        }));
        expect(errors).toEqual([]);
        expect(settings.sttProvider).toBe('plugin-test');
      } finally {
        restoreProvider();
      }
    });

    it('accepts registered TTS provider ids', () => {
      const restoreProvider = registerStreamingTtsProvider('plugin-test', {
        createConnector: () => ({
          id: 'plugin-test',
          synthesizeStream: async () => ({
            audio: (async function* emptyAudio() {})(),
            cancel: async () => {},
          }),
          synthesizeBuffer: async () => Buffer.alloc(0),
        }),
        metadata: {
          isConfigured: (config) => Boolean(config.pluginTtsToken),
        },
      });

      try {
        const [settings, errors] = parseSettingsForm(new URLSearchParams({
          ttsProvider: 'plugin-test',
        }));
        expect(errors).toEqual([]);
        expect(settings.ttsProvider).toBe('plugin-test');
      } finally {
        restoreProvider();
      }
    });

    it('rejects invalid capabilityTier value', () => {
      const params = new URLSearchParams({
        capabilityTier: 'invalid_tier',
      });
      const [, errors] = parseSettingsForm(params);
      expect(errors.length).toBe(1);
      expect(errors[0]).toContain('capabilityTier');
    });

    it('accepts all valid capabilityTier values', () => {
      for (const tier of ['nursery', 'apprentice', 'autonomous', 'custom']) {
        const params = new URLSearchParams({ capabilityTier: tier });
        const [settings, errors] = parseSettingsForm(params);
        expect(errors).toEqual([]);
        expect(settings.capabilityTier).toBe(tier);
      }
    });

    it('parses text emotion classifier settings', () => {
      const params = new URLSearchParams({
        textEmotionModel: 'SamLowe/roberta-base-go_emotions-onnx',
        textEmotionCacheDir: '/tmp/text-emotion-cache',
        textEmotionDtype: 'q8',
      });

      const [settings, errors] = parseSettingsForm(params);
      expect(errors).toEqual([]);
      expect(settings.textEmotionModel).toBe('SamLowe/roberta-base-go_emotions-onnx');
      expect(settings.textEmotionCacheDir).toBe('/tmp/text-emotion-cache');
      expect(settings.textEmotionDtype).toBe('q8');
    });

    it('rejects invalid textEmotionDtype values', () => {
      const params = new URLSearchParams({
        textEmotionModel: 'SamLowe/roberta-base-go_emotions-onnx',
        textEmotionDtype: 'bad-dtype',
      });

      const [, errors] = parseSettingsForm(params);
      expect(errors).toContain(
        'textEmotionDtype must be one of: auto, fp32, fp16, q8, int8, uint8, q4, bnb4, q4f16',
      );
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
      config.deepgramModel = undefined;
      const snapshot = getRuntimeSettingsSnapshot(config);
      expect(snapshot.adaptiveContextBudgetsEnabled).toBe(false);
      expect(snapshot.moodCongruenceWeight).toBe(0.15);
      expect(snapshot.thinkMaxTokens).toBeNull();
      expect(snapshot.thinkMaxWallTimeMs).toBeNull();
      expect(snapshot.thinkMaxSubQueries).toBeNull();
      expect(snapshot.sessionRestartBehavior).toBe('reuse_latest_session');
      expect(snapshot.observationMaskingWindow).toBe(1);
      expect(snapshot.compactionEmotionalSalienceThresholdPct).toBe(75);
      expect(snapshot.memoryExtractionEmotionalIntensityWeight).toBeNull();
      expect(snapshot.openRouterProviderOrder).toEqual([]);
      expect(snapshot.importProcessingRouteMode).toBe('background');
      expect(snapshot.importProcessingStrictPolicy).toBe(false);
      expect(snapshot.importProcessingLocalEndpointUrl).toBeNull();
      expect(snapshot.importProcessingLocalModel).toBeNull();
      expect(snapshot.compositionalPolicy).toEqual(createDefaultCompositionalPolicyConfig());
      expect(snapshot.webFetchAllowHttp).toBe(false);
      expect(snapshot.webFetchDomainAllowlist).toEqual([]);
      expect(snapshot.webFetchLocalCrawlerEnabled).toBe(false);
      expect(snapshot.webFetchLocalCrawlerAllowHttp).toBe(false);
      expect(snapshot.webFetchLocalCrawlerHostAllowlist).toEqual([]);
      expect(snapshot.webFetchLocalCrawlerDomainAllowlist).toEqual([]);
      expect(snapshot.webFetchTlsCaCertPaths).toEqual([]);
      expect(snapshot.promotedExtendedTools).toEqual([]);
      expect(snapshot.deepgramModel).toBeNull();
    });

    it('includes text emotion classifier settings in runtime snapshot', () => {
      const config = makeConfig();
      config.textEmotionModel = 'SamLowe/roberta-base-go_emotions-onnx';
      config.textEmotionCacheDir = '/tmp/text-emotion-cache';
      config.textEmotionDtype = 'q8';

      const snapshot = getRuntimeSettingsSnapshot(config);
      expect(snapshot.textEmotionModel).toBe('SamLowe/roberta-base-go_emotions-onnx');
      expect(snapshot.textEmotionCacheDir).toBe('/tmp/text-emotion-cache');
      expect(snapshot.textEmotionDtype).toBe('q8');
    });

    it('resolves budget percentages when legacy hard overrides are absent', () => {
      const config = makeConfig();
      config.sessionHistoryBudgetPct = undefined;
      config.memoryRetrievalBudgetPct = undefined;

      const snapshot = getRuntimeSettingsSnapshot(config);
      expect(snapshot.sessionHistoryBudgetPct).toBe(6);
      expect(snapshot.memoryRetrievalBudgetPct).toBe(2);
    });

    it('validates setting key membership', () => {
      expect(isRuntimeSettingKey('thinkMaxSubQueries')).toBe(true);
      expect(isRuntimeSettingKey('sessionRestartBehavior')).toBe(true);
      expect(isRuntimeSettingKey('compositionalPolicy')).toBe(true);
      expect(isRuntimeSettingKey('promotedExtendedTools')).toBe(true);
      expect(isRuntimeSettingKey('discordToken')).toBe(false);
    });

    it('includes compositional policy in snapshot when configured', () => {
      const config = makeConfig();
      config.compositionalPolicy = {
        enabled: true,
        allowedTiers: ['autonomous'],
        allowedChannelTypes: ['api'],
        allowedPurposes: ['retrieval'],
      };

      const snapshot = getRuntimeSettingsSnapshot(config);
      expect(snapshot.compositionalPolicy).toEqual(config.compositionalPolicy);
      expect(snapshot.compositionalPolicy).not.toBe(config.compositionalPolicy);
    });

    it('includes promotedExtendedTools in snapshot when configured', () => {
      const config = makeConfig();
      config.promotedExtendedTools = ['repo_status', 'session_list'];
      const snapshot = getRuntimeSettingsSnapshot(config);
      expect(snapshot.promotedExtendedTools).toEqual(['repo_status', 'session_list']);
    });

    it('honors explicit sttProvider selection and defaults to disabled when unset in snapshot', () => {
      const config = makeConfig();
      const runtimeConfig = config as SubstrateConfig & { sttProvider?: string };

      runtimeConfig.sttProvider = 'disabled';
      expect(getRuntimeSettingsSnapshot(config).sttProvider).toBe('disabled');

      runtimeConfig.sttProvider = 'deepgram';
      expect(getRuntimeSettingsSnapshot(config).sttProvider).toBe('deepgram');

      runtimeConfig.sttProvider = undefined;
      expect(getRuntimeSettingsSnapshot(config).sttProvider).toBe('disabled');
    });

    it('surfaces only explicit plugin STT provider selections in snapshot', () => {
      const restoreProvider = registerStreamingSttProvider('plugin-test', {
        createConnector: () => ({
          id: 'plugin-test',
          startStream: async () => ({
            transcripts: (async function* emptyTranscripts() {})(),
            writeAudio: async () => {},
            endInput: async () => {},
            cancel: async () => {},
          }),
        }),
        metadata: {
          isConfigured: (config) => Boolean(config.pluginSttToken),
        },
      });

      try {
        const config = makeConfig();
        const runtimeConfig = config as SubstrateConfig & { sttProvider?: string; pluginSttToken?: string };

        runtimeConfig.sttProvider = 'plugin-test';
        expect(getRuntimeSettingsSnapshot(config).sttProvider).toBe('plugin-test');

        runtimeConfig.sttProvider = undefined;
        runtimeConfig.pluginSttToken = 'plugin-key';
        config.deepgramApiKey = '';
        expect(getRuntimeSettingsSnapshot(config).sttProvider).toBe('disabled');
      } finally {
        restoreProvider();
      }
    });

    it('surfaces only explicit plugin TTS provider selections in snapshot', () => {
      const restoreProvider = registerStreamingTtsProvider('plugin-test', {
        createConnector: () => ({
          id: 'plugin-test',
          synthesizeStream: async () => ({
            audio: (async function* emptyAudio() {})(),
            cancel: async () => {},
          }),
          synthesizeBuffer: async () => Buffer.alloc(0),
        }),
        metadata: {
          isConfigured: (config) => Boolean(config.pluginTtsToken),
        },
      });

      try {
        const config = makeConfig();
        const runtimeConfig = config as SubstrateConfig & { ttsProvider?: string; pluginTtsToken?: string };

        runtimeConfig.ttsProvider = 'plugin-test';
        expect(getRuntimeSettingsSnapshot(config).ttsProvider).toBe('plugin-test');

        runtimeConfig.ttsProvider = undefined;
        runtimeConfig.pluginTtsToken = 'plugin-key';
        config.elevenLabsApiKey = '';
        expect(getRuntimeSettingsSnapshot(config).ttsProvider).toBe('disabled');
      } finally {
        restoreProvider();
      }
    });

    it('includes MoA settings in snapshot with defaults', () => {
      const config = makeConfig();
      const snapshot = getRuntimeSettingsSnapshot(config);
      expect(snapshot.moaEnabled).toBe(false);
      expect(snapshot.moaReferenceModels).toEqual([]);
      expect(snapshot.moaAggregatorModel).toBeNull();
      expect(snapshot.moaMaxRounds).toBeNull();
      expect(snapshot.moaMaxTokensPerRound).toBeNull();
      expect(snapshot.moaTimeoutMs).toBeNull();
    });

    it('reflects configured MoA values in snapshot', () => {
      const config = makeConfig();
      config.moaEnabled = true;
      config.moaReferenceModels = ['openai/gpt-4.1', 'z-ai/glm-5'];
      config.moaAggregatorModel = 'openai/gpt-4.1';
      config.moaMaxRounds = 2;
      config.moaMaxTokensPerRound = 8192;
      config.moaTimeoutMs = 60000;
      const snapshot = getRuntimeSettingsSnapshot(config);
      expect(snapshot.moaEnabled).toBe(true);
      expect(snapshot.moaReferenceModels).toEqual(['openai/gpt-4.1', 'z-ai/glm-5']);
      expect(snapshot.moaAggregatorModel).toBe('openai/gpt-4.1');
      expect(snapshot.moaMaxRounds).toBe(2);
      expect(snapshot.moaMaxTokensPerRound).toBe(8192);
      expect(snapshot.moaTimeoutMs).toBe(60000);
    });

    it('MoA setting keys are valid runtime setting keys', () => {
      expect(isRuntimeSettingKey('moaEnabled')).toBe(true);
      expect(isRuntimeSettingKey('moaReferenceModels')).toBe(true);
      expect(isRuntimeSettingKey('moaAggregatorModel')).toBe(true);
      expect(isRuntimeSettingKey('moaMaxRounds')).toBe(true);
      expect(isRuntimeSettingKey('moaMaxTokensPerRound')).toBe(true);
      expect(isRuntimeSettingKey('moaTimeoutMs')).toBe(true);
    });
  });

  describe('MoA settings', () => {
    it('applySettings applies MoA configuration to config', () => {
      const config = makeConfig();
      applySettings(config, {
        moaEnabled: true,
        moaReferenceModels: ['openai/gpt-4.1', 'z-ai/glm-5', 'deepseek/deepseek-v3.2'],
        moaAggregatorModel: 'openai/gpt-4.1',
        moaMaxRounds: 3,
        moaMaxTokensPerRound: 4096,
        moaTimeoutMs: 45000,
      });

      expect(config.moaEnabled).toBe(true);
      expect(config.moaReferenceModels).toEqual(['openai/gpt-4.1', 'z-ai/glm-5', 'deepseek/deepseek-v3.2']);
      expect(config.moaAggregatorModel).toBe('openai/gpt-4.1');
      expect(config.moaMaxRounds).toBe(3);
      expect(config.moaMaxTokensPerRound).toBe(4096);
      expect(config.moaTimeoutMs).toBe(45000);
    });

    it('applySettings does not modify MoA config when settings are empty', () => {
      const config = makeConfig();
      config.moaEnabled = true;
      config.moaReferenceModels = ['z-ai/glm-5'];
      config.moaAggregatorModel = 'z-ai/glm-5';
      applySettings(config, {});
      expect(config.moaEnabled).toBe(true);
      expect(config.moaReferenceModels).toEqual(['z-ai/glm-5']);
      expect(config.moaAggregatorModel).toBe('z-ai/glm-5');
    });

    it('applySettings clears moaReferenceModels when empty array is provided', () => {
      const config = makeConfig();
      config.moaReferenceModels = ['z-ai/glm-5'];
      applySettings(config, { moaReferenceModels: [] });
      expect(config.moaReferenceModels).toBeUndefined();
    });

    it('parseSettingsForm parses MoA form fields', () => {
      const params = new URLSearchParams({
        moaEnabled: 'true',
        moaReferenceModels: 'openai/gpt-4.1, z-ai/glm-5, openai/gpt-4.1',
        moaAggregatorModel: 'openai/gpt-4.1',
        moaMaxRounds: '2',
        moaMaxTokensPerRound: '8192',
        moaTimeoutMs: '30000',
      });

      const [settings, errors] = parseSettingsForm(params);
      expect(errors).toEqual([]);
      expect(settings.moaEnabled).toBe(true);
      expect(settings.moaReferenceModels).toEqual(['openai/gpt-4.1', 'z-ai/glm-5']);
      expect(settings.moaAggregatorModel).toBe('openai/gpt-4.1');
      expect(settings.moaMaxRounds).toBe(2);
      expect(settings.moaMaxTokensPerRound).toBe(8192);
      expect(settings.moaTimeoutMs).toBe(30000);
    });

    it('parseSettingsForm rejects out-of-range MoA numeric values', () => {
      const params = new URLSearchParams({
        moaMaxRounds: '0',
        moaMaxTokensPerRound: '100',
        moaTimeoutMs: '1000',
      });

      const [, errors] = parseSettingsForm(params);
      expect(errors.length).toBe(3);
      expect(errors.some(err => err.includes('moaMaxRounds'))).toBe(true);
      expect(errors.some(err => err.includes('moaMaxTokensPerRound'))).toBe(true);
      expect(errors.some(err => err.includes('moaTimeoutMs'))).toBe(true);
    });

    it('parseSettingsForm rejects invalid moaEnabled value', () => {
      const params = new URLSearchParams({
        moaEnabled: 'maybe',
      });

      const [, errors] = parseSettingsForm(params);
      expect(errors).toContain('moaEnabled must be true or false');
    });

    it('round-trip save → load → apply preserves MoA settings', () => {
      saveSettings(tempDir, {
        moaEnabled: true,
        moaReferenceModels: ['openai/gpt-4.1', 'z-ai/glm-5'],
        moaAggregatorModel: 'openai/gpt-4.1',
        moaMaxRounds: 2,
        moaMaxTokensPerRound: 4096,
        moaTimeoutMs: 30000,
      });

      const loaded = loadSettings(tempDir);
      const config = makeConfig();
      applySettings(config, loaded);

      expect(config.moaEnabled).toBe(true);
      expect(config.moaReferenceModels).toEqual(['openai/gpt-4.1', 'z-ai/glm-5']);
      expect(config.moaAggregatorModel).toBe('openai/gpt-4.1');
      expect(config.moaMaxRounds).toBe(2);
      expect(config.moaMaxTokensPerRound).toBe(4096);
      expect(config.moaTimeoutMs).toBe(30000);
    });

    it('saveSettings rejects capabilityTier because capability-tier.json owns it', () => {
      expect(() => saveSettings(tempDir, {
        capabilityTier: 'autonomous',
      })).toThrow(
        'Refusing to save non-runtime keys to settings.json: capabilityTier',
      );
    });

    it('round-trip save -> load -> apply preserves sessionRestartBehavior', () => {
      saveSettings(tempDir, {
        sessionRestartBehavior: 'new_session',
      });

      const loaded = loadSettings(tempDir);
      expect(loaded.sessionRestartBehavior).toBe('new_session');

      const config = makeConfig();
      applySettings(config, loaded);
      expect(config.sessionRestartBehavior).toBe('new_session');
    });

    it('round-trip save -> load -> apply preserves uiThemeId', () => {
      saveSettings(tempDir, {
        uiThemeId: 'generic-dark',
      });

      const loaded = loadSettings(tempDir);
      expect(loaded.uiThemeId).toBe('generic-dark');

      const config = makeConfig();
      applySettings(config, loaded);
      expect(config.uiThemeId).toBe('generic-dark');
    });

    it('saveSettings rejects custom capabilityTier because capability-tier.json owns it', () => {
      expect(() => saveSettings(tempDir, {
        capabilityTier: 'custom',
      })).toThrow(
        'Refusing to save non-runtime keys to settings.json: capabilityTier',
      );
    });

    it('parseSettingsForm parses telegram form fields', () => {
      const params = new URLSearchParams({
        telegramEnabled: 'true',
        telegramAuthorizedUsers: '123456789, 987654321',
      });

      const [settings, errors] = parseSettingsForm(params);
      expect(errors).toEqual([]);
      expect(settings.telegramEnabled).toBe(true);
      expect(settings.telegramAuthorizedUsers).toBe('123456789, 987654321');
    });

    it('parseSettingsForm rejects invalid telegramEnabled value', () => {
      const params = new URLSearchParams({
        telegramEnabled: 'maybe',
      });

      const [, errors] = parseSettingsForm(params);
      expect(errors).toContain('telegramEnabled must be true or false');
    });

    it('round-trip save -> load -> apply preserves telegram settings', () => {
      saveSettings(tempDir, {
        telegramEnabled: true,
        telegramAuthorizedUsers: '123456789, 987654321',
      });

      const loaded = loadSettings(tempDir);
      const config = makeConfig();
      applySettings(config, loaded);

      expect(config.telegramEnabled).toBe(true);
      expect(config.telegramAuthorizedUsers).toEqual(['123456789', '987654321']);
    });

    it('applySettings deduplicates telegram authorized users', () => {
      const config = makeConfig();
      applySettings(config, {
        telegramAuthorizedUsers: '111, 222, 111, 333, 222',
      });

      expect(config.telegramAuthorizedUsers).toEqual(['111', '222', '333']);
    });

    it('applySettings clears telegram authorized users when empty', () => {
      const config = makeConfig();
      config.telegramAuthorizedUsers = ['111'];
      applySettings(config, {
        telegramAuthorizedUsers: '',
      });

      expect(config.telegramAuthorizedUsers).toBeUndefined();
    });

    it('normalizeEditableSettings trims telegram authorized users', () => {
      const result = normalizeEditableSettings({
        telegramAuthorizedUsers: '  123 ,  456  ',
      });

      expect(result.telegramAuthorizedUsers).toBe('123 ,  456');
    });

    it('getRuntimeSettingsSnapshot reads telegram config', () => {
      const config = makeConfig();
      config.telegramEnabled = true;
      config.telegramAuthorizedUsers = ['111', '222'];

      const snapshot = getRuntimeSettingsSnapshot(config);
      expect(snapshot.telegramEnabled).toBe(true);
      expect(snapshot.telegramAuthorizedUsers).toBe('111, 222');
    });

    it('parseSettingsForm bounds promotedExtendedTools to four slots', () => {
      const params = new URLSearchParams({
        promotedExtendedTools: 'repo_status, session_list, prompt_layer_list, settings_get, contact_lookup',
      });

      const [settings, errors] = parseSettingsForm(params);
      expect(errors).toEqual([]);
      expect(settings.promotedExtendedTools).toEqual([
        'repo_status',
        'session_list',
        'prompt_layer_list',
        'settings_get',
      ]);
    });

    it('parseSettingsForm parses discord trigger form fields', () => {
      const params = new URLSearchParams({
        discordTriggerWords: 'pixie, hey companion',
        discordTriggerReactions: '👆, 🔥',
        discordTriggerListenWindowMs: '45000',
      });

      const [settings, errors] = parseSettingsForm(params);
      expect(errors).toEqual([]);
      expect(settings.discordTriggerWords).toBe('pixie, hey companion');
      expect(settings.discordTriggerReactions).toBe('👆, 🔥');
      expect(settings.discordTriggerListenWindowMs).toBe(45000);
    });

    it('parseSettingsForm validates discordTriggerListenWindowMs range', () => {
      const params = new URLSearchParams({
        discordTriggerListenWindowMs: '9999',
      });

      const [, errors] = parseSettingsForm(params);
      expect(errors.some(err => err.includes('discordTriggerListenWindowMs'))).toBe(true);
    });

    it('applySettings updates discord trigger config and keeps default reaction when cleared', () => {
      const config = makeConfig();
      applySettings(config, {
        discordTriggerWords: 'pixie, hey companion',
        discordTriggerReactions: '🔥, 👀',
        discordTriggerListenWindowMs: 45000,
      });

      expect(config.discordTriggerWords).toEqual(['pixie', 'hey companion']);
      expect(config.discordTriggerReactions).toEqual(['🔥', '👀']);
      expect(config.discordTriggerListenWindowMs).toBe(45000);

      applySettings(config, { discordTriggerReactions: '' });
      expect(config.discordTriggerReactions).toEqual(['👆']);
    });

    it('getRuntimeSettingsSnapshot reflects discord trigger config values', () => {
      const config = makeConfig();
      config.discordTriggerWords = ['pixie', 'hey companion'];
      config.discordTriggerReactions = ['🔥', '👀'];
      config.discordTriggerListenWindowMs = 45000;

      const snapshot = getRuntimeSettingsSnapshot(config);
      expect(snapshot.discordTriggerWords).toBe('pixie, hey companion');
      expect(snapshot.discordTriggerReactions).toBe('🔥, 👀');
      expect(snapshot.discordTriggerListenWindowMs).toBe(45000);
    });

    it('getRuntimeSettingsSnapshot uses discord trigger defaults when unset', () => {
      const snapshot = getRuntimeSettingsSnapshot(makeConfig());
      expect(snapshot.discordTriggerWords).toBeNull();
      expect(snapshot.discordTriggerReactions).toBe('👆');
      expect(snapshot.discordTriggerListenWindowMs).toBe(120000);
    });
  });
});
