import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CapabilityToken } from '../../../system/capabilities/tokens.js';
import { createEnvCredentialVault } from '../../../boundary/custody/credential-vault.js';
import type { CanonicalModelRegistry } from '../../../shared/contracts/runtime.js';
import type { ConfigStorePort } from '../../../system/config/config-store.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import {
  createEligibilityGate,
  EligibilityDeniedError,
} from '../../../system/capabilities/eligibility.js';
import { loadSettings, saveSettings } from '../../../system/settings.js';
import { saveModelsConfig } from '../../../system/config/models-config.js';
import { saveChargePolicyConfig } from '../../../system/config/charge-policy-config.js';
import { loadProvidersConfig } from '../../../system/config/providers-config.js';
import {
  loadSchedulerSeedDefaults,
  saveSchedulerConfig,
} from '../../../system/config/scheduler-config.js';
import {
  createRuntimeVoiceSttConnector,
  createRuntimeVoiceTtsConnector,
  hydrateCanonicalStartupConfig,
  hydrateSecretBearingConfig,
  installPromotedToolsPersistenceHook,
  resolveRuntimeVoiceProviderGate,
  resolveRuntimeVoiceSttProvider,
  resolveRuntimeVoiceTtsProviderOrder,
  resolveRuntimeVoiceTtsProvider,
} from './bootstrap-helpers.js';
import { registerStreamingSttProvider } from '../../../primitives/voice/connectors/stt/index.js';
import { registerStreamingTtsProvider } from '../../../primitives/voice/connectors/tts/index.js';

function createMutableEligibilityGate(initialTokens: CapabilityToken[]) {
  let grantedTokens = new Set(initialTokens);
  return {
    gate: createEligibilityGate(() => ({
      getTier: () => 'custom',
      getGrantedTokens: () => grantedTokens,
      has: (token) => grantedTokens.has(token),
    })),
    setTokens: (nextTokens: CapabilityToken[]) => {
      grantedTokens = new Set(nextTokens);
    },
  };
}

function makeStartupHydrationConfig(
  systemDataDir: string,
  companionDataDir: string,
): SubstrateConfig {
  return {
    primaryModel: 'openrouter/deepseek/deepseek-v3.2',
    primaryProvider: 'openrouter',
    extractionModel: 'openrouter/deepseek/deepseek-v3.2',
    extractionProvider: 'openrouter',
    primaryMaxTokens: 8192,
    extractionMaxTokens: 4096,
    discordToken: '',
    discordBotId: '',
    characterCardPath: join(companionDataDir, 'character.json'),
    systemDataDir,
    companionDataDir,
    dataDir: systemDataDir,
    databasePath: join(companionDataDir, 'companion.db'),
    sessionMessageLimit: 30,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    modelRoster: {
      chat: {
        model: 'openrouter/deepseek/deepseek-v3.2',
        provider: 'openrouter',
        maxTokens: 8192,
        contextWindow: 128_000,
      },
      background: {
        model: 'openrouter/deepseek/deepseek-v3.2',
        provider: 'openrouter',
        maxTokens: 4096,
      },
    },
  };
}

function makeCanonicalModelsConfigForChatOverride(
  model: string,
  provider: string,
  maxOutputTokens: number,
  contextWindow: number,
): CanonicalModelRegistry {
  const seeded = JSON.parse(readFileSync('config/models.seed.json', 'utf8')) as CanonicalModelRegistry;
  const cloned = structuredClone(seeded);
  const primary = cloned.models.find((entry) => entry.id === 'primary');
  if (!primary) {
    throw new Error('models.seed.json missing primary model');
  }

  primary.id = 'chatslot';
  primary.identity.model = model;
  primary.identity.provider = provider;
  primary.capabilities = {
    ...(primary.capabilities ?? {}),
    maxOutputTokens,
    contextWindow,
  };
  primary.tuning = {
    ...(primary.tuning ?? {}),
    maxOutputTokens,
  };

  return cloned;
}

const HYDRATION_OWNER_FILES = [
  'settings.json',
  'models.json',
  'providers.json',
  'trust-policy.json',
  'scheduler.json',
  'capability-tier.json',
  'charge-policy.json',
] as const;

function writeHydrationOwnerExamples(systemDataDir: string): void {
  for (const ownerFile of HYDRATION_OWNER_FILES) {
    const exampleFile = ownerFile.replace(/\.json$/, '.seed.json');
    writeFileSync(
      join(systemDataDir, ownerFile),
      readFileSync(join(process.cwd(), 'config', exampleFile), 'utf8'),
      'utf-8',
    );
  }
}

describe('resolveRuntimeVoiceSttProvider', () => {
  it('uses explicit provider when configured', () => {
    expect(resolveRuntimeVoiceSttProvider({ sttProvider: 'deepgram' } as any)).toBe('deepgram');
    expect(resolveRuntimeVoiceSttProvider({ sttProvider: 'disabled' } as any)).toBe('disabled');
  });

  it('throws when provider selection is not explicitly configured', () => {
    expect(() => resolveRuntimeVoiceSttProvider({ deepgramApiKey: 'key' } as any)).toThrow(
      'Missing runtime voice STT provider selection: set "sttProvider" in settings.json to "disabled" or a registered STT provider id',
    );
    expect(() => resolveRuntimeVoiceSttProvider({} as any)).toThrow(
      'Missing runtime voice STT provider selection: set "sttProvider" in settings.json to "disabled" or a registered STT provider id',
    );
  });

  it('throws for unsupported configured providers instead of falling back', () => {
    expect(() => resolveRuntimeVoiceSttProvider({
      sttProvider: 'invalid-provider',
      deepgramApiKey: 'key',
    } as any)).toThrow('Unsupported runtime voice STT provider: invalid-provider');
  });

  it('accepts registered providers without core switch edits', () => {
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
      expect(resolveRuntimeVoiceSttProvider({ sttProvider: 'plugin-test' } as any)).toBe('plugin-test');
    } finally {
      restoreProvider();
    }
  });
});

