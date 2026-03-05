import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSettings } from '../settings.js';
import {
  createRuntimeVoiceSttConnector,
  createRuntimeVoiceTtsConnector,
  installPromotedToolsPersistenceHook,
  resolveRuntimeVoiceProviderGate,
  resolveRuntimeVoiceSttProvider,
  resolveRuntimeVoiceTtsProviderOrder,
  resolveRuntimeVoiceTtsProvider,
} from './bootstrap-helpers.js';
import { registerStreamingSttProvider } from '../voice/connectors/stt/index.js';
import { registerStreamingTtsProvider } from '../voice/connectors/tts/index.js';

describe('resolveRuntimeVoiceSttProvider', () => {
  it('uses explicit provider when configured', () => {
    expect(resolveRuntimeVoiceSttProvider({ sttProvider: 'deepgram' } as any)).toBe('deepgram');
    expect(resolveRuntimeVoiceSttProvider({ sttProvider: 'disabled' } as any)).toBe('disabled');
  });

  it('falls back to deepgram when api key is present', () => {
    expect(resolveRuntimeVoiceSttProvider({ deepgramApiKey: 'key' } as any)).toBe('deepgram');
  });

  it('falls back to disabled when not configured and no api key is set', () => {
    expect(resolveRuntimeVoiceSttProvider({} as any)).toBe('disabled');
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

  it('falls back to elevenlabs when api key is present', () => {
    expect(resolveRuntimeVoiceTtsProvider({ elevenLabsApiKey: 'elevenlabs-key' } as any)).toBe('elevenlabs');
  });

  it('falls back to disabled when not configured and no TTS credentials are set', () => {
    expect(resolveRuntimeVoiceTtsProvider({} as any)).toBe('disabled');
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
  it('enables deepgram + elevenlabs by default when credentials are present', () => {
    const gate = resolveRuntimeVoiceProviderGate({
      deepgramApiKey: 'deepgram-key',
      elevenLabsApiKey: 'elevenlabs-key',
    } as any);
    expect(gate).toEqual({
      sttProvider: 'deepgram',
      ttsProvider: 'elevenlabs',
      sttEnabled: true,
      ttsEnabled: true,
    });
  });

  it('requires explicit echo URL/voice by default', () => {
    const gate = resolveRuntimeVoiceProviderGate({
      deepgramApiKey: 'deepgram-key',
      ttsProvider: 'echo',
      echoTtsUrl: '',
      echoTtsVoice: '',
    } as any);
    expect(gate).toEqual({
      sttProvider: 'deepgram',
      ttsProvider: 'echo',
      sttEnabled: true,
      ttsEnabled: false,
    });
  });

  it('can allow echo defaults for websocket runtime gating', () => {
    const gate = resolveRuntimeVoiceProviderGate(
      {
        deepgramApiKey: 'deepgram-key',
        ttsProvider: 'echo',
      } as any,
      { allowEchoDefaults: true },
    );
    expect(gate).toEqual({
      sttProvider: 'deepgram',
      ttsProvider: 'echo',
      sttEnabled: true,
      ttsEnabled: true,
    });
  });

  it('can require explicit elevenlabs voice id when needed', () => {
    const strictGate = resolveRuntimeVoiceProviderGate(
      {
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
        deepgramApiKey: 'deepgram-key',
        ttsProvider: 'elevenlabs',
        elevenLabsApiKey: 'elevenlabs-key',
        elevenLabsVoiceId: '',
      } as any,
    );
    expect(relaxedGate.ttsEnabled).toBe(true);
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
        canAutoEnable: true,
        isConfigured: (config) => Boolean(config.pluginSttToken),
      },
    });

    try {
      const enabledGate = resolveRuntimeVoiceProviderGate({
        sttProvider: 'plugin-test',
        pluginSttToken: 'plugin-key',
      } as any);
      expect(enabledGate.sttEnabled).toBe(true);
      expect(enabledGate.sttProvider).toBe('plugin-test');

      const defaultGate = resolveRuntimeVoiceProviderGate({
        pluginSttToken: 'plugin-key',
      } as any);
      expect(defaultGate.sttEnabled).toBe(true);
      expect(defaultGate.sttProvider).toBe('plugin-test');

      const disabledGate = resolveRuntimeVoiceProviderGate({
        sttProvider: 'plugin-test',
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
        canAutoEnable: true,
        isConfigured: (config) => Boolean(config.pluginTtsToken),
      },
    });

    try {
      const enabledGate = resolveRuntimeVoiceProviderGate({
        ttsProvider: 'plugin-test',
        pluginTtsToken: 'plugin-key',
      } as any);
      expect(enabledGate.ttsEnabled).toBe(true);
      expect(enabledGate.ttsProvider).toBe('plugin-test');

      const defaultGate = resolveRuntimeVoiceProviderGate({
        pluginTtsToken: 'plugin-key',
        elevenLabsApiKey: '',
      } as any);
      expect(defaultGate.ttsEnabled).toBe(true);
      expect(defaultGate.ttsProvider).toBe('plugin-test');

      const disabledGate = resolveRuntimeVoiceProviderGate({
        ttsProvider: 'plugin-test',
      } as any);
      expect(disabledGate.ttsEnabled).toBe(false);
    } finally {
      restoreProvider();
    }
  });
});

describe('createRuntimeVoiceSttConnector', () => {
  it('returns null when the resolved provider is disabled or unconfigured', () => {
    expect(createRuntimeVoiceSttConnector({} as any)).toBeNull();
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
});

describe('createRuntimeVoiceTtsConnector', () => {
  it('returns null when the resolved provider is disabled or unconfigured', () => {
    expect(createRuntimeVoiceTtsConnector({} as any)).toBeNull();
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
});

describe('resolveRuntimeVoiceTtsProviderOrder', () => {
  it('keeps the preferred provider first and appends other configured providers', () => {
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
      } as any)).toEqual(['plugin-test', 'elevenlabs']);
    } finally {
      restoreProvider();
    }
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
});
