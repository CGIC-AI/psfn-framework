import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import { createEligibilityGate } from '../../system/capabilities/eligibility.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { StreamingSttConnector } from '../../voice/connectors/stt/types.js';
import type { StreamingTtsConnector } from '../../voice/connectors/tts/types.js';
import { registerStreamingSttProvider } from '../../voice/connectors/stt/index.js';
import { registerStreamingTtsProvider } from '../../voice/connectors/tts/index.js';

const {
  createStreamingSttConnectorMock,
  createStreamingTtsConnectorMock,
} = vi.hoisted(() => ({
  createStreamingSttConnectorMock: vi.fn(),
  createStreamingTtsConnectorMock: vi.fn(),
}));

vi.mock('../../voice/connectors/stt/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../voice/connectors/stt/index.js')>();
  return {
    ...actual,
    createStreamingSttConnector: createStreamingSttConnectorMock,
  };
});

vi.mock('../../voice/connectors/tts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../voice/connectors/tts/index.js')>();
  return {
    ...actual,
    createStreamingTtsConnector: createStreamingTtsConnectorMock,
  };
});

import { createApiVoiceWebSocketRuntime } from './voice-websocket-runtime.js';

// Echo TTS no longer has silent defaults — requires explicit config

function createStubSttConnector(): StreamingSttConnector {
  return {
    id: 'deepgram-test',
    startStream: vi.fn(async () => ({
      transcripts: (async function* emptyTranscripts() {})(),
      writeAudio: async () => {},
      endInput: async () => {},
      cancel: async () => {},
    })),
  };
}

function createStubTtsConnector(): StreamingTtsConnector {
  return {
    id: 'tts-test',
    synthesizeStream: vi.fn(async () => ({
      audio: (async function* emptyAudio() {})(),
      cancel: async () => {},
    })),
    synthesizeBuffer: vi.fn(async () => Buffer.alloc(0)),
  };
}

type RuntimeVoiceTestOverrides = Partial<SubstrateConfig> & {
  sttProvider?: SubstrateConfig['sttProvider'] | 'disabled';
  ttsProvider?: SubstrateConfig['ttsProvider'] | 'disabled';
};

function createTestOptions(configOverrides: RuntimeVoiceTestOverrides = {}) {
  const config = {
    deepgramApiKey: 'deepgram-key',
    deepgramModel: 'nova-3',
    deepgramSttEndpoint: 'wss://api.deepgram.com/v1/listen',
    deepgramListenEndpoint: 'https://api.deepgram.com/v1/listen',
    elevenLabsApiKey: 'elevenlabs-key',
    elevenLabsVoiceId: 'voice-id',
    elevenLabsModelId: 'eleven_turbo_v2_5',
    elevenLabsEndpointBase: 'https://api.elevenlabs.io/v1',
    ...configOverrides,
  } as SubstrateConfig;

  return {
    agentLoop: {
      handleMessage: vi.fn(),
    } as unknown as SubstrateAgent,
    eventBus: {
      emit: vi.fn(async () => {}),
    } as unknown as EventBus,
    config,
  };
}