describe('resolveRuntimeVoiceTtsProvider', () => {
  it('uses explicit provider when configured', () => {
    expect(resolveRuntimeVoiceTtsProvider({ ttsProvider: 'echo' } as any)).toBe('echo');
    expect(resolveRuntimeVoiceTtsProvider({ ttsProvider: 'disabled' } as any)).toBe('disabled');
  });

  it('throws when provider selection is not explicitly configured', () => {
    expect(() => resolveRuntimeVoiceTtsProvider({ elevenLabsApiKey: 'elevenlabs-key' } as any)).toThrow(
      'Missing runtime voice TTS provider selection: set "ttsProvider" in settings.json to "disabled" or a registered TTS provider id',
    );
    expect(() => resolveRuntimeVoiceTtsProvider({} as any)).toThrow(
      'Missing runtime voice TTS provider selection: set "ttsProvider" in settings.json to "disabled" or a registered TTS provider id',
    );
  });

  it('throws for unsupported configured providers instead of falling back', () => {
    expect(() => resolveRuntimeVoiceTtsProvider({
      ttsProvider: 'invalid-provider',
      elevenLabsApiKey: 'elevenlabs-key',
    } as any)).toThrow('Unsupported runtime voice TTS provider: invalid-provider');
  });

  it('accepts registered providers without core switch edits', () => {
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
      expect(resolveRuntimeVoiceTtsProvider({ ttsProvider: 'plugin-test' } as any)).toBe('plugin-test');
    } finally {
      restoreProvider();
    }
  });
});

describe('resolveRuntimeVoiceProviderGate', () => {
  it('keeps voice disabled when providers are explicitly set to disabled', () => {
    const gate = resolveRuntimeVoiceProviderGate({
      sttProvider: 'disabled',
      ttsProvider: 'disabled',
      deepgramApiKey: 'deepgram-key',
      elevenLabsApiKey: 'elevenlabs-key',
    } as any);
    expect(gate).toEqual({
      sttProvider: 'disabled',
      ttsProvider: 'disabled',
      sttEnabled: false,
      ttsEnabled: false,
    });
  });

  it('throws when provider selections are missing even if credentials exist', () => {
    expect(() => resolveRuntimeVoiceProviderGate({
      deepgramApiKey: 'deepgram-key',
      elevenLabsApiKey: 'elevenlabs-key',
    } as any)).toThrow(
      'Missing runtime voice STT provider selection: set "sttProvider" in settings.json to "disabled" or a registered STT provider id',
    );

    expect(() => resolveRuntimeVoiceProviderGate({
      sttProvider: 'disabled',
      elevenLabsApiKey: 'elevenlabs-key',
    } as any)).toThrow(
      'Missing runtime voice TTS provider selection: set "ttsProvider" in settings.json to "disabled" or a registered TTS provider id',
    );
  });

  it('requires explicit echo URL/voice by default', () => {
    const gate = resolveRuntimeVoiceProviderGate({
      sttProvider: 'disabled',
      deepgramApiKey: 'deepgram-key',
      ttsProvider: 'echo',
      echoTtsUrl: '',
      echoTtsVoice: '',
    } as any);
    expect(gate).toEqual({
      sttProvider: 'disabled',
      ttsProvider: 'echo',
      sttEnabled: false,
      ttsEnabled: false,
    });
  });

  it('can allow echo defaults for websocket runtime gating', () => {
    const gate = resolveRuntimeVoiceProviderGate(
      {
        sttProvider: 'disabled',
        deepgramApiKey: 'deepgram-key',
        ttsProvider: 'echo',
      } as any,
      { allowEchoDefaults: true },
    );
    expect(gate).toEqual({
      sttProvider: 'disabled',
      ttsProvider: 'echo',
      sttEnabled: false,
      ttsEnabled: true,
    });
  });

  it('can require explicit elevenlabs voice id when needed', () => {
    const strictGate = resolveRuntimeVoiceProviderGate(
      {
        sttProvider: 'disabled',
        deepgramApiKey: 'deepgram-key',
        ttsProvider: 'elevenlabs',
        elevenLabsApiKey: 'elevenlabs-key',
        elevenLabsVoiceId: '',
      } as any,
      { requireElevenLabsVoiceId: true },
    );
    expect(strictGate.ttsEnabled).toBe(false);

    const relaxedGate = resolveRuntimeVoiceProviderGate(
      {
        sttProvider: 'disabled',
        deepgramApiKey: 'deepgram-key',
        ttsProvider: 'elevenlabs',
        elevenLabsApiKey: 'elevenlabs-key',
        elevenLabsVoiceId: '',
      } as any,
    );
    expect(relaxedGate.ttsEnabled).toBe(true);
  });

  it('treats vault-backed voice credentials as configured during provider gating', () => {
    const gate = resolveRuntimeVoiceProviderGate({
      credentialVault: createEnvCredentialVault({
        DEEPGRAM_API_KEY: 'deepgram-key',
        ELEVENLABS_API_KEY: 'elevenlabs-key',
      }),
      sttProvider: 'deepgram',
      ttsProvider: 'elevenlabs',
      elevenLabsVoiceId: 'voice-id',
    } as any);

    expect(gate).toEqual({
      sttProvider: 'deepgram',
      ttsProvider: 'elevenlabs',
      sttEnabled: true,
      ttsEnabled: true,
    });
  });

  it('uses registered STT provider metadata to determine enablement', () => {
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
      const enabledGate = resolveRuntimeVoiceProviderGate({
        sttProvider: 'plugin-test',
        ttsProvider: 'disabled',
        pluginSttToken: 'plugin-key',
      } as any);
      expect(enabledGate.sttEnabled).toBe(true);
      expect(enabledGate.sttProvider).toBe('plugin-test');

      const defaultGate = resolveRuntimeVoiceProviderGate({
        sttProvider: 'disabled',
        ttsProvider: 'disabled',
        pluginSttToken: 'plugin-key',
      } as any);
      expect(defaultGate.sttEnabled).toBe(false);
      expect(defaultGate.sttProvider).toBe('disabled');

      const disabledGate = resolveRuntimeVoiceProviderGate({
        sttProvider: 'plugin-test',
        ttsProvider: 'disabled',
      } as any);
      expect(disabledGate.sttEnabled).toBe(false);
    } finally {
      restoreProvider();
    }
  });

  it('uses registered TTS provider metadata to determine enablement', () => {
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
      const enabledGate = resolveRuntimeVoiceProviderGate({
        sttProvider: 'disabled',
        ttsProvider: 'plugin-test',
        pluginTtsToken: 'plugin-key',
      } as any);
      expect(enabledGate.ttsEnabled).toBe(true);
      expect(enabledGate.ttsProvider).toBe('plugin-test');

      const defaultGate = resolveRuntimeVoiceProviderGate({
        sttProvider: 'disabled',
        ttsProvider: 'disabled',
        pluginTtsToken: 'plugin-key',
        elevenLabsApiKey: '',
      } as any);
      expect(defaultGate.ttsEnabled).toBe(false);
      expect(defaultGate.ttsProvider).toBe('disabled');

      const disabledGate = resolveRuntimeVoiceProviderGate({
        sttProvider: 'disabled',
        ttsProvider: 'plugin-test',
      } as any);
      expect(disabledGate.ttsEnabled).toBe(false);
    } finally {
      restoreProvider();
    }
  });
});

