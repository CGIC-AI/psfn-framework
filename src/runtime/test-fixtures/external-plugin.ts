import type {
  ChannelAdapter,
  ChannelAdapterFactoryEntry,
} from '../../channels/types.js';
import type { OutboundContext } from '../../channels/types.js';
import {
  registerStreamingSttProvider,
  type StreamingSttConnector,
} from '../../voice/connectors/stt/index.js';
import {
  registerStreamingTtsProvider,
  type StreamingTtsConnector,
} from '../../voice/connectors/tts/index.js';

export interface ExternalPluginFixtureState {
  channelMessages: Array<{ channelId: string; text: string }>;
  sttStarts: number;
  ttsBufferRequests: string[];
}

export interface ExternalPluginFixture {
  channelEntry: ChannelAdapterFactoryEntry;
  config: {
    sttProvider: string;
    ttsProvider: string;
    fixtureSttToken: string;
    fixtureSttEndpoint: string;
    fixtureTtsToken: string;
    fixtureTtsEndpoint: string;
  };
  state: ExternalPluginFixtureState;
  restore(): void;
}

function createFixtureChannelAdapter(state: ExternalPluginFixtureState): ChannelAdapter {
  return {
    id: 'fixture-channel',
    name: 'Fixture Channel',
    meta: { label: 'Fixture Channel' },
    capabilities: {
      chatTypes: ['direct'],
      media: false,
      reactions: false,
      threads: false,
      streaming: false,
    },
    config: { enabled: true },
    init: async (): Promise<void> => {},
    start: async (): Promise<void> => {},
    stop: async (): Promise<void> => {},
    outbound: {
      textChunkLimit: 2_000,
      sendText: async (ctx: OutboundContext, text: string): Promise<void> => {
        state.channelMessages.push({ channelId: ctx.channelId, text });
      },
    },
    gateway: {
      init: async (): Promise<void> => {},
      start: async (): Promise<void> => {},
      stop: async (): Promise<void> => {},
    },
    send: async (channelId: string, content: string): Promise<void> => {
      state.channelMessages.push({ channelId, text: content });
    },
  };
}

function createFixtureSttConnector(state: ExternalPluginFixtureState): StreamingSttConnector {
  return {
    id: 'fixture-stt',
    startStream: async () => {
      state.sttStarts += 1;
      return {
        transcripts: (async function* emptyTranscripts() {})(),
        writeAudio: async () => {},
        endInput: async () => {},
        cancel: async () => {},
      };
    },
  };
}

function createFixtureTtsConnector(state: ExternalPluginFixtureState): StreamingTtsConnector {
  return {
    id: 'fixture-tts',
    synthesizeStream: async () => ({
      audio: (async function* emptyAudio() {})(),
      cancel: async () => {},
    }),
    synthesizeBuffer: async (request) => {
      state.ttsBufferRequests.push(request.text);
      return Buffer.from(request.text, 'utf-8');
    },
  };
}

export function installExternalPluginFixture(): ExternalPluginFixture {
  const state: ExternalPluginFixtureState = {
    channelMessages: [],
    sttStarts: 0,
    ttsBufferRequests: [],
  };

  const restoreStt = registerStreamingSttProvider('fixture-stt', {
    createConnector: () => createFixtureSttConnector(state),
    metadata: {
      isConfigured: (config) => Boolean(config.fixtureSttToken),
      eligibility: { requiredTokens: ['external.web'] },
    },
    resolveRuntimeConfig: (config) => ({
      endpoint: String(config.fixtureSttEndpoint),
    }),
  });
  const restoreTts = registerStreamingTtsProvider('fixture-tts', {
    createConnector: () => createFixtureTtsConnector(state),
    metadata: {
      isConfigured: (config) => Boolean(config.fixtureTtsToken),
      eligibility: { requiredTokens: ['external.web'] },
    },
    resolveRuntimeConfig: (config) => ({
      endpoint: String(config.fixtureTtsEndpoint),
    }),
  });

  return {
    channelEntry: {
      manifest: {
        id: 'fixture-channel',
        label: 'Fixture Channel',
        enabled: true,
        required: true,
        eligibility: {},
      },
      create: async () => createFixtureChannelAdapter(state),
    },
    config: {
      sttProvider: 'fixture-stt',
      ttsProvider: 'fixture-tts',
      fixtureSttToken: 'fixture-stt-token',
      fixtureSttEndpoint: 'wss://fixture-stt.invalid',
      fixtureTtsToken: 'fixture-tts-token',
      fixtureTtsEndpoint: 'https://fixture-tts.invalid',
    },
    state,
    restore(): void {
      restoreTts();
      restoreStt();
    },
  };
}