describe('createApiVoiceWebSocketRuntime provider wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createStreamingSttConnectorMock.mockReturnValue(createStubSttConnector());
    createStreamingTtsConnectorMock.mockReturnValue(createStubTtsConnector());
  });

  it('returns undefined when Deepgram credentials are missing', () => {
    const runtime = createApiVoiceWebSocketRuntime(createTestOptions({
      deepgramApiKey: '',
    }));

    expect(runtime).toBeUndefined();
    expect(createStreamingSttConnectorMock).not.toHaveBeenCalled();
    expect(createStreamingTtsConnectorMock).not.toHaveBeenCalled();
  });

  it('returns undefined when STT provider is explicitly disabled', () => {
    const runtime = createApiVoiceWebSocketRuntime(createTestOptions({
      sttProvider: 'disabled',
    }));

    expect(runtime).toBeUndefined();
    expect(createStreamingSttConnectorMock).not.toHaveBeenCalled();
    expect(createStreamingTtsConnectorMock).not.toHaveBeenCalled();
  });

  it('returns undefined when TTS provider is explicitly disabled', () => {
    const runtime = createApiVoiceWebSocketRuntime(createTestOptions({
      ttsProvider: 'disabled',
    }));

    expect(runtime).toBeUndefined();
    expect(createStreamingSttConnectorMock).not.toHaveBeenCalled();
    expect(createStreamingTtsConnectorMock).not.toHaveBeenCalled();
  });

  it('uses deepgram STT when provider is explicitly set to deepgram', () => {
    const runtime = createApiVoiceWebSocketRuntime(createTestOptions({
      sttProvider: 'deepgram',
      ttsProvider: 'elevenlabs',
    }));

    expect(runtime).toBeDefined();
    expect(createStreamingSttConnectorMock).toHaveBeenCalledWith('deepgram', {
      apiKey: 'deepgram-key',
      model: 'nova-3',
      endpoint: 'wss://api.deepgram.com/v1/listen',
    });
  });

  it('returns undefined for elevenlabs provider when ElevenLabs credentials are missing', () => {
    const runtime = createApiVoiceWebSocketRuntime(createTestOptions({
      ttsProvider: 'elevenlabs',
      elevenLabsApiKey: '',
      elevenLabsVoiceId: '',
    }));

    expect(runtime).toBeUndefined();
    expect(createStreamingSttConnectorMock).not.toHaveBeenCalled();
    expect(createStreamingTtsConnectorMock).not.toHaveBeenCalled();
  });

  it('fails closed when TTS provider is unset even if elevenlabs credentials exist', () => {
    const runtime = createApiVoiceWebSocketRuntime(createTestOptions({
      ttsProvider: undefined,
      elevenLabsModelId: 'eleven_turbo_v2_5',
    }));

    expect(runtime).toBeUndefined();
    expect(createStreamingSttConnectorMock).not.toHaveBeenCalled();
    expect(createStreamingTtsConnectorMock).not.toHaveBeenCalled();
  });

  it('builds runtime when elevenlabs and deepgram providers are explicitly set', () => {
    const runtime = createApiVoiceWebSocketRuntime(createTestOptions({
      sttProvider: 'deepgram',
      ttsProvider: 'elevenlabs',
      elevenLabsApiKey: 'elevenlabs-key',
      elevenLabsVoiceId: 'voice-id',
      elevenLabsModelId: 'eleven_turbo_v2_5',
    }));

    expect(runtime).toBeDefined();
    expect(createStreamingSttConnectorMock).toHaveBeenCalledWith('deepgram', {
      apiKey: 'deepgram-key',
      model: 'nova-3',
      endpoint: 'wss://api.deepgram.com/v1/listen',
    });
    expect(createStreamingTtsConnectorMock).toHaveBeenCalledWith('elevenlabs', {
      apiKey: 'elevenlabs-key',
      voiceId: 'voice-id',
      modelId: 'eleven_turbo_v2_5',
      endpointBase: 'https://api.elevenlabs.io/v1',
    });
  });

  it('throws when echo provider selected without explicit Echo config', () => {
    expect(() => createApiVoiceWebSocketRuntime(createTestOptions({
      sttProvider: 'deepgram',
      ttsProvider: 'echo',
      elevenLabsApiKey: undefined,
      elevenLabsVoiceId: undefined,
      echoTtsUrl: undefined,
      echoTtsVoice: undefined,
      echoTtsPreset: undefined,
      echoTtsModel: undefined,
    }))).toThrow('Echo TTS provider selected but ECHO_TTS_URL and ECHO_TTS_VOICE are not configured');
  });

  it('passes explicit echo provider overrides through to connector config', () => {
    const runtime = createApiVoiceWebSocketRuntime(createTestOptions({
      sttProvider: 'deepgram',
      ttsProvider: 'echo',
      elevenLabsApiKey: '',
      elevenLabsVoiceId: '',
      echoTtsUrl: 'http://127.0.0.1:5050/v1/audio/speech',
      echoTtsVoice: 'echo-voice-1',
      echoTtsPreset: 'normal',
      echoTtsModel: 'echo-v1',
    }));

    expect(runtime).toBeDefined();
    expect(createStreamingTtsConnectorMock).toHaveBeenCalledWith('echo', {
      url: 'http://127.0.0.1:5050/v1/audio/speech',
      voice: 'echo-voice-1',
      preset: 'normal',
      model: 'echo-v1',
    });
  });

  it('supports registered STT/TTS providers without built-in provider switches', () => {
    const restoreStt = registerStreamingSttProvider('plugin-stt', {
      createConnector: vi.fn(() => createStubSttConnector()),
      metadata: {
        isConfigured: (config) => Boolean(config.pluginSttToken),
        eligibility: {},
      },
      resolveRuntimeConfig: (config) => ({
        endpoint: String(config.pluginSttEndpoint),
      }),
    });
    const restoreTts = registerStreamingTtsProvider('plugin-tts', {
      createConnector: vi.fn(() => createStubTtsConnector()),
      metadata: {
        isConfigured: (config) => Boolean(config.pluginTtsToken),
        eligibility: {},
      },
      resolveRuntimeConfig: (config) => ({
        endpoint: String(config.pluginTtsEndpoint),
      }),
    });

    try {
      const runtime = createApiVoiceWebSocketRuntime(createTestOptions({
        sttProvider: 'plugin-stt',
        ttsProvider: 'plugin-tts',
        pluginSttToken: 'plugin-stt-key',
        pluginSttEndpoint: 'wss://plugin-stt.invalid',
        pluginTtsToken: 'plugin-tts-key',
        pluginTtsEndpoint: 'https://plugin-tts.invalid',
        deepgramApiKey: '',
        elevenLabsApiKey: '',
        elevenLabsVoiceId: '',
      }));

      expect(runtime).toBeDefined();
      expect(createStreamingSttConnectorMock).toHaveBeenCalledWith('plugin-stt', {
        endpoint: 'wss://plugin-stt.invalid',
      });
      expect(createStreamingTtsConnectorMock).toHaveBeenCalledWith('plugin-tts', {
        endpoint: 'https://plugin-tts.invalid',
      });
    } finally {
      restoreTts();
      restoreStt();
    }
  });

  it('fails closed when eligibility denies runtime voice provider activation', () => {
    const eligibilityGate = createEligibilityGate(() => ({
      getTier: () => 'nursery',
      getGrantedTokens: () => new Set(),
      has: () => false,
    }));

    const runtime = createApiVoiceWebSocketRuntime({
      ...createTestOptions({
        sttProvider: 'deepgram',
        ttsProvider: 'elevenlabs',
      }),
      eligibilityGate,
    });

    expect(runtime).toBeUndefined();
    expect(createStreamingSttConnectorMock).not.toHaveBeenCalled();
    expect(createStreamingTtsConnectorMock).not.toHaveBeenCalled();
  });
});