describe('createRuntimeVoiceSttConnector', () => {
  it('throws when provider selection is missing and returns null when explicitly disabled', () => {
    expect(() => createRuntimeVoiceSttConnector({} as any)).toThrow(
      'Missing runtime voice STT provider selection: set "sttProvider" in settings.json to "disabled" or a registered STT provider id',
    );
    expect(createRuntimeVoiceSttConnector({
      sttProvider: 'disabled',
      deepgramApiKey: 'deepgram-key',
    } as any)).toBeNull();
  });

  it('creates a connector from registered runtime config without entrypoint switch logic', () => {
    const connector = {
      id: 'plugin-test',
      startStream: vi.fn(async () => ({
        transcripts: (async function* emptyTranscripts() {})(),
        writeAudio: async () => {},
        endInput: async () => {},
        cancel: async () => {},
      })),
    };
    const createConnector = vi.fn(() => connector);
    const restoreProvider = registerStreamingSttProvider('plugin-test', {
      createConnector,
      metadata: {
        isConfigured: (config) => Boolean(config.pluginSttToken),
        eligibility: {},
      },
      resolveRuntimeConfig: (config) => ({
        endpoint: String(config.pluginSttEndpoint),
      }),
    });

    try {
      const binding = createRuntimeVoiceSttConnector({
        sttProvider: 'plugin-test',
        pluginSttToken: 'plugin-key',
        pluginSttEndpoint: 'wss://plugin-stt.invalid',
      } as any);

      expect(binding?.provider).toBe('plugin-test');
      expect(binding?.connector).toBe(connector);
      expect(createConnector).toHaveBeenCalledWith({
        endpoint: 'wss://plugin-stt.invalid',
      });
    } finally {
      restoreProvider();
    }
  });

  it('fails closed when an explicitly selected provider is missing runtime config', () => {
    const restoreProvider = registerStreamingSttProvider('plugin-test', {
      createConnector: vi.fn(() => ({
        id: 'plugin-test',
        startStream: async () => ({
          transcripts: (async function* emptyTranscripts() {})(),
          writeAudio: async () => {},
          endInput: async () => {},
          cancel: async () => {},
        }),
      })),
      metadata: {
        isConfigured: () => false,
        eligibility: {},
      },
      resolveRuntimeConfig: () => {
        throw new Error('plugin STT runtime config missing');
      },
    });

    try {
      expect(() => createRuntimeVoiceSttConnector({
        sttProvider: 'plugin-test',
      } as any)).toThrow('plugin STT runtime config missing');
    } finally {
      restoreProvider();
    }
  });

  it('fails closed when a STT provider omits eligibility metadata', () => {
    const restoreProvider = registerStreamingSttProvider('plugin-test', {
      createConnector: vi.fn(() => ({
        id: 'plugin-test',
        startStream: async () => ({
          transcripts: (async function* emptyTranscripts() {})(),
          writeAudio: async () => {},
          endInput: async () => {},
          cancel: async () => {},
        }),
      })),
      metadata: {
        isConfigured: (config) => Boolean(config.pluginSttToken),
      },
      resolveRuntimeConfig: (config) => ({
        endpoint: String(config.pluginSttEndpoint),
      }),
    });

    try {
      expect(() => createRuntimeVoiceSttConnector({
        sttProvider: 'plugin-test',
        pluginSttToken: 'plugin-key',
        pluginSttEndpoint: 'wss://plugin-stt.invalid',
      } as any)).toThrow('stt plugin "plugin-test" is missing eligibility requirements');
    } finally {
      restoreProvider();
    }
  });

  it('re-checks STT eligibility on stream start', async () => {
    let allowExternalWeb = true;
    const eligibilityGate = createEligibilityGate(() => ({
      getTier: () => (allowExternalWeb ? 'apprentice' : 'nursery'),
      getGrantedTokens: () => allowExternalWeb ? new Set(['external.web']) : new Set(),
      has: (token) => allowExternalWeb && token === 'external.web',
    }));
    const startStream = vi.fn(async () => ({
      transcripts: (async function* emptyTranscripts() {})(),
      writeAudio: async () => {},
      endInput: async () => {},
      cancel: async () => {},
    }));
    const restoreProvider = registerStreamingSttProvider('plugin-test', {
      createConnector: vi.fn(() => ({
        id: 'plugin-test',
        startStream,
      })),
      metadata: {
        isConfigured: (config) => Boolean(config.pluginSttToken),
        eligibility: { requiredTokens: ['external.web'] },
      },
      resolveRuntimeConfig: (config) => ({
        endpoint: String(config.pluginSttEndpoint),
      }),
    });

    try {
      const binding = createRuntimeVoiceSttConnector({
        sttProvider: 'plugin-test',
        pluginSttToken: 'plugin-key',
        pluginSttEndpoint: 'wss://plugin-stt.invalid',
      } as any, { eligibilityGate });

      allowExternalWeb = false;
      await expect(binding!.connector.startStream({
        sampleRateHz: 16_000,
        channels: 1,
        encoding: 'pcm_s16le',
      })).rejects.toThrow('Eligibility denied');
      expect(startStream).not.toHaveBeenCalled();
    } finally {
      restoreProvider();
    }
  });

  it('fails closed for explicitly selected providers denied by the eligibility gate', () => {
    const restoreProvider = registerStreamingSttProvider('plugin-test', {
      createConnector: vi.fn(() => ({
        id: 'plugin-test',
        startStream: async () => ({
          transcripts: (async function* emptyTranscripts() {})(),
          writeAudio: async () => {},
          endInput: async () => {},
          cancel: async () => {},
        }),
      })),
      metadata: {
        isConfigured: (config) => Boolean(config.pluginSttToken),
        eligibility: { requiredTokens: ['external.web'] },
      },
      resolveRuntimeConfig: (config) => ({ endpoint: String(config.pluginSttEndpoint) }),
    });

    try {
      const { gate } = createMutableEligibilityGate([]);
      expect(() => createRuntimeVoiceSttConnector({
        sttProvider: 'plugin-test',
        pluginSttToken: 'plugin-key',
        pluginSttEndpoint: 'wss://plugin-stt.invalid',
      } as any, {
        eligibilityGate: gate,
      })).toThrow('Eligibility denied');
    } finally {
      restoreProvider();
    }
  });

  it('gates STT connector actions through the eligibility gate after activation', async () => {
    const startStream = vi.fn(async () => ({
      transcripts: (async function* emptyTranscripts() {})(),
      writeAudio: async () => {},
      endInput: async () => {},
      cancel: async () => {},
    }));
    const restoreProvider = registerStreamingSttProvider('plugin-test', {
      createConnector: vi.fn(() => ({
        id: 'plugin-test',
        startStream,
      })),
      metadata: {
        isConfigured: (config) => Boolean(config.pluginSttToken),
        eligibility: { requiredTokens: ['external.web'] },
      },
      resolveRuntimeConfig: (config) => ({ endpoint: String(config.pluginSttEndpoint) }),
    });

    try {
      const { gate, setTokens } = createMutableEligibilityGate(['external.web']);
      const binding = createRuntimeVoiceSttConnector({
        sttProvider: 'plugin-test',
        pluginSttToken: 'plugin-key',
        pluginSttEndpoint: 'wss://plugin-stt.invalid',
      } as any, {
        eligibilityGate: gate,
      });
      expect(binding).not.toBeNull();

      setTokens([]);
      await expect(
        binding!.connector.startStream({
          sampleRateHz: 16_000,
          channels: 1,
          encoding: 'pcm_s16le',
        }),
      ).rejects.toBeInstanceOf(EligibilityDeniedError);
      expect(startStream).not.toHaveBeenCalled();
    } finally {
      restoreProvider();
    }
  });
});

