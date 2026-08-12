import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CapabilityToken } from '../../../system/capabilities/tokens.js';
import { createEnvCredentialVault } from '../../../boundary/custody/credential-vault.js';
import type { CanonicalModelRegistry } from '../../../shared/contracts/runtime.js';
import type { ConfigStorePort } from '../../../system/config/config-store.js';
import {
  createDefaultObserverEvalSidecarLeverSettings,
  createDefaultObserverEvalSidecarSettings,
  type SubstrateConfig,
} from '../../../system/config/runtime-config-contracts.js';
import {
  createEligibilityGate,
  EligibilityDeniedError,
} from '../../../system/capabilities/eligibility.js';
import { loadSettings, saveSettings } from '../../../system/settings.js';
import { COMPANION_SETTINGS_OVERLAY_FILE_NAME } from '../../../system/config/settings-overlay.js';
import { PER_COMPANION_OWNER_FILES } from '../../../system/config/settings-contract.js';
import { saveModelsConfig } from '../../../system/config/models-config.js';
import {
  loadChargePolicySeedDefaults,
  saveChargePolicyConfig,
} from '../../../system/config/charge-policy-config.js';
import { loadProvidersConfig } from '../../../system/config/providers-config.js';
import {
  loadSchedulerSeedDefaults,
  saveSchedulerConfig,
} from '../../../system/config/scheduler-config.js';
import { makeTestFatiguePolicyConfig } from '../../../test-support/charge-policy.js';
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
  'automata-policy.json',
] as const;

function writeHydrationOwnerExamples(systemDataDir: string, companionDataDir: string): void {
  for (const ownerFile of HYDRATION_OWNER_FILES) {
    const exampleFile = ownerFile.replace(/\.json$/, '.seed.json');
    // Per-companion owner files are rooted at companionDataDir; the rest stay
    // cluster-global at systemDataDir. Registry-driven via
    // PER_COMPANION_OWNER_FILES so future
    // per-companion relocations inherit the correct seed target automatically.
    const targetDir = PER_COMPANION_OWNER_FILES.has(ownerFile) ? companionDataDir : systemDataDir;
    writeFileSync(
      join(targetDir, ownerFile),
      readFileSync(join(process.cwd(), 'config', exampleFile), 'utf8'),
      'utf-8',
    );
  }
}

describe('resolveRuntimeVoiceSttProvider', () => {
  it('uses explicit provider when configured', () => {
    expect(resolveRuntimeVoiceSttProvider(fromPartial({ sttProvider: 'deepgram' }))).toBe('deepgram');
    expect(resolveRuntimeVoiceSttProvider(fromPartial({ sttProvider: 'disabled' }))).toBe('disabled');
  });

  it('throws when provider selection is not explicitly configured', () => {
    expect(() => resolveRuntimeVoiceSttProvider(fromPartial({ deepgramApiKey: 'key' }))).toThrow(
      'Missing runtime voice STT provider selection: set "sttProvider" in settings.json to "disabled" or a registered STT provider id',
    );
    expect(() => resolveRuntimeVoiceSttProvider(fromPartial({}))).toThrow(
      'Missing runtime voice STT provider selection: set "sttProvider" in settings.json to "disabled" or a registered STT provider id',
    );
  });

  it('throws for unsupported configured providers instead of falling back', () => {
    expect(() => resolveRuntimeVoiceSttProvider(fromPartial({
      sttProvider: 'invalid-provider',
      deepgramApiKey: 'key',
    }))).toThrow('Unsupported runtime voice STT provider: invalid-provider');
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
      expect(resolveRuntimeVoiceSttProvider(fromPartial({ sttProvider: 'plugin-test' }))).toBe('plugin-test');
    } finally {
      restoreProvider();
    }
  });
});

describe('resolveRuntimeVoiceTtsProvider', () => {
  it('uses explicit provider when configured', () => {
    expect(resolveRuntimeVoiceTtsProvider(fromPartial({ ttsProvider: 'echo' }))).toBe('echo');
    expect(resolveRuntimeVoiceTtsProvider(fromPartial({ ttsProvider: 'disabled' }))).toBe('disabled');
  });

  it('throws when provider selection is not explicitly configured', () => {
    expect(() => resolveRuntimeVoiceTtsProvider(fromPartial({ elevenLabsApiKey: 'elevenlabs-key' }))).toThrow(
      'Missing runtime voice TTS provider selection: set "ttsProvider" in settings.json to "disabled" or a registered TTS provider id',
    );
    expect(() => resolveRuntimeVoiceTtsProvider(fromPartial({}))).toThrow(
      'Missing runtime voice TTS provider selection: set "ttsProvider" in settings.json to "disabled" or a registered TTS provider id',
    );
  });

  it('throws for unsupported configured providers instead of falling back', () => {
    expect(() => resolveRuntimeVoiceTtsProvider(fromPartial({
      ttsProvider: 'invalid-provider',
      elevenLabsApiKey: 'elevenlabs-key',
    }))).toThrow('Unsupported runtime voice TTS provider: invalid-provider');
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
      expect(resolveRuntimeVoiceTtsProvider(fromPartial({ ttsProvider: 'plugin-test' }))).toBe('plugin-test');
    } finally {
      restoreProvider();
    }
  });
});

