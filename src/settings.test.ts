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
import {
  createDefaultCompositionalPolicyConfig,
  type SubstrateConfig,
} from './types.js';
import { registerStreamingSttProvider } from './voice/connectors/stt/index.js';
import { registerStreamingTtsProvider } from './voice/connectors/tts/index.js';

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
      context: 'extraction',
      extraction: 'extraction',
      summary: 'primary',
      reasoning: 'primary',
      longContext: 'primary',
    },
    modelRoster: {
      chat: { model: 'z-ai/glm-5', provider: 'openrouter', maxTokens: 16384, contextWindow: 128_000 },
      background: { model: 'deepseek/deepseek-v3.2', provider: 'openrouter', maxTokens: 8192 },
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
      expect(result.compositionalPolicy).toEqual(createDefaultCompositionalPolicyConfig());
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
      expect(result.modelCatalog.primary.model).toBe('legacy/chat');
      expect(result.modelCatalog.extraction.model).toBe('legacy/extract');
      expect(result.modelRoleAssignments?.chat).toBe('primary');
      expect(result.modelRoleAssignments?.extraction).toBe('extraction');
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
  });

  describe('saveSettings', () => {
    it('writes settings atomically and omits domain-owned model fields', () => {
      const settings = {
        primaryModel: 'test/chat',
        primaryProvider: 'openrouter',
        primaryMaxTokens: 4096,
        extractionInterval: 10,
      };
      saveSettings(tempDir, settings);

      const raw = readFileSync(join(tempDir, 'settings.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.primaryModel).toBeUndefined();
      expect(parsed.modelCatalog).toBeUndefined();
      expect(parsed.modelRoleAssignments).toBeUndefined();
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

    it('projects context budget overrides from model catalog into chat roster', () => {
      const normalized = normalizeEditableSettings({
        modelCatalog: {
          primary: {
            model: 'chat/model',
            provider: 'openrouter',
            defaults: {
              maxTokens: 6000,
              contextWindow: 128_000,
              contextBudget: {
                sessionHistoryMinTokens: 3_500,
                memoryRetrievalMinTokens: 900,
              },
            },
          },
        },
        modelRoleAssignments: {
          chat: 'primary',
        },
      }, {
        defaultContextWindow: 128_000,
      });

      expect(normalized.modelRoster?.chat?.contextBudget).toEqual({
        sessionHistoryMinTokens: 3_500,
        memoryRetrievalMinTokens: 900,
      });
    });

    it('preserves per-slot OpenRouter routing preferences through normalization', () => {
      const normalized = normalizeEditableSettings({
        modelCatalog: {
          primary: {
            model: 'chat/model',
            provider: 'openrouter',
            defaults: { maxTokens: 6000, contextWindow: 128_000 },
            routing: { providerOrder: ['parasail', 'openai'] },
          },
        },
        modelRoleAssignments: {
          chat: 'primary',
        },
      }, {
        defaultContextWindow: 128_000,
      });

      expect(normalized.modelCatalog?.primary?.routing).toEqual({
        providerOrder: ['parasail', 'openai'],
      });
      expect(normalized.modelRoster?.chat?.routing).toEqual({
        providerOrder: ['parasail', 'openai'],
      });
    });

    it('defaults context roster to the background slot when no dedicated context assignment exists', () => {
      const normalized = normalizeEditableSettings({
        modelCatalog: {
          primary: {
            model: 'z-ai/glm-5',
            provider: 'openrouter',
            defaults: { maxTokens: 6000, contextWindow: 128_000 },
          },
          extraction: {
            model: 'deepseek/deepseek-v3.2',
            provider: 'openrouter',
            defaults: { maxTokens: 2048 },
          },
        },
        modelRoleAssignments: {
          chat: 'primary',
          background: 'extraction',
          extraction: 'extraction',
        },
      }, {
        defaultContextWindow: 128_000,
      });

      expect(normalized.modelRoleAssignments?.context).toBe('extraction');
      expect(normalized.modelRoster?.context).toEqual({
        model: 'deepseek/deepseek-v3.2',
        provider: 'openrouter',
        maxTokens: 2048,
        contextWindow: 128_000,
      });
    });

    it('keeps a dedicated vision slot when vision assignment is omitted', () => {
      const normalized = normalizeEditableSettings({
        modelCatalog: {
          primary: {
            model: 'z-ai/glm-5',
            provider: 'openrouter',
            defaults: { maxTokens: 6000, contextWindow: 128_000 },
          },
          vision: {
            model: 'moonshotai/kimi-k2.5',
            provider: 'openrouter',
            defaults: { maxTokens: 4096, contextWindow: 128_000 },
          },
        },
        modelRoleAssignments: {
          chat: 'primary',
          summary: 'primary',
          reasoning: 'primary',
          longContext: 'primary',
        },
      }, {
        defaultContextWindow: 128_000,
      });

      expect(normalized.modelRoleAssignments?.vision).toBe('vision');
      expect(normalized.modelRoster?.vision).toEqual({
        model: 'moonshotai/kimi-k2.5',
        provider: 'openrouter',
        maxTokens: 4096,
        contextWindow: 128_000,
      });
    });

    it('normalizes openrouter-prefixed model ids when provider is empty', () => {
      const normalized = normalizeEditableSettings({
        modelCatalog: {
          primary: {
            model: 'z-ai/glm-5',
            provider: 'openrouter',
            defaults: { maxTokens: 16384, contextWindow: 128_000 },
          },
          extraction: {
            model: 'deepseek/deepseek-v3.2',
            provider: 'openrouter',
            defaults: { maxTokens: 8192 },
          },
          vision: {
            model: 'openrouter/google/gemini-3-flash-preview',
            provider: '',
            overrides: { maxTokens: 16384, contextWindow: 128_000 },
          },
        },
      }, {
        defaultContextWindow: 128_000,
      });

      expect(normalized.modelCatalog?.vision).toEqual({
        model: 'google/gemini-3-flash-preview',
        provider: 'openrouter',
        overrides: { maxTokens: 16384, contextWindow: 128_000 },
      });
      expect(normalized.modelRoleAssignments?.vision).toBe('vision');
      expect(normalized.modelRoster?.vision).toEqual({
        model: 'google/gemini-3-flash-preview',
        provider: 'openrouter',
        maxTokens: 16384,
        contextWindow: 128_000,
      });
    });

    it('prefers explicit modelCatalog slots over stale modelRoster values', () => {
      const normalized = normalizeEditableSettings({
        modelCatalog: {
          primary: {
            model: 'z-ai/glm-5',
            provider: 'openrouter',
            defaults: { maxTokens: 16384, contextWindow: 128_000 },
          },
          extraction: {
            model: 'deepseek/deepseek-v3.2',
            provider: 'openrouter',
            defaults: { maxTokens: 8192 },
          },
          vision: {
            model: 'google/gemini-3-flash-preview',
            provider: 'openrouter',
            overrides: { maxTokens: 16384, contextWindow: 128_000 },
          },
        },
        modelRoleAssignments: {
          chat: 'primary',
          background: 'extraction',
          extraction: 'extraction',
          summary: 'primary',
          reasoning: 'primary',
          longContext: 'primary',
          vision: 'vision',
        },
        modelRoster: {
          vision: {
            model: 'moonshotai/kimi-k2.5',
            provider: 'openrouter',
            maxTokens: 16384,
            contextWindow: 128_000,
          },
        },
      }, {
        defaultContextWindow: 128_000,
      });

      expect(normalized.modelCatalog.vision.model).toBe('google/gemini-3-flash-preview');
      expect(normalized.modelRoster?.vision?.model).toBe('google/gemini-3-flash-preview');
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
        sessionRestartBehavior: 'new_session',
        memoryRetrievalLimit: 25,
        extractionInterval: 10,
        compactionEmotionalSalienceThresholdPct: 55,
        retryMaxAttempts: 5,
        retryBaseDelayMs: 4000,
      });
      expect(config.sessionHistoryBudgetPct).toBe(8);
      expect(config.memoryRetrievalBudgetPct).toBe(3);
      expect(config.sessionMessageLimit).toBe(50);
      expect(config.sessionRestartBehavior).toBe('new_session');
      expect(config.memoryRetrievalLimit).toBe(25);
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
          helper: {
            model: 'openai/gpt-4.1-mini',
            provider: 'openrouter',
            defaults: { maxTokens: 1536, contextWindow: 64_000 },
          },
        },
        modelRoleAssignments: {
          chat: 'lowlatency',
          background: 'extractionx',
          context: 'helper',
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
      expect(config.modelRoster.context).toEqual({
        model: 'openai/gpt-4.1-mini',
        provider: 'openrouter',
        maxTokens: 1536,
        contextWindow: 64_000,
      });
      expect(config.modelRoster.longContext).toEqual({
        model: 'z-ai/glm-5',
        provider: 'openrouter',
        maxTokens: 10000,
        contextWindow: 256_000,
      });
    });

    it('applies per-model context budget overrides from catalog to roster', () => {
      const config = makeConfig();
      applySettings(config, {
        modelCatalog: {
          primary: {
            model: 'openai/gpt-4.1-mini',
            provider: 'openrouter',
            defaults: {
              maxTokens: 2048,
              contextWindow: 8_000,
            },
            overrides: {
              contextBudget: {
                sessionHistoryMinTokens: 3_000,
                memoryRetrievalMinTokens: 800,
              },
            },
          },
          extraction: {
            model: 'deepseek/deepseek-v3.2',
            provider: 'openrouter',
            defaults: { maxTokens: 3072 },
          },
        },
        modelRoleAssignments: {
          chat: 'primary',
          extraction: 'extraction',
          background: 'extraction',
        },
      });

      expect(config.modelRoster.chat?.contextBudget).toEqual({
        sessionHistoryMinTokens: 3_000,
        memoryRetrievalMinTokens: 800,
      });
    });

    it('preserves per-slot OpenRouter routing preferences from model catalog', () => {
      const config = makeConfig();
      applySettings(config, {
        modelCatalog: {
          primary: {
            model: 'openai/gpt-4.1-mini',
            provider: 'openrouter',
            defaults: { maxTokens: 2048, contextWindow: 8_000 },
            routing: { providerOrder: ['parasail', 'openai'] },
          },
          extraction: {
            model: 'deepseek/deepseek-v3.2',
            provider: 'openrouter',
            defaults: { maxTokens: 3072 },
          },
        },
        modelRoleAssignments: {
          chat: 'primary',
          extraction: 'extraction',
          background: 'extraction',
        },
      });

      expect(config.modelCatalog?.primary?.routing).toEqual({
        providerOrder: ['parasail', 'openai'],
      });
      expect(config.modelRoster.chat?.routing).toEqual({
        providerOrder: ['parasail', 'openai'],
      });
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
    it('save → load → apply keeps existing model settings when payload contains model fields', () => {
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

      expect(loaded.modelCatalog).toBeUndefined();
      expect(loaded.modelRoleAssignments).toBeUndefined();
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
        sessionMessageLimit: 42,
        sessionRestartBehavior: 'new_session' as const,
        memoryRetrievalLimit: 11,
        extractionInterval: 6,
        defaultContextWindow: 196_000,
        memoryBudgetPct: 24,
        extractionThresholdPct: 34,
        compactionThresholdPct: 76,
        compactionEmotionalSalienceThresholdPct: 83,
        memoryExtractionMinImportance: 0.35,
        memoryExtractionMinConfidence: 0.45,
        memoryExtractionMinNovelty: 0.25,
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
        discordEnabled: true,
        discordHeartbeatChannel: '1234567890',
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
      expect(settings.modelCatalog.primary.model).toBe('test-model');
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
          context: 'extract',
          extraction: 'extract',
          background: 'extract',
          summary: 'fast',
        }),
      });

      const [settings, errors] = parseSettingsForm(params);
      expect(errors).toEqual([]);
      expect(settings.modelCatalog.fast.overrides.maxTokens).toBe(1536);
      expect(settings.modelRoleAssignments?.chat).toBe('fast');
      expect(settings.modelRoleAssignments?.context).toBe('extract');
      expect(settings.primaryModel).toBe('openai/gpt-4.1-mini');
      expect(settings.extractionModel).toBe('deepseek/deepseek-v3.2');
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
      expect(snapshot.sessionRestartBehavior).toBe('reuse_latest_session');
      expect(snapshot.compactionEmotionalSalienceThresholdPct).toBe(75);
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

    it('honors explicit sttProvider override before api-key fallback in snapshot', () => {
      const config = makeConfig();
      const runtimeConfig = config as SubstrateConfig & { sttProvider?: string };

      runtimeConfig.sttProvider = 'disabled';
      expect(getRuntimeSettingsSnapshot(config).sttProvider).toBe('disabled');

      runtimeConfig.sttProvider = 'deepgram';
      expect(getRuntimeSettingsSnapshot(config).sttProvider).toBe('deepgram');

      runtimeConfig.sttProvider = undefined;
      expect(getRuntimeSettingsSnapshot(config).sttProvider).toBe('deepgram');
      config.deepgramApiKey = '';
      expect(getRuntimeSettingsSnapshot(config).sttProvider).toBe('disabled');
    });

    it('surfaces plugin STT providers in snapshot and default resolution', () => {
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
          canAutoEnable: true,
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
        expect(getRuntimeSettingsSnapshot(config).sttProvider).toBe('plugin-test');
      } finally {
        restoreProvider();
      }
    });

    it('surfaces plugin TTS providers in snapshot and default resolution', () => {
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
          canAutoEnable: true,
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
        expect(getRuntimeSettingsSnapshot(config).ttsProvider).toBe('plugin-test');
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

    it('round-trip save -> load -> apply does not persist capabilityTier in settings.json', () => {
      saveSettings(tempDir, {
        capabilityTier: 'autonomous',
      });

      const loaded = loadSettings(tempDir);
      const config = makeConfig();
      config.capabilityTier = 'nursery';
      applySettings(config, loaded);

      expect(loaded.capabilityTier).toBeUndefined();
      expect(config.capabilityTier).toBe('nursery');
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

    it('round-trip save -> load -> apply keeps existing custom capabilityTier when only settings.json is used', () => {
      saveSettings(tempDir, {
        capabilityTier: 'custom',
      });

      const loaded = loadSettings(tempDir);
      expect(loaded.capabilityTier).toBeUndefined();

      const config = makeConfig();
      config.capabilityTier = 'custom';
      applySettings(config, loaded);
      expect(config.capabilityTier).toBe('custom');
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
        discordTriggerWords: 'pixie, hey psfn',
        discordTriggerReactions: '👆, 🔥',
        discordTriggerListenWindowMs: '45000',
      });

      const [settings, errors] = parseSettingsForm(params);
      expect(errors).toEqual([]);
      expect(settings.discordTriggerWords).toBe('pixie, hey psfn');
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
        discordTriggerWords: 'pixie, hey psfn',
        discordTriggerReactions: '🔥, 👀',
        discordTriggerListenWindowMs: 45000,
      });

      expect(config.discordTriggerWords).toEqual(['pixie', 'hey psfn']);
      expect(config.discordTriggerReactions).toEqual(['🔥', '👀']);
      expect(config.discordTriggerListenWindowMs).toBe(45000);

      applySettings(config, { discordTriggerReactions: '' });
      expect(config.discordTriggerReactions).toEqual(['👆']);
    });

    it('getRuntimeSettingsSnapshot reflects discord trigger config values', () => {
      const config = makeConfig();
      config.discordTriggerWords = ['pixie', 'hey psfn'];
      config.discordTriggerReactions = ['🔥', '👀'];
      config.discordTriggerListenWindowMs = 45000;

      const snapshot = getRuntimeSettingsSnapshot(config);
      expect(snapshot.discordTriggerWords).toBe('pixie, hey psfn');
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