describe('createRuntimeVoiceTtsConnector', () => {
  it('throws when provider selection is missing and returns null when explicitly disabled', () => {
    expect(() => createRuntimeVoiceTtsConnector({} as any)).toThrow(
      'Missing runtime voice TTS provider selection: set "ttsProvider" in settings.json to "disabled" or a registered TTS provider id',
    );
    expect(createRuntimeVoiceTtsConnector({
      ttsProvider: 'disabled',
      elevenLabsApiKey: 'elevenlabs-key',
      elevenLabsVoiceId: 'voice-id',
    } as any)).toBeNull();
  });

  it('creates a connector from registered runtime config without entrypoint switch logic', () => {
    const connector = {
      id: 'plugin-test',
      synthesizeStream: vi.fn(async () => ({
        audio: (async function* emptyAudio() {})(),
        cancel: async () => {},
      })),
      synthesizeBuffer: vi.fn(async () => Buffer.alloc(0)),
    };
    const createConnector = vi.fn(() => connector);
    const restoreProvider = registerStreamingTtsProvider('plugin-test', {
      createConnector,
      metadata: {
        isConfigured: (config) => Boolean(config.pluginTtsToken),
        eligibility: {},
      },
      resolveRuntimeConfig: (config) => ({
        endpoint: String(config.pluginTtsEndpoint),
      }),
    });

    try {
      const binding = createRuntimeVoiceTtsConnector({
        ttsProvider: 'plugin-test',
        pluginTtsToken: 'plugin-key',
        pluginTtsEndpoint: 'https://plugin-tts.invalid',
      } as any);

      expect(binding?.provider).toBe('plugin-test');
      expect(binding?.connector).toBe(connector);
      expect(createConnector).toHaveBeenCalledWith({
        endpoint: 'https://plugin-tts.invalid',
      });
    } finally {
      restoreProvider();
    }
  });

  it('fails closed when an explicitly selected provider is missing runtime config', () => {
    const restoreProvider = registerStreamingTtsProvider('plugin-test', {
      createConnector: vi.fn(() => ({
        id: 'plugin-test',
        synthesizeStream: async () => ({
          audio: (async function* emptyAudio() {})(),
          cancel: async () => {},
        }),
        synthesizeBuffer: async () => Buffer.alloc(0),
      })),
      metadata: {
        isConfigured: () => false,
        eligibility: {},
      },
      resolveRuntimeConfig: () => {
        throw new Error('plugin TTS runtime config missing');
      },
    });

    try {
      expect(() => createRuntimeVoiceTtsConnector({
        ttsProvider: 'plugin-test',
      } as any)).toThrow('plugin TTS runtime config missing');
    } finally {
      restoreProvider();
    }
  });

  it('fails closed when a TTS provider omits eligibility metadata', () => {
    const restoreProvider = registerStreamingTtsProvider('plugin-test', {
      createConnector: vi.fn(() => ({
        id: 'plugin-test',
        synthesizeStream: async () => ({
          audio: (async function* emptyAudio() {})(),
          cancel: async () => {},
        }),
        synthesizeBuffer: async () => Buffer.alloc(0),
      })),
      metadata: {
        isConfigured: (config) => Boolean(config.pluginTtsToken),
      },
      resolveRuntimeConfig: (config) => ({
        endpoint: String(config.pluginTtsEndpoint),
      }),
    });

    try {
      expect(() => createRuntimeVoiceTtsConnector({
        ttsProvider: 'plugin-test',
        pluginTtsToken: 'plugin-key',
        pluginTtsEndpoint: 'https://plugin-tts.invalid',
      } as any)).toThrow('tts plugin "plugin-test" is missing eligibility requirements');
    } finally {
      restoreProvider();
    }
  });

  it('re-checks TTS eligibility on synthesizeBuffer', async () => {
    let allowExternalWeb = true;
    const eligibilityGate = createEligibilityGate(() => ({
      getTier: () => (allowExternalWeb ? 'apprentice' : 'nursery'),
      getGrantedTokens: () => allowExternalWeb ? new Set(['external.web']) : new Set(),
      has: (token) => allowExternalWeb && token === 'external.web',
    }));
    const synthesizeBuffer = vi.fn(async () => Buffer.alloc(0));
    const restoreProvider = registerStreamingTtsProvider('plugin-test', {
      createConnector: vi.fn(() => ({
        id: 'plugin-test',
        synthesizeStream: async () => ({
          audio: (async function* emptyAudio() {})(),
          cancel: async () => {},
        }),
        synthesizeBuffer,
      })),
      metadata: {
        isConfigured: (config) => Boolean(config.pluginTtsToken),
        eligibility: { requiredTokens: ['external.web'] },
      },
      resolveRuntimeConfig: (config) => ({
        endpoint: String(config.pluginTtsEndpoint),
      }),
    });

    try {
      const binding = createRuntimeVoiceTtsConnector({
        ttsProvider: 'plugin-test',
        pluginTtsToken: 'plugin-key',
        pluginTtsEndpoint: 'https://plugin-tts.invalid',
      } as any, { eligibilityGate });

      allowExternalWeb = false;
      await expect(binding!.connector.synthesizeBuffer({ text: 'hello' })).rejects.toThrow('Eligibility denied');
      expect(synthesizeBuffer).not.toHaveBeenCalled();
    } finally {
      restoreProvider();
    }
  });

  it('fails closed for explicitly selected providers denied by the eligibility gate', () => {
    const restoreProvider = registerStreamingTtsProvider('plugin-test', {
      createConnector: vi.fn(() => ({
        id: 'plugin-test',
        synthesizeStream: async () => ({
          audio: (async function* emptyAudio() {})(),
          cancel: async () => {},
        }),
        synthesizeBuffer: async () => Buffer.alloc(0),
      })),
      metadata: {
        isConfigured: (config) => Boolean(config.pluginTtsToken),
        eligibility: { requiredTokens: ['external.web'] },
      },
      resolveRuntimeConfig: (config) => ({ endpoint: String(config.pluginTtsEndpoint) }),
    });

    try {
      const { gate } = createMutableEligibilityGate([]);
      expect(() => createRuntimeVoiceTtsConnector({
        ttsProvider: 'plugin-test',
        pluginTtsToken: 'plugin-key',
        pluginTtsEndpoint: 'https://plugin-tts.invalid',
      } as any, {
        eligibilityGate: gate,
      })).toThrow('Eligibility denied');
    } finally {
      restoreProvider();
    }
  });

  it('gates TTS connector actions through the eligibility gate after activation', async () => {
    const synthesizeBuffer = vi.fn(async () => Buffer.from('ok'));
    const restoreProvider = registerStreamingTtsProvider('plugin-test', {
      createConnector: vi.fn(() => ({
        id: 'plugin-test',
        synthesizeStream: async () => ({
          audio: (async function* emptyAudio() {})(),
          cancel: async () => {},
        }),
        synthesizeBuffer,
      })),
      metadata: {
        isConfigured: (config) => Boolean(config.pluginTtsToken),
        eligibility: { requiredTokens: ['external.web'] },
      },
      resolveRuntimeConfig: (config) => ({ endpoint: String(config.pluginTtsEndpoint) }),
    });

    try {
      const { gate, setTokens } = createMutableEligibilityGate(['external.web']);
      const binding = createRuntimeVoiceTtsConnector({
        ttsProvider: 'plugin-test',
        pluginTtsToken: 'plugin-key',
        pluginTtsEndpoint: 'https://plugin-tts.invalid',
      } as any, {
        eligibilityGate: gate,
      });
      expect(binding).not.toBeNull();

      setTokens([]);
      await expect(
        binding!.connector.synthesizeBuffer({ text: 'hello' }),
      ).rejects.toBeInstanceOf(EligibilityDeniedError);
      expect(synthesizeBuffer).not.toHaveBeenCalled();
    } finally {
      restoreProvider();
    }
  });
});

