import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubstrateAgent } from '../../agent/substrate-agent.js';
import type { EventBus } from '../../event-bus.js';
import type { SubstrateConfig } from '../../types.js';
import type { StreamingSttConnector } from '../../voice/connectors/stt/types.js';
import type { StreamingTtsConnector } from '../../voice/connectors/tts/types.js';

const {
  createStreamingSttConnectorMock,
  createStreamingTtsConnectorMock,
} = vi.hoisted(() => ({
  createStreamingSttConnectorMock: vi.fn(),
  createStreamingTtsConnectorMock: vi.fn(),
}));

vi.mock('../../voice/connectors/stt/index.js', () => ({
  createStreamingSttConnector: createStreamingSttConnectorMock,
}));

vi.mock('../../voice/connectors/tts/index.js', () => ({
  createStreamingTtsConnector: createStreamingTtsConnectorMock,
}));

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
  sttProvider?: 'deepgram' | 'disabled';
  ttsProvider?: SubstrateConfig['ttsProvider'] | 'disabled';
};

function createTestOptions(configOverrides: RuntimeVoiceTestOverrides = {}) {
  const config = {
    deepgramApiKey: 'deepgram-key',
    deepgramModel: 'nova-3',
    elevenLabsApiKey: 'elevenlabs-key',
    elevenLabsVoiceId: 'voice-id',
    elevenLabsModelId: 'eleven_turbo_v2_5',
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

  it('keeps existing behavior for elevenlabs when provider is unset', () => {
    const runtime = createApiVoiceWebSocketRuntime(createTestOptions({
      ttsProvider: undefined,
      elevenLabsModelId: 'eleven_turbo_v2_5',
    }));

    expect(runtime).toBeDefined();
    expect(createStreamingSttConnectorMock).toHaveBeenCalledWith('deepgram', {
      apiKey: 'deepgram-key',
      model: 'nova-3',
    });
    expect(createStreamingTtsConnectorMock).toHaveBeenCalledWith('elevenlabs', {
      apiKey: 'elevenlabs-key',
      voiceId: 'voice-id',
      modelId: 'eleven_turbo_v2_5',
    });
  });

  it('keeps existing behavior for elevenlabs when provider is explicitly set', () => {
    const runtime = createApiVoiceWebSocketRuntime(createTestOptions({
      ttsProvider: 'elevenlabs',
      elevenLabsApiKey: 'elevenlabs-key',
      elevenLabsVoiceId: 'voice-id',
      elevenLabsModelId: 'eleven_turbo_v2_5',
    }));

    expect(runtime).toBeDefined();
    expect(createStreamingSttConnectorMock).toHaveBeenCalledWith('deepgram', {
      apiKey: 'deepgram-key',
      model: 'nova-3',
    });
    expect(createStreamingTtsConnectorMock).toHaveBeenCalledWith('elevenlabs', {
      apiKey: 'elevenlabs-key',
      voiceId: 'voice-id',
      modelId: 'eleven_turbo_v2_5',
    });
  });

  it('throws when echo provider selected without explicit Echo config', () => {
    expect(() => createApiVoiceWebSocketRuntime(createTestOptions({
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
});