describe('resolveRuntimeVoiceProviderGate', () => {
  it('keeps voice disabled when providers are explicitly set to disabled', () => {
    const gate = resolveRuntimeVoiceProviderGate(fromPartial({
      sttProvider: 'disabled',
      ttsProvider: 'disabled',
      deepgramApiKey: 'deepgram-key',
      elevenLabsApiKey: 'elevenlabs-key',
    }));
    expect(gate).toEqual({
      sttProvider: 'disabled',
      ttsProvider: 'disabled',
      sttEnabled: false,
      ttsEnabled: false,
    });
  });

  it('throws when provider selections are missing even if credentials exist', () => {
    expect(() => resolveRuntimeVoiceProviderGate(fromPartial({
      deepgramApiKey: 'deepgram-key',
      elevenLabsApiKey: 'elevenlabs-key',
    }))).toThrow(
      'Missing runtime voice STT provider selection: set "sttProvider" in settings.json to "disabled" or a registered STT provider id',
    );

    expect(() => resolveRuntimeVoiceProviderGate(fromPartial({
      sttProvider: 'disabled',
      elevenLabsApiKey: 'elevenlabs-key',
    }))).toThrow(
      'Missing runtime voice TTS provider selection: set "ttsProvider" in settings.json to "disabled" or a registered TTS provider id',
    );
  });

  it('requires explicit echo URL/voice by default', () => {
    const gate = resolveRuntimeVoiceProviderGate(fromPartial({
      sttProvider: 'disabled',
      deepgramApiKey: 'deepgram-key',
      ttsProvider: 'echo',
      echoTtsUrl: '',
      echoTtsVoice: '',
    }));
    expect(gate).toEqual({
      sttProvider: 'disabled',
      ttsProvider: 'echo',
      sttEnabled: false,
      ttsEnabled: false,
    });
  });

  it('can allow echo defaults for websocket runtime gating', () => {
    const gate = resolveRuntimeVoiceProviderGate(
      fromPartial({
        sttProvider: 'disabled',
        deepgramApiKey: 'deepgram-key',
        ttsProvider: 'echo',
      }),
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
      fromPartial({
        sttProvider: 'disabled',
        deepgramApiKey: 'deepgram-key',
        ttsProvider: 'elevenlabs',
        elevenLabsApiKey: 'elevenlabs-key',
        elevenLabsVoiceId: '',
      }),
      { requireElevenLabsVoiceId: true },
    );
    expect(strictGate.ttsEnabled).toBe(false);

    const relaxedGate = resolveRuntimeVoiceProviderGate(
      fromPartial({
        sttProvider: 'disabled',
        deepgramApiKey: 'deepgram-key',
        ttsProvider: 'elevenlabs',
        elevenLabsApiKey: 'elevenlabs-key',
        elevenLabsVoiceId: '',
      }),
    );
    expect(relaxedGate.ttsEnabled).toBe(true);
  });

  it('treats vault-backed voice credentials as configured during provider gating', () => {
    const gate = resolveRuntimeVoiceProviderGate(fromPartial({
      credentialVault: createEnvCredentialVault({
        DEEPGRAM_API_KEY: 'deepgram-key',
        ELEVENLABS_API_KEY: 'elevenlabs-key',
      }),
      sttProvider: 'deepgram',
      ttsProvider: 'elevenlabs',
      elevenLabsVoiceId: 'voice-id',
    }));

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
      const enabledGate = resolveRuntimeVoiceProviderGate(fromPartial({
        sttProvider: 'plugin-test',
        ttsProvider: 'disabled',
        pluginSttToken: 'plugin-key',
      }));
      expect(enabledGate.sttEnabled).toBe(true);
      expect(enabledGate.sttProvider).toBe('plugin-test');

      const defaultGate = resolveRuntimeVoiceProviderGate(fromPartial({
        sttProvider: 'disabled',
        ttsProvider: 'disabled',
        pluginSttToken: 'plugin-key',
      }));
      expect(defaultGate.sttEnabled).toBe(false);
      expect(defaultGate.sttProvider).toBe('disabled');

      const disabledGate = resolveRuntimeVoiceProviderGate(fromPartial({
        sttProvider: 'plugin-test',
        ttsProvider: 'disabled',
      }));
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
      const enabledGate = resolveRuntimeVoiceProviderGate(fromPartial({
        sttProvider: 'disabled',
        ttsProvider: 'plugin-test',
        pluginTtsToken: 'plugin-key',
      }));
      expect(enabledGate.ttsEnabled).toBe(true);
      expect(enabledGate.ttsProvider).toBe('plugin-test');

      const defaultGate = resolveRuntimeVoiceProviderGate(fromPartial({
        sttProvider: 'disabled',
        ttsProvider: 'disabled',
        pluginTtsToken: 'plugin-key',
        elevenLabsApiKey: '',
      }));
      expect(defaultGate.ttsEnabled).toBe(false);
      expect(defaultGate.ttsProvider).toBe('disabled');

      const disabledGate = resolveRuntimeVoiceProviderGate(fromPartial({
        sttProvider: 'disabled',
        ttsProvider: 'plugin-test',
      }));
      expect(disabledGate.ttsEnabled).toBe(false);
    } finally {
      restoreProvider();
    }
  });
});