describe('resolveRuntimeVoiceTtsProviderOrder', () => {
  it('returns only the preferred explicit provider without implicit fallbacks', () => {
    const restoreProvider = registerStreamingTtsProvider('plugin-test', {
      createConnector: vi.fn(() => ({
        id: 'plugin-test',
        synthesizeStream: async () => ({
          audio: (async function* emptyAudio() {})(),
          cancel: async () => {},
        }),
        synthesizeBuffer: async () => Buffer.alloc(0),
      })),
      metadata: {
        isConfigured: (config) => Boolean(config.pluginTtsToken),
      },
      resolveRuntimeConfig: (config) => ({
        endpoint: String(config.pluginTtsEndpoint),
      }),
    });

    try {
      expect(resolveRuntimeVoiceTtsProviderOrder({
        ttsProvider: 'plugin-test',
        pluginTtsToken: 'plugin-key',
        pluginTtsEndpoint: 'https://plugin-tts.invalid',
        elevenLabsApiKey: 'elevenlabs-key',
        elevenLabsVoiceId: 'voice-id',
      } as any)).toEqual(['plugin-test']);
    } finally {
      restoreProvider();
    }
  });

  it('returns an empty provider order when the provider is explicitly disabled', () => {
    expect(resolveRuntimeVoiceTtsProviderOrder({
      ttsProvider: 'disabled',
      elevenLabsApiKey: 'elevenlabs-key',
      elevenLabsVoiceId: 'voice-id',
    } as any)).toEqual([]);
  });

  it('throws when provider selection is missing', () => {
    expect(() => resolveRuntimeVoiceTtsProviderOrder({
      elevenLabsApiKey: 'elevenlabs-key',
      elevenLabsVoiceId: 'voice-id',
    } as any)).toThrow(
      'Missing runtime voice TTS provider selection: set "ttsProvider" in settings.json to "disabled" or a registered TTS provider id',
    );
  });
});

