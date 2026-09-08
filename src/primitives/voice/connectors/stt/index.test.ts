import { describe, expect, it, vi } from 'vitest';
import { createEnvCredentialVault } from '../../../../boundary/custody/credential-vault.js';
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

  it('consumes the gateway-resolved credential and never reaches for a vault (mp1pf)', () => {
    // hydrateSecretBearingConfig resolves DEEPGRAM_API_KEY (inline, vault, or
    // env) on the gateway side and writes the plain value onto the substrate
    // config. The shared index only reads that resolved value.
    expect(resolveStreamingSttRuntimeConfig('deepgram', {
      deepgramApiKey: 'gateway-resolved-key',
      deepgramModel: 'nova-3',
      deepgramSttEndpoint: 'wss://api.deepgram.com/v1/listen',
    })).toEqual({
      apiKey: 'gateway-resolved-key',
      model: 'nova-3',
      endpoint: 'wss://api.deepgram.com/v1/listen',
    });

    // A config that carries only a vault handle is unconfigured here: the index
    // must not resolve credentials itself, and must fail closed rather than
    // silently importing the secret-bearing custody module.
    const vaultOnlyConfig = {
      credentialVault: createEnvCredentialVault({ DEEPGRAM_API_KEY: 'vault-key' }),
      deepgramModel: 'nova-3',
      deepgramSttEndpoint: 'wss://api.deepgram.com/v1/listen',
    };
    expect(getStreamingSttProviderMetadata('deepgram')?.isConfigured(vaultOnlyConfig)).toBe(false);
    expect(() => resolveStreamingSttRuntimeConfig('deepgram', vaultOnlyConfig)).toThrow(
      'Deepgram STT provider selected but DEEPGRAM_API_KEY is not configured',
    );
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