describe('createRuntimeVoiceSttConnector', () => {
  it('throws when provider selection is missing and returns null when explicitly disabled', () => {
    expect(() => createRuntimeVoiceSttConnector(fromPartial({}))).toThrow(
      'Missing runtime voice STT provider selection: set "sttProvider" in settings.json to "disabled" or a registered STT provider id',
    );
    expect(createRuntimeVoiceSttConnector(fromPartial({
      sttProvider: 'disabled',
      deepgramApiKey: 'deepgram-key',
    }))).toBeNull();
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
      const binding = createRuntimeVoiceSttConnector(fromPartial({
        sttProvider: 'plugin-test',
        pluginSttToken: 'plugin-key',
        pluginSttEndpoint: 'wss://plugin-stt.invalid',
      }));

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
      expect(() => createRuntimeVoiceSttConnector(fromPartial({
        sttProvider: 'plugin-test',
      }))).toThrow('plugin STT runtime config missing');
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
      expect(() => createRuntimeVoiceSttConnector(fromPartial({
        sttProvider: 'plugin-test',
        pluginSttToken: 'plugin-key',
        pluginSttEndpoint: 'wss://plugin-stt.invalid',
      }))).toThrow('stt plugin "plugin-test" is missing eligibility requirements');
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
      const binding = createRuntimeVoiceSttConnector(fromPartial({
        sttProvider: 'plugin-test',
        pluginSttToken: 'plugin-key',
        pluginSttEndpoint: 'wss://plugin-stt.invalid',
      }), { eligibilityGate });

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
      expect(() => createRuntimeVoiceSttConnector(fromPartial({
        sttProvider: 'plugin-test',
        pluginSttToken: 'plugin-key',
        pluginSttEndpoint: 'wss://plugin-stt.invalid',
      }), {
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
      const binding = createRuntimeVoiceSttConnector(fromPartial({
        sttProvider: 'plugin-test',
        pluginSttToken: 'plugin-key',
        pluginSttEndpoint: 'wss://plugin-stt.invalid',
      }), {
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
    expect(() => createRuntimeVoiceTtsConnector(fromPartial({}))).toThrow(
      'Missing runtime voice TTS provider selection: set "ttsProvider" in settings.json to "disabled" or a registered TTS provider id',
    );
    expect(createRuntimeVoiceTtsConnector(fromPartial({
      ttsProvider: 'disabled',
      elevenLabsApiKey: 'elevenlabs-key',
      elevenLabsVoiceId: 'voice-id',
    }))).toBeNull();
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
      const binding = createRuntimeVoiceTtsConnector(fromPartial({
        ttsProvider: 'plugin-test',
        pluginTtsToken: 'plugin-key',
        pluginTtsEndpoint: 'https://plugin-tts.invalid',
      }));

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
      expect(() => createRuntimeVoiceTtsConnector(fromPartial({
        ttsProvider: 'plugin-test',
      }))).toThrow('plugin TTS runtime config missing');
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
      expect(() => createRuntimeVoiceTtsConnector(fromPartial({
        ttsProvider: 'plugin-test',
        pluginTtsToken: 'plugin-key',
        pluginTtsEndpoint: 'https://plugin-tts.invalid',
      }))).toThrow('tts plugin "plugin-test" is missing eligibility requirements');
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
      const binding = createRuntimeVoiceTtsConnector(fromPartial({
        ttsProvider: 'plugin-test',
        pluginTtsToken: 'plugin-key',
        pluginTtsEndpoint: 'https://plugin-tts.invalid',
      }), { eligibilityGate });

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
      expect(() => createRuntimeVoiceTtsConnector(fromPartial({
        ttsProvider: 'plugin-test',
        pluginTtsToken: 'plugin-key',
        pluginTtsEndpoint: 'https://plugin-tts.invalid',
      }), {
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
      const binding = createRuntimeVoiceTtsConnector(fromPartial({
        ttsProvider: 'plugin-test',
        pluginTtsToken: 'plugin-key',
        pluginTtsEndpoint: 'https://plugin-tts.invalid',
      }), {
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
      expect(resolveRuntimeVoiceTtsProviderOrder(fromPartial({
        ttsProvider: 'plugin-test',
        pluginTtsToken: 'plugin-key',
        pluginTtsEndpoint: 'https://plugin-tts.invalid',
        elevenLabsApiKey: 'elevenlabs-key',
        elevenLabsVoiceId: 'voice-id',
      }))).toEqual(['plugin-test']);
    } finally {
      restoreProvider();
    }
  });

  it('returns an empty provider order when the provider is explicitly disabled', () => {
    expect(resolveRuntimeVoiceTtsProviderOrder(fromPartial({
      ttsProvider: 'disabled',
      elevenLabsApiKey: 'elevenlabs-key',
      elevenLabsVoiceId: 'voice-id',
    }))).toEqual([]);
  });

  it('throws when provider selection is missing', () => {
    expect(() => resolveRuntimeVoiceTtsProviderOrder(fromPartial({
      elevenLabsApiKey: 'elevenlabs-key',
      elevenLabsVoiceId: 'voice-id',
    }))).toThrow(
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

  it('persists promoted tool names via runtimeHooks', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-promoted-tools-'));
    tempDirs.push(dataDir);
    saveSettings(dataDir, {});

    const config = fromPartial({ dataDir });
    installPromotedToolsPersistenceHook(config);

    await config.runtimeHooks.persistPromotedExtendedTools(['repo_status', 'repo_diff']);

    const saved = loadSettings(dataDir);
    expect(saved.promotedExtendedTools).toEqual(['repo_status', 'repo_diff']);
  });

  it('preserves existing runtime hooks when installing persistence hook', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-promoted-tools-'));
    tempDirs.push(dataDir);

    const existingHook = () => 'ok';
    const config = fromPartial({
      dataDir,
      runtimeHooks: {
        existingHook,
      },
    });

    installPromotedToolsPersistenceHook(config);

    expect(config.runtimeHooks.existingHook).toBe(existingHook);
    expect(typeof config.runtimeHooks.persistPromotedExtendedTools).toBe('function');
  });

  it('can persist promoted tool names through an injected config store port', async () => {
    const savedSettings: Record<string, unknown> = {
      promotedExtendedTools: [],
    };
    const configStore = {
      loadRuntimeSettings: () => ({ ...savedSettings }),
      saveRuntimeSettings: (settings) => {
        Object.assign(savedSettings, settings);
      },
    } as ConfigStorePort;

    const config = fromPartial({
      dataDir: '/unused',
    });
    installPromotedToolsPersistenceHook(config, {
      configStore,
    });

    await config.runtimeHooks.persistPromotedExtendedTools(['memory_recall', 'analysis_workbench']);

    expect(savedSettings.promotedExtendedTools).toEqual(['memory_recall', 'analysis_workbench']);
  });

  it('routes tool-pin persistence through the gateway when system-data is read-only', async () => {
    const saveRuntimeSettings = vi.fn(() => {
      const error = new Error('EROFS: read-only file system') as NodeJS.ErrnoException;
      error.code = 'EROFS';
      throw error;
    });
    const configStore = {
      loadRuntimeSettings: () => ({ promotedExtendedTools: [] }),
      saveRuntimeSettings,
    } as unknown as ConfigStorePort;
    const writeSystemData = vi.fn(async () => ({ ok: true as const }));
    const config = fromPartial({ dataDir: '/runtime/system-data' });

    installPromotedToolsPersistenceHook(config, {
      configStore,
      systemDataWriter: { writeSystemData },
    });
    await config.runtimeHooks.persistPromotedExtendedTools(['memory_recall']);

    expect(saveRuntimeSettings).not.toHaveBeenCalled();
    expect(writeSystemData).toHaveBeenCalledWith({
      kind: 'owner_file',
      ownerFile: 'settings',
      payload: {
        promotedExtendedTools: ['memory_recall'],
      },
    });
  });

  it('surfaces an actionable error when gateway tool-pin persistence is unavailable', async () => {
    const configStore = {
      loadRuntimeSettings: () => ({ promotedExtendedTools: [] }),
      saveRuntimeSettings: vi.fn(),
    } as unknown as ConfigStorePort;
    const config = fromPartial({ dataDir: '/runtime/system-data' });
    installPromotedToolsPersistenceHook(config, {
      configStore,
      systemDataWriter: {
        writeSystemData: vi.fn(async () => {
          throw new Error('RPC connection closed');
        }),
      },
    });

    await expect(config.runtimeHooks.persistPromotedExtendedTools(['memory_recall']))
      .rejects.toThrow(/authenticated gateway system-data writer.*RPC connection closed/);
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
    writeHydrationOwnerExamples(systemDataDir, companionDataDir);
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
    writeHydrationOwnerExamples(systemDataDir, companionDataDir);

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
    writeHydrationOwnerExamples(systemDataDir, companionDataDir);

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
    writeHydrationOwnerExamples(systemDataDir, companionDataDir);

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
    writeHydrationOwnerExamples(systemDataDir, companionDataDir);

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
    saveSchedulerConfig(companionDataDir, {
      ...loadSchedulerSeedDefaults(),
      tickIntervalMs: 2_000,
      heartbeatIntervalMs: 8_000,
      backgroundMaintenance: {
        ...loadSchedulerSeedDefaults().backgroundMaintenance,
        intervalMs: 123_000,
      },
      backgroundWork: {
        supervisor: {
          maxConcurrentSessions: 3,
          leaseDurationMs: 45_000,
          retryBaseDelayMs: 2_000,
          retryMaxDelayMs: 60_000,
          shutdownTimeoutMs: 4_000,
          terminalRetentionMs: 90_000,
          cleanupIntervalMs: 30_000,
        },
        postTurn: {
          ...loadSchedulerSeedDefaults().backgroundWork.postTurn,
          extractionDrainRequeueDelayMs: 1_500,
          foregroundPreemptionDeferDelayMs: 2_500,
        },
      },
    });
    saveChargePolicyConfig(companionDataDir, {
      schemaVersion: 1,
      runChargeQuotaByLane: {
        interactive: 30,
        companion_social: 12,
        background: 10,
        maintenance: 0,
        subagent: 5,
        shard: 14,
      },
      surfaceCosts: {
        localImageGeneration: 0,
        paidImageGeneration: 6,
        analysisWorkbenchExtensionBand: 4,
        subagentLaunch: 1,
        shardLaunch: 8,
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
        premium_cloud: 4,
      },
      referenceModelClassPricingRationales: {
        cheap_cloud: 'Cheap cloud models are lightly priced to keep them available for routine use.',
        premium_cloud: 'Premium cloud models are intentionally more expensive to reserve for high-value calls.',
      },
      fatigue: makeTestFatiguePolicyConfig(),
      icpCostBreaker: loadChargePolicySeedDefaults().icpCostBreaker,
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
    expect(result.schedulerConfig.backgroundMaintenance.intervalMs).toBe(123_000);
    expect(result.schedulerConfig.backgroundMaintenance.sharedWorldWikiCaretaker)
      .toEqual({ batchSize: 25 });
    expect(result.schedulerConfig.backgroundWork).toEqual({
      supervisor: {
        maxConcurrentSessions: 3,
        leaseDurationMs: 45_000,
        retryBaseDelayMs: 2_000,
        retryMaxDelayMs: 60_000,
        shutdownTimeoutMs: 4_000,
        terminalRetentionMs: 90_000,
        cleanupIntervalMs: 30_000,
      },
      postTurn: {
        maxAttempts: loadSchedulerSeedDefaults().backgroundWork.postTurn.maxAttempts,
        extractionDrainRequeueDelayMs: 1_500,
        foregroundPreemptionDeferDelayMs: 2_500,
      },
    });
    expect(config.maintenanceIntervalMs).toBe(300_000);
    expect(config.providerRegistry?.providers.length).toBeGreaterThan(0);
    expect(config.litellmBaseUrl).toBeUndefined();
    expect(config.openRouterModelsApiUrl).toBe('https://openrouter.ai/api/v1/models');
    expect(result.trustPolicyConfig.channelClassification.defaultVisibility).toBeTruthy();
    expect(result.chargePolicyConfig.runChargeQuotaByLane.interactive).toBe(30);
    expect(config.chargePolicy?.surfaceCosts.shardLaunch).toBe(8);
    expect(result.diagnostics.legacySettingsKeys).toEqual([]);
  });

  it('hydrates observer eval sidecar settings for isolated test-persona deployments', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-hydration-sidecar-'));
    const systemDataDir = join(rootDir, 'system-data');
    const companionDataDir = join(rootDir, 'companion-data');
    const legacyDataDir = join(rootDir, 'legacy-data-empty');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(companionDataDir, { recursive: true });
    mkdirSync(legacyDataDir, { recursive: true });
    tempDirs.push(rootDir);
    writeHydrationOwnerExamples(systemDataDir, companionDataDir);

    const observerEvalSidecar = {
      ...createDefaultObserverEvalSidecarSettings(),
      enabled: true,
      sidecarId: 'observer-eval-test-persona',
      deploymentTarget: 'test_persona' as const,
      adapter: {
        kind: 'emosim_server' as const,
        serverUrl: 'http://emosim.test:17342',
        sessionLabel: 'psfn-observer-eval-test',
        agentName: 'observer',
        timeoutMs: 4000,
        includeWorldState: true,
      },
      persistence: {
        enabled: true,
        rootDir: join(rootDir, 'observer-eval-data'),
        retentionDays: 21,
        maxStoredObservations: 7500,
      },
      garden: {
        exposeHealth: true,
        exposeTelemetry: true,
      },
    };
    saveSettings(systemDataDir, { observerEvalSidecar });

    const config = makeStartupHydrationConfig(systemDataDir, companionDataDir);
    const result = hydrateCanonicalStartupConfig(config, {
      env: {
        ...process.env,
        CONFIG_DIR: './config',
        PSFN_RUNTIME_LAYOUT_MODE: 'continuous',
        DATA_DIR: legacyDataDir,
      },
    });

    expect(result.settingsDomains.runtime.observerEvalSidecar).toEqual(observerEvalSidecar);
    expect(config.observerEvalSidecar).toEqual(observerEvalSidecar);
  });

  it('accepts production observer levers at the canonical per-companion Kubernetes mount', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-hydration-sidecar-kube-'));
    const companionId = '11111111-1111-4111-8111-111111111111';
    const systemDataDir = join(rootDir, 'system-data');
    const companionDataDir = join(rootDir, 'companions', companionId);
    const observerPersistenceRootDir = join(rootDir, 'observer-eval-sidecar');
    const workspacePath = join(rootDir, 'workspaces', 'personal', companionId);
    const legacyDataDir = join(rootDir, 'legacy-data-empty');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(companionDataDir, { recursive: true });
    mkdirSync(workspacePath, { recursive: true });
    mkdirSync(legacyDataDir, { recursive: true });
    tempDirs.push(rootDir);
    writeHydrationOwnerExamples(systemDataDir, companionDataDir);

    const defaults = createDefaultObserverEvalSidecarSettings();
    const observerEvalSidecar = {
      ...defaults,
      enabled: true,
      deploymentTarget: 'live' as const,
      queue: {
        ...defaults.queue,
        observerTimeoutMs: 20_000,
      },
      adapter: {
        kind: 'emosim_server' as const,
        serverUrl: 'http://psfn-emosim:17342',
        sessionLabel: 'psfn-companion',
        agentName: 'companion',
        includeWorldState: false,
      },
      persistence: {
        enabled: true,
        rootDir: observerPersistenceRootDir,
        retentionDays: 90,
        maxStoredObservations: 100_000,
      },
      garden: {
        exposeHealth: true,
        exposeTelemetry: true,
      },
      levers: {
        ...createDefaultObserverEvalSidecarLeverSettings(),
        enabled: true,
      },
    };
    saveSettings(systemDataDir, { observerEvalSidecar });

    const config = {
      ...makeStartupHydrationConfig(systemDataDir, companionDataDir),
      workspacePath,
    };
    const result = hydrateCanonicalStartupConfig(config, {
      env: {
        ...process.env,
        CONFIG_DIR: './config',
        PSFN_RUNTIME_LAYOUT_MODE: 'continuous',
        DATA_DIR: legacyDataDir,
      },
    });

    expect(result.settingsDomains.runtime.observerEvalSidecar).toEqual(observerEvalSidecar);
    expect(config.observerEvalSidecar?.persistence.rootDir).toBe(observerPersistenceRootDir);
    expect(config.observerEvalSidecar?.levers?.enabled).toBe(true);
    expect(config.observerEvalSidecar?.garden.exposeTelemetry).toBe(true);
  });

  it('deep-merges a per-companion settings.overlay.json over the global settings (dnll.1)', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-hydration-overlay-'));
    const systemDataDir = join(rootDir, 'system-data');
    const companionDataDir = join(rootDir, 'companion-data');
    const legacyDataDir = join(rootDir, 'legacy-data-empty');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(companionDataDir, { recursive: true });
    mkdirSync(legacyDataDir, { recursive: true });
    tempDirs.push(rootDir);
    writeHydrationOwnerExamples(systemDataDir, companionDataDir);

    const globalSidecar = {
      ...createDefaultObserverEvalSidecarSettings(),
      enabled: true,
      adapter: {
        kind: 'emosim_server' as const,
        serverUrl: 'http://emosim.test:17342',
        sessionLabel: 'psfn-fleet-shared',
        agentName: 'fleet',
        includeWorldState: false,
      },
    };
    saveSettings(systemDataDir, {
      activeTimezone: 'UTC',
      uiThemeId: 'default',
      imageProvider: 'fal',
      imageFalCreateModel: 'xai/grok-imagine-image',
      imageFalEditModel: 'xai/grok-imagine-image/quality/edit',
      imageSelfieEditModel: 'fal-ai/nano-banana-2/edit',
      modelPurposeSelection: { chat: 'primary', background: 'extraction' },
      observerEvalSidecar: globalSidecar,
    });

    // Per-companion overlay: override the clock, theme, and only the sidecar
    // sessionLabel (the emosim session-collision fix).
    writeFileSync(
      join(companionDataDir, COMPANION_SETTINGS_OVERLAY_FILE_NAME),
      JSON.stringify({
        activeTimezone: 'Europe/Berlin',
        uiThemeId: 'dusk',
        imageProvider: 'comfyui',
        imageSelfieEditModel: 'xai/grok-imagine-image/quality/edit',
        modelPurposeSelection: { chat: 'kimi-k2.5' },
        observerEvalSidecar: { adapter: { sessionLabel: 'psfn-companion' } },
      }),
      'utf-8',
    );

    const config = makeStartupHydrationConfig(systemDataDir, companionDataDir);
    hydrateCanonicalStartupConfig(config, {
      env: {
        ...process.env,
        CONFIG_DIR: './config',
        PSFN_RUNTIME_LAYOUT_MODE: 'continuous',
        DATA_DIR: legacyDataDir,
      },
    });

    expect(config.activeTimezone).toBe('Europe/Berlin');
    expect(config.uiThemeId).toBe('dusk');
    expect(config.imageProvider).toBe('comfyui');
    expect(config.imageFalCreateModel).toBe('xai/grok-imagine-image');
    expect(config.imageFalEditModel).toBe('xai/grok-imagine-image/quality/edit');
    expect(config.imageSelfieEditModel).toBe('xai/grok-imagine-image/quality/edit');
    // 23pp: the companion's chat selection overrides the global one; the
    // untouched background selection deep-merges through from settings.json,
    // and both validated against the seeded models.json registry.
    expect(config.modelPurposeSelection).toEqual({
      chat: 'kimi-k2.5',
      background: 'extraction',
    });
    // Nested deep-merge: only sessionLabel changes; global sidecar fields survive.
    expect(config.observerEvalSidecar?.enabled).toBe(true);
    expect(config.observerEvalSidecar?.adapter.serverUrl).toBe('http://emosim.test:17342');
    expect(config.observerEvalSidecar?.adapter.agentName).toBe('fleet');
    expect(config.observerEvalSidecar?.adapter.sessionLabel).toBe('psfn-companion');
  });

  it('fails closed when a companion overlay selects a model slot missing from models.json (23pp)', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-hydration-overlay-badslot-'));
    const systemDataDir = join(rootDir, 'system-data');
    const companionDataDir = join(rootDir, 'companion-data');
    const legacyDataDir = join(rootDir, 'legacy-data-empty');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(companionDataDir, { recursive: true });
    mkdirSync(legacyDataDir, { recursive: true });
    tempDirs.push(rootDir);
    writeHydrationOwnerExamples(systemDataDir, companionDataDir);

    saveSettings(systemDataDir, { activeTimezone: 'UTC' });
    writeFileSync(
      join(companionDataDir, 'settings.overlay.json'),
      JSON.stringify({ modelPurposeSelection: { vision: 'not-a-registry-slot' } }),
      'utf-8',
    );

    const config = makeStartupHydrationConfig(systemDataDir, companionDataDir);
    expect(() => hydrateCanonicalStartupConfig(config, {
      env: {
        ...process.env,
        CONFIG_DIR: './config',
        PSFN_RUNTIME_LAYOUT_MODE: 'continuous',
        DATA_DIR: legacyDataDir,
      },
    })).toThrow(/modelPurposeSelection\.vision.*"not-a-registry-slot"/s);
  });

  it('is byte-identical to the global settings when no overlay is present (dnll.1)', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-hydration-no-overlay-'));
    const systemDataDir = join(rootDir, 'system-data');
    const companionDataDir = join(rootDir, 'companion-data');
    const legacyDataDir = join(rootDir, 'legacy-data-empty');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(companionDataDir, { recursive: true });
    mkdirSync(legacyDataDir, { recursive: true });
    tempDirs.push(rootDir);
    writeHydrationOwnerExamples(systemDataDir, companionDataDir);

    saveSettings(systemDataDir, { activeTimezone: 'UTC', uiThemeId: 'default' });

    const config = makeStartupHydrationConfig(systemDataDir, companionDataDir);
    hydrateCanonicalStartupConfig(config, {
      env: {
        ...process.env,
        CONFIG_DIR: './config',
        PSFN_RUNTIME_LAYOUT_MODE: 'continuous',
        DATA_DIR: legacyDataDir,
      },
    });

    expect(config.activeTimezone).toBe('UTC');
    expect(config.uiThemeId).toBe('default');
  });

  it('fails closed on a non-whitelisted key in a companion overlay (dnll.1)', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-hydration-overlay-reject-'));
    const systemDataDir = join(rootDir, 'system-data');
    const companionDataDir = join(rootDir, 'companion-data');
    const legacyDataDir = join(rootDir, 'legacy-data-empty');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(companionDataDir, { recursive: true });
    mkdirSync(legacyDataDir, { recursive: true });
    tempDirs.push(rootDir);
    writeHydrationOwnerExamples(systemDataDir, companionDataDir);

    saveSettings(systemDataDir, { activeTimezone: 'UTC' });
    writeFileSync(
      join(companionDataDir, COMPANION_SETTINGS_OVERLAY_FILE_NAME),
      JSON.stringify({ activeTimezone: 'Europe/Berlin', capabilityTier: 'autonomous' }),
      'utf-8',
    );

    const config = makeStartupHydrationConfig(systemDataDir, companionDataDir);
    expect(() => hydrateCanonicalStartupConfig(config, {
      env: {
        ...process.env,
        CONFIG_DIR: './config',
        PSFN_RUNTIME_LAYOUT_MODE: 'continuous',
        DATA_DIR: legacyDataDir,
      },
    })).toThrow(/non-whitelisted keys: capabilityTier/);
  });

  it('fails closed when observer eval persistence shares a runtime state root', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-hydration-sidecar-overlap-'));
    const systemDataDir = join(rootDir, 'system-data');
    const companionDataDir = join(rootDir, 'companion-data');
    const legacyDataDir = join(rootDir, 'legacy-data-empty');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(companionDataDir, { recursive: true });
    mkdirSync(legacyDataDir, { recursive: true });
    tempDirs.push(rootDir);
    writeHydrationOwnerExamples(systemDataDir, companionDataDir);

    saveSettings(systemDataDir, {
      observerEvalSidecar: {
        ...createDefaultObserverEvalSidecarSettings(),
        enabled: true,
        adapter: {
          kind: 'emosim_server',
          serverUrl: 'http://emosim.test:17342',
          sessionLabel: 'psfn-observer-eval-test',
          agentName: 'observer',
          includeWorldState: false,
        },
        persistence: {
          enabled: true,
          rootDir: join(companionDataDir, 'observer-eval'),
          retentionDays: 14,
          maxStoredObservations: 1000,
        },
      },
    });

    const config = makeStartupHydrationConfig(systemDataDir, companionDataDir);
    expect(() => hydrateCanonicalStartupConfig(config, {
      env: {
        ...process.env,
        CONFIG_DIR: './config',
        PSFN_RUNTIME_LAYOUT_MODE: 'continuous',
        DATA_DIR: legacyDataDir,
      },
    })).toThrow('observerEvalSidecar.persistence.rootDir');
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
    writeHydrationOwnerExamples(systemDataDir, companionDataDir);

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
    saveSchedulerConfig(companionDataDir, {
      ...loadSchedulerSeedDefaults(),
      tickIntervalMs: 2_000,
      heartbeatIntervalMs: 7_000,
      backgroundMaintenance: {
        ...loadSchedulerSeedDefaults().backgroundMaintenance,
        intervalMs: 222_000,
      },
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
    writeHydrationOwnerExamples(systemDataDir, companionDataDir);

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
    writeHydrationOwnerExamples(systemDataDir, companionDataDir);

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
    writeHydrationOwnerExamples(systemDataDir, companionDataDir);

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