describe('installPromotedToolsPersistenceHook', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists promoted tool names via runtimeHooks', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-promoted-tools-'));
    tempDirs.push(dataDir);
    saveSettings(dataDir, {});

    const config = { dataDir } as any;
    installPromotedToolsPersistenceHook(config);

    config.runtimeHooks.persistPromotedExtendedTools(['repo_status', 'repo_diff']);

    const saved = loadSettings(dataDir);
    expect(saved.promotedExtendedTools).toEqual(['repo_status', 'repo_diff']);
  });

  it('preserves existing runtime hooks when installing persistence hook', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-promoted-tools-'));
    tempDirs.push(dataDir);

    const existingHook = () => 'ok';
    const config = {
      dataDir,
      runtimeHooks: {
        existingHook,
      },
    } as any;

    installPromotedToolsPersistenceHook(config);

    expect(config.runtimeHooks.existingHook).toBe(existingHook);
    expect(typeof config.runtimeHooks.persistPromotedExtendedTools).toBe('function');
  });

  it('can persist promoted tool names through an injected config store port', () => {
    const savedSettings: Record<string, unknown> = {
      promotedExtendedTools: [],
    };
    const configStore = {
      loadRuntimeSettings: () => ({ ...savedSettings }),
      saveRuntimeSettings: (settings) => {
        Object.assign(savedSettings, settings);
      },
    } as ConfigStorePort;

    const config = {
      dataDir: '/unused',
    } as any;
    installPromotedToolsPersistenceHook(config, {
      configStore,
    });

    config.runtimeHooks.persistPromotedExtendedTools(['memory_recall', 'analysis_workbench']);

    expect(savedSettings.promotedExtendedTools).toEqual(['memory_recall', 'analysis_workbench']);
  });
});

