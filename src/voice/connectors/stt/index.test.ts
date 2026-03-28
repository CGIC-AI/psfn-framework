import { describe, expect, it, vi } from 'vitest';
import { createEnvCredentialVault } from '../../../custody/credential-vault.js';
import { DeepgramStreamingSttConnector } from './deepgram-stream.js';
import {
  createStreamingSttConnector,
  getStreamingSttProviderEligibility,
  getStreamingSttProviderMetadata,
  registerStreamingSttProvider,
  resolveStreamingSttRuntimeConfig,
} from './index.js';
import type { StreamingSttConnector } from './types.js';

function createStubConnector(id: string): StreamingSttConnector {
  return {
    id,
    startStream: vi.fn(async () => ({
      transcripts: (async function* emptyTranscripts() {})(),
      writeAudio: async () => {},
      endInput: async () => {},
      cancel: async () => {},
    })),
  };
}

describe('createStreamingSttConnector', () => {
  it('creates the Deepgram connector for provider "deepgram"', () => {
    const connector = createStreamingSttConnector('deepgram', {
      apiKey: 'test-key',
      model: 'nova-3',
    });

    expect(connector).toBeInstanceOf(DeepgramStreamingSttConnector);
    expect(connector.id).toBe('deepgram');
  });

  it('dispatches to a registered provider without core switch edits', () => {
    const connector = createStubConnector('plugin-test');
    const factory = vi.fn((config: { endpoint: string }) => {
      expect(config).toEqual({ endpoint: 'wss://plugin-stt.invalid' });
      return connector;
    });
    const restoreProvider = registerStreamingSttProvider('plugin-test', {
      createConnector: factory,
      metadata: {
        isConfigured: (config) => Boolean(config.pluginSttToken),
      },
    });

    try {
      const result = createStreamingSttConnector('plugin-test', {
        endpoint: 'wss://plugin-stt.invalid',
      });

      expect(factory).toHaveBeenCalledTimes(1);
      expect(result).toBe(connector);
    } finally {
      restoreProvider();
    }
  });

  it('exposes provider metadata without runtime auto-selection', () => {
    const restoreProvider = registerStreamingSttProvider('plugin-test', {
      createConnector: vi.fn(() => createStubConnector('plugin-test')),
      metadata: {
        isConfigured: (config) => Boolean(config.pluginSttToken),
        eligibility: {},
      },
    });

    try {
      expect(getStreamingSttProviderMetadata('deepgram')?.isConfigured({ deepgramApiKey: 'test-key' })).toBe(true);
      expect(getStreamingSttProviderEligibility('deepgram')).toEqual({
        requiredTokens: ['external.web'],
      });
      expect(getStreamingSttProviderMetadata('plugin-test')?.isConfigured({ pluginSttToken: 'plugin-key' })).toBe(true);
    } finally {
      restoreProvider();
    }
  });

  it('throws a deterministic error for invalid providers', () => {
    expect(() => createStreamingSttConnector('invalid-provider', {})).toThrow(
      'Unsupported streaming STT provider: invalid-provider',
    );
  });

  it('resolves built-in runtime config without entrypoint switch logic', () => {
    expect(resolveStreamingSttRuntimeConfig('deepgram', {
      deepgramApiKey: 'test-key',
      deepgramModel: 'nova-3',
      deepgramSttEndpoint: 'wss://api.deepgram.com/v1/listen',
    })).toEqual({
      apiKey: 'test-key',
      model: 'nova-3',
      endpoint: 'wss://api.deepgram.com/v1/listen',
    });
  });

  it('resolves built-in runtime config from the credential vault when inline secrets are absent', () => {
    expect(resolveStreamingSttRuntimeConfig('deepgram', {
      credentialVault: createEnvCredentialVault({
        DEEPGRAM_API_KEY: 'vault-key',
      }),
      deepgramModel: 'nova-3',
      deepgramSttEndpoint: 'wss://api.deepgram.com/v1/listen',
    })).toEqual({
      apiKey: 'vault-key',
      model: 'nova-3',
      endpoint: 'wss://api.deepgram.com/v1/listen',
    });
  });

  it('resolves registered provider runtime config without core switch edits', () => {
    const restoreProvider = registerStreamingSttProvider('plugin-test', {
      createConnector: vi.fn(() => createStubConnector('plugin-test')),
      metadata: {
        isConfigured: (config) => Boolean(config.pluginSttToken),
      },
      resolveRuntimeConfig: (config) => ({ endpoint: String(config.pluginSttEndpoint) }),
    });

    try {
      expect(resolveStreamingSttRuntimeConfig('plugin-test', {
        pluginSttToken: 'plugin-key',
        pluginSttEndpoint: 'wss://plugin-stt.invalid',
      })).toEqual({
        endpoint: 'wss://plugin-stt.invalid',
      });
    } finally {
      restoreProvider();
    }
  });

  it('fails closed when a provider lacks runtime bootstrap config', () => {
    const restoreProvider = registerStreamingSttProvider('plugin-test', {
      createConnector: vi.fn(() => createStubConnector('plugin-test')),
      metadata: {
        isConfigured: (config) => Boolean(config.pluginSttToken),
      },
    });

    try {
      expect(() => resolveStreamingSttRuntimeConfig('plugin-test', {
        pluginSttToken: 'plugin-key',
      })).toThrow('Streaming STT provider "plugin-test" does not expose runtime bootstrap config');
    } finally {
      restoreProvider();
    }
  });
});
