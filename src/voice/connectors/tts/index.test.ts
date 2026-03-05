import { describe, expect, it, vi } from 'vitest';
import { ElevenLabsStreamingTtsConnector } from './elevenlabs-stream.js';
import { EchoStreamingTtsConnector } from './echo-stream.js';
import {
  createStreamingTtsConnector,
  registerStreamingTtsConnectorFactory,
  registerStreamingTtsProvider,
  getStreamingTtsProviderMetadata,
  resolveDefaultStreamingTtsProvider,
  resolveStreamingTtsRuntimeConfig,
  type EchoStreamingTtsConfig,
} from './index.js';
import type { StreamingTtsConnector, TtsAudioChunk } from './types.js';

function createStubConnector(id: string): StreamingTtsConnector {
  return {
    id,
    synthesizeStream: vi.fn(async () => ({
      audio: (async function* emptyAudio(): AsyncGenerator<TtsAudioChunk> {})(),
      cancel: async (): Promise<void> => {},
    })),
    synthesizeBuffer: vi.fn(async () => Buffer.alloc(0)),
  };
}

describe('createStreamingTtsConnector', () => {
  it('creates the ElevenLabs connector for provider "elevenlabs"', () => {
    const connector = createStreamingTtsConnector('elevenlabs', {
      apiKey: 'test-key',
      voiceId: 'test-voice',
    });

    expect(connector).toBeInstanceOf(ElevenLabsStreamingTtsConnector);
    expect(connector.id).toBe('elevenlabs');
  });

  it('creates the Echo connector for provider "echo"', () => {
    const connector = createStreamingTtsConnector('echo', {
      url: 'http://127.0.0.1:5050/v1/audio/speech',
      voice: 'echo-voice-1',
      preset: 'normal',
      model: 'echo-v1',
    });

    expect(connector).toBeInstanceOf(EchoStreamingTtsConnector);
    expect(connector.id).toBe('echo');
  });

  it('dispatches to a registered factory for provider "echo"', () => {
    const connector = createStubConnector('echo-test');
    const factory = vi.fn((config: EchoStreamingTtsConfig) => {
      expect(config).toMatchObject({
        url: 'http://127.0.0.1:5050/v1/audio/speech',
        voice: 'echo-voice-1',
        preset: 'normal',
        model: 'echo-v1',
      });
      return connector;
    });
    const restoreFactory = registerStreamingTtsConnectorFactory('echo', factory);

    try {
      const result = createStreamingTtsConnector('echo', {
        url: 'http://127.0.0.1:5050/v1/audio/speech',
        voice: 'echo-voice-1',
        preset: 'normal',
        model: 'echo-v1',
      });

      expect(factory).toHaveBeenCalledTimes(1);
      expect(result).toBe(connector);
    } finally {
      restoreFactory();
    }
  });

  it('throws a deterministic error for invalid providers', () => {
    expect(() => createStreamingTtsConnector('invalid-provider' as never, {} as never)).toThrow(
      'Unsupported streaming TTS provider: invalid-provider',
    );
  });

  it('dispatches to a registered provider without core switch edits', () => {
    const connector = createStubConnector('plugin-test');
    const factory = vi.fn((config: { endpoint: string }) => {
      expect(config).toEqual({ endpoint: 'https://plugin-tts.invalid' });
      return connector;
    });
    const restoreProvider = registerStreamingTtsProvider('plugin-test', {
      createConnector: factory,
      metadata: {
        isConfigured: (config) => Boolean(config.pluginTtsToken),
      },
    });

    try {
      const result = createStreamingTtsConnector('plugin-test', {
        endpoint: 'https://plugin-tts.invalid',
      });

      expect(factory).toHaveBeenCalledTimes(1);
      expect(result).toBe(connector);
    } finally {
      restoreProvider();
    }
  });

  it('exposes provider metadata for default provider selection', () => {
    const restoreProvider = registerStreamingTtsProvider('plugin-test', {
      createConnector: vi.fn(() => createStubConnector('plugin-test')),
      metadata: {
        canAutoEnable: true,
        isConfigured: (config) => Boolean(config.pluginTtsToken),
      },
    });

    try {
      expect(getStreamingTtsProviderMetadata('elevenlabs')?.isConfigured({
        elevenLabsApiKey: 'elevenlabs-key',
      })).toBe(true);
      expect(resolveDefaultStreamingTtsProvider({ pluginTtsToken: 'plugin-key', elevenLabsApiKey: '' })).toBe('plugin-test');
    } finally {
      restoreProvider();
    }
  });

  it('resolves built-in runtime config without entrypoint switch logic', () => {
    expect(resolveStreamingTtsRuntimeConfig('echo', {
      echoTtsUrl: 'http://127.0.0.1:5050/v1/audio/speech',
      echoTtsVoice: 'echo-voice-1',
      echoTtsPreset: 'normal',
      echoTtsModel: 'echo-v1',
    })).toEqual({
      url: 'http://127.0.0.1:5050/v1/audio/speech',
      voice: 'echo-voice-1',
      preset: 'normal',
      model: 'echo-v1',
    });
  });

  it('resolves registered provider runtime config without core switch edits', () => {
    const restoreProvider = registerStreamingTtsProvider('plugin-test', {
      createConnector: vi.fn(() => createStubConnector('plugin-test')),
      metadata: {
        isConfigured: (config) => Boolean(config.pluginTtsToken),
      },
      resolveRuntimeConfig: (config) => ({ endpoint: String(config.pluginTtsEndpoint) }),
    });

    try {
      expect(resolveStreamingTtsRuntimeConfig('plugin-test', {
        pluginTtsToken: 'plugin-key',
        pluginTtsEndpoint: 'https://plugin-tts.invalid',
      })).toEqual({
        endpoint: 'https://plugin-tts.invalid',
      });
    } finally {
      restoreProvider();
    }
  });

  it('fails closed when a provider lacks runtime bootstrap config', () => {
    const restoreProvider = registerStreamingTtsProvider('plugin-test', {
      createConnector: vi.fn(() => createStubConnector('plugin-test')),
      metadata: {
        isConfigured: (config) => Boolean(config.pluginTtsToken),
      },
    });

    try {
      expect(() => resolveStreamingTtsRuntimeConfig('plugin-test', {
        pluginTtsToken: 'plugin-key',
      })).toThrow('Streaming TTS provider "plugin-test" does not expose runtime bootstrap config');
    } finally {
      restoreProvider();
    }
  });
});