describe('hydrateCanonicalStartupConfig', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when voice startup is enabled without Discord auth secrets', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-hydration-'));
    const systemDataDir = join(rootDir, 'system-data');
    const companionDataDir = join(rootDir, 'companion-data');
    const legacyDataDir = join(rootDir, 'legacy-data-empty');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(companionDataDir, { recursive: true });
    mkdirSync(legacyDataDir, { recursive: true });
    tempDirs.push(rootDir);
    writeHydrationOwnerExamples(systemDataDir);
    saveSettings(systemDataDir, {
      voiceEnabled: true,
    });

    const config = makeStartupHydrationConfig(systemDataDir, companionDataDir);

    expect(() => hydrateCanonicalStartupConfig(config, {
      env: {
        ...process.env,
        CONFIG_DIR: './config',
        PSFN_RUNTIME_LAYOUT_MODE: 'continuous',
        DATA_DIR: legacyDataDir,
        DISCORD_TOKEN: undefined,
        DISCORD_BOT_ID: undefined,
      },
    })).toThrow('DISCORD_TOKEN and DISCORD_BOT_ID are required when DISCORD_VOICE_ENABLED=true');
  });

  it('fails closed when only one Discord auth secret is configured at startup', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-hydration-'));
    const systemDataDir = join(rootDir, 'system-data');
    const companionDataDir = join(rootDir, 'companion-data');
    const legacyDataDir = join(rootDir, 'legacy-data-empty');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(companionDataDir, { recursive: true });
    mkdirSync(legacyDataDir, { recursive: true });
    tempDirs.push(rootDir);
    writeHydrationOwnerExamples(systemDataDir);

    const config = makeStartupHydrationConfig(systemDataDir, companionDataDir);
    config.discordToken = 'discord-secret';

    expect(() => hydrateCanonicalStartupConfig(config, {
      env: {
        ...process.env,
        CONFIG_DIR: './config',
        PSFN_RUNTIME_LAYOUT_MODE: 'continuous',
        DATA_DIR: legacyDataDir,
        DISCORD_BOT_ID: undefined,
      },
    })).toThrow('DISCORD_BOT_ID is required when DISCORD_TOKEN is configured');
  });

  it('does not recreate a credential vault when hydrating agent-side startup config', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-hydration-'));
    const systemDataDir = join(rootDir, 'system-data');
    const companionDataDir = join(rootDir, 'companion-data');
    const legacyDataDir = join(rootDir, 'legacy-data-empty');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(companionDataDir, { recursive: true });
    mkdirSync(legacyDataDir, { recursive: true });
    tempDirs.push(rootDir);
    writeHydrationOwnerExamples(systemDataDir);

    const config = makeStartupHydrationConfig(systemDataDir, companionDataDir);
    config.voiceEnabled = true;
    delete config.discordToken;
    delete config.discordBotId;
    delete config.credentialVault;

    expect(() => hydrateCanonicalStartupConfig(config, {
      env: {
        ...process.env,
        CONFIG_DIR: './config',
        PSFN_RUNTIME_LAYOUT_MODE: 'continuous',
        DATA_DIR: legacyDataDir,
        DISCORD_TOKEN: 'discord-secret',
        DISCORD_BOT_ID: 'discord-bot-id',
      },
      secretAuthority: 'agent',
    })).not.toThrow();
    expect(config.credentialVault).toBeUndefined();
    expect(config.discordToken).toBeUndefined();
    expect(config.discordBotId).toBeUndefined();
  });

  it('hydrates secret-bearing config from OpenBao before startup validation', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-hydration-'));
    const systemDataDir = join(rootDir, 'system-data');
    const companionDataDir = join(rootDir, 'companion-data');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(companionDataDir, { recursive: true });
    tempDirs.push(rootDir);
    writeHydrationOwnerExamples(systemDataDir);

    const config = makeStartupHydrationConfig(systemDataDir, companionDataDir);
    config.voiceEnabled = true;

    await hydrateSecretBearingConfig(config, {
      env: {
        ...process.env,
        CREDENTIAL_VAULT_BACKEND: 'openbao',
        OPENBAO_ADDR: 'https://openbao.internal:8200',
        OPENBAO_TOKEN: 'openbao-token',
        OPENBAO_KV_MOUNT: 'kv',
        OPENBAO_KV_PATH: 'psfn/runtime',
      },
      fetchImpl: async () => new Response(JSON.stringify({
        data: {
          data: {
            DISCORD_TOKEN: 'discord-secret',
            DISCORD_BOT_ID: 'discord-bot-id',
            DEEPGRAM_API_KEY: 'deepgram-secret',
          },
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    });

    expect(config.credentialVault).toBeDefined();
    expect(config.discordToken).toBe('discord-secret');
    expect(config.discordBotId).toBe('discord-bot-id');
    expect(config.deepgramApiKey).toBe('deepgram-secret');
    expect(() => hydrateCanonicalStartupConfig(config, {
      env: {
        ...process.env,
        CONFIG_DIR: './config',
        PSFN_RUNTIME_LAYOUT_MODE: 'continuous',
        DATA_DIR: rootDir,
      },
    })).not.toThrow();
  });

  it('hydrates settings/models/trust/scheduler from canonical owners in one helper', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-hydration-'));
    const systemDataDir = join(rootDir, 'system-data');
    const companionDataDir = join(rootDir, 'companion-data');
    const legacyDataDir = join(rootDir, 'legacy-data-empty');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(companionDataDir, { recursive: true });
    mkdirSync(legacyDataDir, { recursive: true });
    tempDirs.push(rootDir);
    writeHydrationOwnerExamples(systemDataDir);

    const config = makeStartupHydrationConfig(systemDataDir, companionDataDir);
    saveSettings(systemDataDir, {
      sessionMessageLimit: 44,
      memoryRetrievalLimit: 11,
      extractionThresholdPct: 34,
      compactionThresholdPct: 76,
    });
    saveModelsConfig(systemDataDir, makeCanonicalModelsConfigForChatOverride(
      'openai/gpt-4.1-mini',
      'openrouter',
      2048,
      65_536,
    ));
    saveSchedulerConfig(systemDataDir, {
      ...loadSchedulerSeedDefaults(),
      tickIntervalMs: 2_000,
      heartbeatIntervalMs: 8_000,
      salienceDecayIntervalMs: 123_000,
    });
    saveChargePolicyConfig(systemDataDir, {
      schemaVersion: 1,
      runChargeQuotaByLane: {
        interactive: 30,
        background: 10,
        maintenance: 0,
        subagent: 5,
        shard: 14,
      },
      surfaceCosts: {
        ownerFileInspection: 0,
        localFilesystem: 0,
        memoryRead: 0,
        memoryWrite: 0,
        localEmbedding: 0,
        externalEmbedding: 0,
        localImageGeneration: 0,
        paidImageGeneration: 6,
        thinkExtensionBand: 1,
        subagentLaunch: 1,
        shardLaunch: 8,
        externalModelConsult: 1,
        moaRoundBase: 1,
      },
      surfaceRationales: {
        paidImageGeneration: 'External image generation spends paid provider credits.',
        thinkExtensionBand: 'Extended analysis workbench loops get a small cost to keep them bounded.',
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
        premium_cloud: 4,
      },
      referenceModelClassPricingRationales: {
        cheap_cloud: 'Cheap cloud models are lightly priced to keep them available for routine use.',
        premium_cloud: 'Premium cloud models are intentionally more expensive to reserve for high-value calls.',
      },
    });

    const result = hydrateCanonicalStartupConfig(config, {
      env: {
        ...process.env,
        CONFIG_DIR: './config',
        PSFN_RUNTIME_LAYOUT_MODE: 'continuous',
        DATA_DIR: legacyDataDir,
      },
    });

    expect(result.systemDataDir).toBe(systemDataDir);
    expect(result.companionDataDir).toBe(companionDataDir);
    expect(result.runtimePathLayout.systemDataDir).toBe(systemDataDir);
    expect(result.pathSnapshot.systemDataDir).toBe(systemDataDir);
    expect(result.pathSnapshot.companionDataDir).toBe(companionDataDir);
    expect(result.pathSnapshot.runtimePathLayout).toEqual(result.runtimePathLayout);
    expect(config.sessionMessageLimit).toBe(30);
    expect(config.memoryRetrievalLimit).toBe(15);
    expect(config.extractionThresholdPct).toBe(34);
    expect(config.compactionThresholdPct).toBe(76);
    expect(config.modelCatalog.chatslot.model).toBe('openai/gpt-4.1-mini');
    expect(config.modelRoster.chat?.contextWindow).toBe(65_536);
    expect(result.schedulerConfig.salienceDecayIntervalMs).toBe(123_000);
    expect(config.maintenanceIntervalMs).toBe(123_000);
    expect(config.providerRegistry?.providers.length).toBeGreaterThan(0);
    expect(config.litellmBaseUrl).toBeUndefined();
    expect(config.openRouterModelsApiUrl).toBe('https://openrouter.ai/api/v1/models');
    expect(result.trustPolicyConfig.channelClassification.defaultVisibility).toBeTruthy();
    expect(result.chargePolicyConfig.runChargeQuotaByLane.interactive).toBe(30);
    expect(config.chargePolicy?.surfaceCosts.shardLaunch).toBe(8);
    expect(result.diagnostics.legacySettingsKeys).toEqual([]);
  });

  it('returns parity-consistent canonical startup snapshots across entrypoint callers', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-hydration-parity-'));
    const systemDataDir = join(rootDir, 'system-data');
    const companionDataDir = join(rootDir, 'companion-data');
    const legacyDataDir = join(rootDir, 'legacy-data-empty');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(companionDataDir, { recursive: true });
    mkdirSync(legacyDataDir, { recursive: true });
    tempDirs.push(rootDir);
    writeHydrationOwnerExamples(systemDataDir);

    saveSettings(systemDataDir, {
      sessionMessageLimit: 41,
      memoryRetrievalLimit: 17,
    });
    saveModelsConfig(systemDataDir, makeCanonicalModelsConfigForChatOverride(
      'openai/gpt-4.1-mini',
      'openrouter',
      3072,
      131_072,
    ));
    saveSchedulerConfig(systemDataDir, {
      ...loadSchedulerSeedDefaults(),
      tickIntervalMs: 2_000,
      heartbeatIntervalMs: 7_000,
      salienceDecayIntervalMs: 222_000,
    });

    const env = {
      ...process.env,
      CONFIG_DIR: './config',
      PSFN_RUNTIME_LAYOUT_MODE: 'continuous',
      DATA_DIR: legacyDataDir,
    };

    const runtimeConfig = makeStartupHydrationConfig(systemDataDir, companionDataDir);
    const agentConfig = makeStartupHydrationConfig(systemDataDir, companionDataDir);
    const gatewayConfig = makeStartupHydrationConfig(systemDataDir, companionDataDir);
    const chatCliConfig = makeStartupHydrationConfig(systemDataDir, companionDataDir);

    const runtimeSnapshot = hydrateCanonicalStartupConfig(runtimeConfig, { env });
    const agentSnapshot = hydrateCanonicalStartupConfig(agentConfig, { env });
    const gatewaySnapshot = hydrateCanonicalStartupConfig(gatewayConfig, { env });
    const chatCliSnapshot = hydrateCanonicalStartupConfig(chatCliConfig, { env });

    const snapshots = [agentSnapshot, gatewaySnapshot, chatCliSnapshot];
    for (const snapshot of snapshots) {
      expect(snapshot.systemDataDir).toBe(runtimeSnapshot.systemDataDir);
      expect(snapshot.companionDataDir).toBe(runtimeSnapshot.companionDataDir);
      expect(snapshot.pathSnapshot).toEqual(runtimeSnapshot.pathSnapshot);
      expect(snapshot.settingsDomains).toEqual(runtimeSnapshot.settingsDomains);
      expect(snapshot.runtimePathLayout).toEqual(runtimeSnapshot.runtimePathLayout);
      expect(snapshot.trustPolicyConfig).toEqual(runtimeSnapshot.trustPolicyConfig);
      expect(snapshot.schedulerConfig).toEqual(runtimeSnapshot.schedulerConfig);
    }

    expect(runtimeConfig.sessionMessageLimit).toBe(30);
    expect(agentConfig.sessionMessageLimit).toBe(30);
    expect(gatewayConfig.sessionMessageLimit).toBe(30);
    expect(chatCliConfig.sessionMessageLimit).toBe(30);
    expect(runtimeConfig.modelCatalog.chatslot.model).toBe('openai/gpt-4.1-mini');
    expect(agentConfig.modelCatalog.chatslot.model).toBe('openai/gpt-4.1-mini');
    expect(gatewayConfig.modelCatalog.chatslot.model).toBe('openai/gpt-4.1-mini');
    expect(chatCliConfig.modelCatalog.chatslot.model).toBe('openai/gpt-4.1-mini');
  });

  it('fails closed when settings.json contains scheduler or capability owner keys', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-hydration-'));
    const systemDataDir = join(rootDir, 'system-data');
    const companionDataDir = join(rootDir, 'companion-data');
    const legacyDataDir = join(rootDir, 'legacy-data-empty');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(companionDataDir, { recursive: true });
    mkdirSync(legacyDataDir, { recursive: true });
    tempDirs.push(rootDir);
    writeHydrationOwnerExamples(systemDataDir);

    const config = makeStartupHydrationConfig(systemDataDir, companionDataDir);
    writeFileSync(
      join(systemDataDir, 'settings.json'),
      `${JSON.stringify({
        sessionMessageLimit: 51,
        maintenanceIntervalMs: 222_000,
        capabilityTier: 'apprentice',
      }, null, 2)}\n`,
      'utf-8',
    );

    expect(() => hydrateCanonicalStartupConfig(config, {
      env: {
        ...process.env,
        CONFIG_DIR: './config',
        PSFN_RUNTIME_LAYOUT_MODE: 'continuous',
        DATA_DIR: legacyDataDir,
      },
    })).toThrow(
      'Unsupported cross-domain keys in settings.json: maintenanceIntervalMs, capabilityTier',
    );
  });

  it('fails closed when settings.json contains model owner keys', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-hydration-models-'));
    const systemDataDir = join(rootDir, 'system-data');
    const companionDataDir = join(rootDir, 'companion-data');
    const legacyDataDir = join(rootDir, 'legacy-data-empty');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(companionDataDir, { recursive: true });
    mkdirSync(legacyDataDir, { recursive: true });
    tempDirs.push(rootDir);
    writeHydrationOwnerExamples(systemDataDir);

    const config = makeStartupHydrationConfig(systemDataDir, companionDataDir);
    writeFileSync(
      join(systemDataDir, 'settings.json'),
      `${JSON.stringify({
        modelRegistry: makeCanonicalModelsConfigForChatOverride(
          'openai/gpt-4.1-mini',
          'openrouter',
          2048,
          65_536,
        ),
      }, null, 2)}\n`,
      'utf-8',
    );

    expect(() => hydrateCanonicalStartupConfig(config, {
      env: {
        ...process.env,
        CONFIG_DIR: './config',
        PSFN_RUNTIME_LAYOUT_MODE: 'continuous',
        DATA_DIR: legacyDataDir,
      },
    })).toThrow(
      'Unsupported cross-domain keys in settings.json: modelRegistry',
    );
  });

  it('does not migrate legacy provider endpoints into providers.json during startup', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-hydration-providers-'));
    const systemDataDir = join(rootDir, 'system-data');
    const companionDataDir = join(rootDir, 'companion-data');
    const legacyDataDir = join(rootDir, 'legacy-data-empty');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(companionDataDir, { recursive: true });
    mkdirSync(legacyDataDir, { recursive: true });
    tempDirs.push(rootDir);
    writeHydrationOwnerExamples(systemDataDir);

    const config = makeStartupHydrationConfig(systemDataDir, companionDataDir);
    writeFileSync(
      join(systemDataDir, 'settings.json'),
      `${JSON.stringify({
        openRouterModelsApiUrl: 'https://legacy.example.test/openrouter-models',
      }, null, 2)}\n`,
      'utf-8',
    );

    const result = hydrateCanonicalStartupConfig(config, {
      env: {
        ...process.env,
        CONFIG_DIR: './config',
        PSFN_RUNTIME_LAYOUT_MODE: 'continuous',
        DATA_DIR: legacyDataDir,
        LITELLM_BASE_URL: 'http://127.0.0.1:4999/v1',
      },
    });

    expect(result.diagnostics.legacySettingsKeys).toEqual([]);
    expect(config.litellmBaseUrl).toBeUndefined();
    expect(config.openRouterModelsApiUrl).toBe('https://openrouter.ai/api/v1/models');
    expect(loadProvidersConfig(systemDataDir).litellmBaseUrl).toBeUndefined();
    expect(loadProvidersConfig(systemDataDir).openRouterModelsApiUrl).toBe('https://openrouter.ai/api/v1/models');
  });
});
