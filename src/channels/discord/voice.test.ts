import { describe, expect, it, beforeEach, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventBus } from '../../shared/event-bus.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';

const connectorMocks = vi.hoisted(() => {
  const sttConnector = {
    id: 'deepgram',
    startStream: vi.fn(),
  };

  const ttsConnector = {
    id: 'elevenlabs',
    synthesizeStream: vi.fn(),
    synthesizeBuffer: vi.fn(),
  };

  return {
    sttConnector,
    ttsConnector,
    createStreamingSttConnector: vi.fn(() => sttConnector),
    createStreamingTtsConnector: vi.fn(() => ttsConnector),
    isStreamingSttProvider: vi.fn((provider: string) => provider === 'deepgram'),
    getStreamingSttProviderMetadata: vi.fn((provider: string) => (
      provider === 'deepgram'
        ? {
          isConfigured: (config: Record<string, unknown>) => Boolean(config.deepgramApiKey),
          eligibility: { requiredTokens: ['external.web'] },
        }
        : null
    )),
    isStreamingSttProviderConfigured: vi.fn((provider: string, config: Record<string, unknown>) => (
      provider === 'deepgram' && Boolean(config.deepgramApiKey)
    )),
    resolveDefaultStreamingSttProvider: vi.fn((config: Record<string, unknown>) => (
      config.deepgramApiKey ? 'deepgram' : null
    )),
    resolveStreamingSttRuntimeConfig: vi.fn((_provider: string, config: Record<string, unknown>) => ({
      apiKey: config.deepgramApiKey,
      ...(config.deepgramModel ? { model: config.deepgramModel } : {}),
    })),
    isStreamingTtsProvider: vi.fn((provider: string) => (
      provider === 'elevenlabs' || provider === 'echo'
    )),
    getStreamingTtsProviderMetadata: vi.fn((provider: string) => {
      if (provider === 'echo') {
        return {
          isConfigured: (config: Record<string, unknown>) => Boolean(config.echoTtsUrl && config.echoTtsVoice),
          eligibility: { requiredTokens: ['external.web'] },
        };
      }
      if (provider === 'elevenlabs') {
        return {
          isConfigured: (
            config: Record<string, unknown>,
            options?: { requireElevenLabsVoiceId?: boolean },
          ) => (
            options?.requireElevenLabsVoiceId === true
              ? Boolean(config.elevenLabsApiKey && config.elevenLabsVoiceId)
              : Boolean(config.elevenLabsApiKey)
          ),
          eligibility: { requiredTokens: ['external.web'] },
        };
      }
      return null;
    }),
    isStreamingTtsProviderConfigured: vi.fn((
      provider: string,
      config: Record<string, unknown>,
      options?: { requireElevenLabsVoiceId?: boolean },
    ) => {
      if (provider === 'echo') {
        return Boolean(config.echoTtsUrl && config.echoTtsVoice);
      }
      if (provider === 'elevenlabs') {
        return options?.requireElevenLabsVoiceId === true
          ? Boolean(config.elevenLabsApiKey && config.elevenLabsVoiceId)
          : Boolean(config.elevenLabsApiKey);
      }
      return false;
    }),
    listStreamingTtsProviders: vi.fn(() => ['elevenlabs', 'echo']),
    resolveDefaultStreamingTtsProvider: vi.fn((config: Record<string, unknown>) => (
      config.elevenLabsApiKey ? 'elevenlabs' : null
    )),
    resolveStreamingTtsRuntimeConfig: vi.fn((provider: string, config: Record<string, unknown>) => (
      provider === 'echo'
        ? {
          url: config.echoTtsUrl,
          voice: config.echoTtsVoice,
          ...(config.echoTtsPreset ? { preset: config.echoTtsPreset } : {}),
          ...(config.echoTtsModel ? { model: config.echoTtsModel } : {}),
        }
        : {
          apiKey: config.elevenLabsApiKey,
          voiceId: config.elevenLabsVoiceId,
          ...(config.elevenLabsModelId ? { modelId: config.elevenLabsModelId } : {}),
        }
    )),
  };
});

const reliabilityMocks = vi.hoisted(() => {
  return {
    runWithVoiceStageBudget: vi.fn(async ({
      task,
      signal,
    }: {
      task: () => Promise<unknown>;
      signal?: AbortSignal;
    }) => {
      if (signal?.aborted) {
        throw new Error('stage aborted');
      }

      if (!signal) {
        return task();
      }

      return await Promise.race([
        task(),
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('stage aborted')), { once: true });
        }),
      ]);
    }),
    resolveVoiceReliabilityBudgets: vi.fn(() => ({
      ingest: { timeoutMs: 10, maxRetries: 0, baseDelayMs: 0 },
      stt: { timeoutMs: 10, maxRetries: 0, baseDelayMs: 0 },
      llm: { timeoutMs: 10, maxRetries: 0, baseDelayMs: 0 },
      tts: { timeoutMs: 10, maxRetries: 0, baseDelayMs: 0 },
      output: { timeoutMs: 10, maxRetries: 0, baseDelayMs: 0 },
    })),
    buildFallbackOrder: vi.fn((_preferredId: string, providerIds: string[]) => providerIds),
    selectFallbackCandidate: vi.fn((preferredId: string, candidates: Array<{ id: string }>) => {
      return candidates.find((candidate) => candidate.id === preferredId) ?? (candidates[0] as { id: string } | undefined) ?? null;
    }),
  };
});

const securityMocks = vi.hoisted(() => {
  return {
    resolveVoiceSecurityLimits: vi.fn(() => ({
      maxPcmBytes: 10_000_000,
      maxTranscriptChars: 20_000,
      maxTtsChars: 20_000,
      maxTtsAudioBytes: 10_000_000,
    })),
    validatePcmAudio: vi.fn(),
    validateTranscriptText: vi.fn((text: string) => text.trim()),
    validateTtsInputText: vi.fn((text: string) => text.trim()),
    validateTtsAudioChunk: vi.fn((chunk: Uint8Array, total: number) => total + chunk.byteLength),
  };
});

const voiceSdkMocks = vi.hoisted(() => {
  const VoiceConnectionStatus = {
    Ready: 'ready',
    Connecting: 'connecting',
    Signalling: 'signalling',
    Disconnected: 'disconnected',
    Destroyed: 'destroyed',
  };

  return {
    createAudioResource: vi.fn((resource: unknown) => ({ resource })),
    entersState: vi.fn(async () => undefined),
    createAudioPlayer: vi.fn(() => ({
      play: vi.fn(),
      stop: vi.fn(),
    })),
    joinVoiceChannel: vi.fn(),
    VoiceConnectionStatus,
  };
});

vi.mock('@discordjs/voice', () => {
  return {
    createAudioPlayer: voiceSdkMocks.createAudioPlayer,
    createAudioResource: voiceSdkMocks.createAudioResource,
    EndBehaviorType: {
      AfterSilence: 'after-silence',
    },
    entersState: voiceSdkMocks.entersState,
    joinVoiceChannel: voiceSdkMocks.joinVoiceChannel,
    AudioPlayerStatus: {
      Playing: 'playing',
      Idle: 'idle',
    },
    VoiceConnectionStatus: voiceSdkMocks.VoiceConnectionStatus,
  };
});

vi.mock('prism-media', () => {
  return {
    default: {
      opus: {
        Decoder: class MockDecoder {
          on(): void {}
          once(): void {}
          off(): void {}
          destroy(): void {}
        },
      },
    },
  };
});

vi.mock('../../primitives/voice/connectors/stt/index.js', () => {
  return {
    createStreamingSttConnector: connectorMocks.createStreamingSttConnector,
    getStreamingSttProviderMetadata: connectorMocks.getStreamingSttProviderMetadata,
    isStreamingSttProvider: connectorMocks.isStreamingSttProvider,
    isStreamingSttProviderConfigured: connectorMocks.isStreamingSttProviderConfigured,
    resolveDefaultStreamingSttProvider: connectorMocks.resolveDefaultStreamingSttProvider,
    resolveStreamingSttRuntimeConfig: connectorMocks.resolveStreamingSttRuntimeConfig,
  };
});

vi.mock('../../primitives/voice/connectors/tts/index.js', () => {
  return {
    createStreamingTtsConnector: connectorMocks.createStreamingTtsConnector,
    getStreamingTtsProviderMetadata: connectorMocks.getStreamingTtsProviderMetadata,
    isStreamingTtsProvider: connectorMocks.isStreamingTtsProvider,
    isStreamingTtsProviderConfigured: connectorMocks.isStreamingTtsProviderConfigured,
    listStreamingTtsProviders: connectorMocks.listStreamingTtsProviders,
    resolveDefaultStreamingTtsProvider: connectorMocks.resolveDefaultStreamingTtsProvider,
    resolveStreamingTtsRuntimeConfig: connectorMocks.resolveStreamingTtsRuntimeConfig,
  };
});

vi.mock('../../primitives/voice/policy/reliability.js', () => {
  return {
    runWithVoiceStageBudget: reliabilityMocks.runWithVoiceStageBudget,
    resolveVoiceReliabilityBudgets: reliabilityMocks.resolveVoiceReliabilityBudgets,
    buildFallbackOrder: reliabilityMocks.buildFallbackOrder,
    selectFallbackCandidate: reliabilityMocks.selectFallbackCandidate,
  };
});

vi.mock('../../primitives/voice/policy/security.js', () => {
  return {
    resolveVoiceSecurityLimits: securityMocks.resolveVoiceSecurityLimits,
    validatePcmAudio: securityMocks.validatePcmAudio,
    validateTranscriptText: securityMocks.validateTranscriptText,
    validateTtsInputText: securityMocks.validateTtsInputText,
    validateTtsAudioChunk: securityMocks.validateTtsAudioChunk,
  };
});

import prism from 'prism-media';
import {
  DiscordVoiceRuntime,
  checkOpusAvailability,
  voicePreflight,
} from './voice.js';

function makeConfig(overrides: Partial<SubstrateConfig> = {}): SubstrateConfig {
  return {
    primaryModel: 'test',
    primaryProvider: 'test',
    extractionModel: 'test',
    extractionProvider: 'test',
    primaryMaxTokens: 1000,
    extractionMaxTokens: 1000,
    discordToken: 'discord-token',
    discordBotId: 'bot-id',
    characterCardPath: '',
    dataDir: '',
    databasePath: '',
    sessionMessageLimit: 30,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    maintenanceIntervalMs: 60_000,
    defaultContextWindow: 10_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    modelRoster: {
      chat: { model: 'test', provider: 'test', maxTokens: 1024, contextWindow: 10_000 },
    },
    voiceEnabled: true,
    voiceTargetGuildId: 'guild-1',
    voiceTargetUserId: 'user-1',
    sttProvider: 'deepgram',
    ttsProvider: 'elevenlabs',
    deepgramApiKey: 'deepgram-key',
    elevenLabsApiKey: 'elevenlabs-key',
    elevenLabsVoiceId: 'voice-id',
    ...overrides,
  };
}

function createMockTtsConnector(id: string): {
  id: string;
  synthesizeStream: ReturnType<typeof vi.fn>;
  synthesizeBuffer: ReturnType<typeof vi.fn>;
} {
  return {
    id,
    synthesizeStream: vi.fn(async () => ({
      audio: makeAudioStream(),
      cancel: vi.fn(async () => {}),
    })),
    synthesizeBuffer: vi.fn(async () => Buffer.from([9, 9, 9])),
  };
}

async function* makeTranscriptStream(): AsyncGenerator<{
  type: 'partial' | 'final';
  text: string;
  confidence?: number;
  startMs?: number;
  endMs?: number;
}> {
  yield {
    type: 'partial',
    text: 'hello',
    confidence: 0.7,
    startMs: 10,
    endMs: 80,
  };
  yield {
    type: 'final',
    text: 'hello world',
    confidence: 0.91,
    startMs: 10,
    endMs: 220,
  };
}

async function* makeAudioStream(): AsyncGenerator<{
  audio: Uint8Array;
  sequence: number;
  isFinal: boolean;
  encoding: 'mp3';
  source: 'stream';
}> {
  yield {
    audio: new Uint8Array([1, 2, 3]),
    sequence: 0,
    isFinal: true,
    encoding: 'mp3',
    source: 'stream',
  };
}

async function* makeFinalTranscriptStream(text: string): AsyncGenerator<{
  type: 'partial' | 'final';
  text: string;
}> {
  yield {
    type: 'final',
    text,
  };
}

type MockStateListener = (oldState: { status: string }, newState: { status: string }) => void;
type MockSpeakingListener = (userId: string) => void;

function createMockVoiceConnection(initialStatus = voiceSdkMocks.VoiceConnectionStatus.Ready): any {
  const stateListeners: MockStateListener[] = [];
  let lastStateListener: MockStateListener | null = null;

  const connection: any = {
    state: { status: initialStatus },
    receiver: {
      subscribe: vi.fn(() => new PassThrough()),
      speaking: {
        on: vi.fn((_event: string, _handler: MockSpeakingListener) => undefined),
        off: vi.fn((_event: string, _handler: MockSpeakingListener) => undefined),
      },
    },
    subscribe: vi.fn(),
    destroy: vi.fn(),
    rejoin: vi.fn(() => true),
    rejoinAttempts: 0,
    on: vi.fn((event: string, handler: MockStateListener) => {
      if (event !== 'stateChange') return;
      stateListeners.push(handler);
      lastStateListener = handler;
    }),
    off: vi.fn((event: string, handler: MockStateListener) => {
      if (event !== 'stateChange') return;
      const index = stateListeners.indexOf(handler);
      if (index !== -1) {
        stateListeners.splice(index, 1);
      }
    }),
    emitStateChange: (previousStatus: string, status: string) => {
      const oldState = { status: previousStatus };
      const nextState = { status };
      connection.state = nextState;
      stateListeners.slice().forEach((listener) => listener(oldState, nextState));
    },
    invokeLastStateListener: (previousStatus: string, status: string) => {
      if (!lastStateListener) return;
      lastStateListener({ status: previousStatus }, { status });
    },
  };

  return connection;
}

function makeVoiceChannel(id: string): any {
  return {
    id,
    guild: {
      id: 'guild-1',
      voiceAdapterCreator: {},
    },
    members: new Map([
      ['user-1', { displayName: 'Voice User', user: { username: 'Voice User', bot: false } }],
    ]),
  };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const DECRYPT_RECOVERY_COOLDOWN_MS = 1_500;

function emitDecryptFailure(runtime: DiscordVoiceRuntime, message = 'dave decode failure'): void {
  const error = (runtime as any).createVoiceError({
    error: new Error(message),
    stage: 'ingest',
    code: 'VOICE_DAVE_DECRYPT_FAILED',
  });
  (runtime as any).emitVoiceError(error);
}

function makeRuntimeHarness(
  eventBus: EventBus,
  handler: (...args: any[]) => any,
): { runtime: DiscordVoiceRuntime; player: { play: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } } {
  const runtime = new DiscordVoiceRuntime({
    client: {
      on: vi.fn(),
      off: vi.fn(),
    } as any,
    config: makeConfig(),
    eventBus,
    getHandler: () => handler,
  });

  const player = {
    play: vi.fn(),
    stop: vi.fn(),
  };

  (runtime as any).connection = {
    destroy: vi.fn(),
    receiver: {
      subscribe: vi.fn(() => new PassThrough()),
      speaking: {
        on: vi.fn(),
        off: vi.fn(),
      },
    },
  };
  (runtime as any).player = player;
  (runtime as any).activeChannel = {
    id: 'channel-1',
    guild: { id: 'guild-1' },
    members: new Map([
      ['user-1', { displayName: 'Voice User', user: { username: 'Voice User', bot: false } }],
    ]),
  };

  return { runtime, player };
}

describe('DiscordVoiceRuntime', () => {
  beforeEach(() => {
    connectorMocks.createStreamingSttConnector.mockReset();
    connectorMocks.createStreamingSttConnector.mockImplementation(() => connectorMocks.sttConnector);
    connectorMocks.createStreamingTtsConnector.mockReset();
    connectorMocks.createStreamingTtsConnector.mockImplementation(() => connectorMocks.ttsConnector);
    connectorMocks.sttConnector.startStream.mockReset();
    connectorMocks.ttsConnector.synthesizeStream.mockReset();
    connectorMocks.ttsConnector.synthesizeBuffer.mockReset();

    reliabilityMocks.runWithVoiceStageBudget.mockClear();
    reliabilityMocks.buildFallbackOrder.mockClear();
    reliabilityMocks.selectFallbackCandidate.mockClear();
    securityMocks.validatePcmAudio.mockReset();
    securityMocks.validateTranscriptText.mockReset();
    securityMocks.validateTranscriptText.mockImplementation((text: string) => text.trim());
    securityMocks.validateTtsInputText.mockReset();
    securityMocks.validateTtsInputText.mockImplementation((text: string) => text.trim());
    securityMocks.validateTtsAudioChunk.mockReset();
    securityMocks.validateTtsAudioChunk.mockImplementation((chunk: Uint8Array, total: number) => total + chunk.byteLength);

    voiceSdkMocks.entersState.mockReset();
    voiceSdkMocks.entersState.mockImplementation(async () => undefined);
    voiceSdkMocks.joinVoiceChannel.mockReset();
  });

  it('passes configured DAVE join options to @discordjs/voice', async () => {
    const connection = createMockVoiceConnection();
    voiceSdkMocks.joinVoiceChannel.mockReturnValue(connection as any);

    const runtime = new DiscordVoiceRuntime({
      client: {
        on: vi.fn(),
        off: vi.fn(),
      } as any,
      config: makeConfig({
        voiceDaveEncryption: false,
        voiceDecryptionFailureTolerance: 9,
      }),
      eventBus: new EventBus(),
      getHandler: () => null,
    });

    const voiceChannel = {
      id: 'channel-1',
      guild: {
        id: 'guild-1',
        voiceAdapterCreator: vi.fn(),
      },
      members: new Map(),
    } as any;

    await (runtime as any).joinChannel(voiceChannel);

    expect(voiceSdkMocks.joinVoiceChannel).toHaveBeenCalledWith(expect.objectContaining({
      daveEncryption: false,
      decryptionFailureTolerance: 9,
    }));
  });

  it('reconciles target voice state on init when client is already ready', async () => {
    const readyVoiceChannel = makeVoiceChannel('channel-ready');
    const client = {
      on: vi.fn(),
      off: vi.fn(),
      isReady: vi.fn(() => true),
      guilds: {
        fetch: vi.fn(async () => ({
          members: {
            fetch: vi.fn(async () => ({
              voice: {
                channel: readyVoiceChannel,
              },
            })),
          },
        })),
      },
    } as any;

    const runtime = new DiscordVoiceRuntime({
      client,
      config: makeConfig(),
      eventBus: new EventBus(),
      getHandler: () => null,
    });

    const joinSpy = vi.spyOn(runtime as any, 'joinChannel').mockResolvedValue(undefined);
    runtime.init();
    await flushAsyncWork();

    expect(joinSpy).toHaveBeenCalledWith(readyVoiceChannel);
  });

  it('uses default DAVE join options when config values are not set', async () => {
    const connection = createMockVoiceConnection();
    voiceSdkMocks.joinVoiceChannel.mockReturnValue(connection as any);

    const runtime = new DiscordVoiceRuntime({
      client: {
        on: vi.fn(),
        off: vi.fn(),
      } as any,
      config: makeConfig({
        voiceDaveEncryption: undefined,
        voiceDecryptionFailureTolerance: undefined,
      }),
      eventBus: new EventBus(),
      getHandler: () => null,
    });

    const voiceChannel = {
      id: 'channel-1',
      guild: {
        id: 'guild-1',
        voiceAdapterCreator: vi.fn(),
      },
      members: new Map(),
    } as any;

    await (runtime as any).joinChannel(voiceChannel);

    expect(voiceSdkMocks.joinVoiceChannel).toHaveBeenCalledWith(expect.objectContaining({
      daveEncryption: true,
      decryptionFailureTolerance: 24,
    }));
  });

  it('ignores receive-start events while bot playback is already active', async () => {
    const connection = createMockVoiceConnection();
    voiceSdkMocks.joinVoiceChannel.mockReturnValue(connection as any);
    voiceSdkMocks.createAudioPlayer.mockReturnValueOnce({
      play: vi.fn(),
      stop: vi.fn(),
      state: { status: 'playing' },
    } as any);

    const runtime = new DiscordVoiceRuntime({
      client: {
        on: vi.fn(),
        off: vi.fn(),
      } as any,
      config: makeConfig(),
      eventBus: new EventBus(),
      getHandler: () => null,
    });

    const handleUtteranceSpy = vi.spyOn(runtime as any, 'handleUtterance').mockResolvedValue(undefined);

    await (runtime as any).joinChannel(makeVoiceChannel('channel-1'));

    const speakingListener = connection.receiver.speaking.on.mock.calls[0]?.[1] as
      | ((userId: string) => void)
      | undefined;
    expect(typeof speakingListener).toBe('function');

    speakingListener?.('user-1');

    expect(handleUtteranceSpy).not.toHaveBeenCalled();
  });

  it('builds only the explicitly selected echo TTS connector when echo is configured', () => {
    const echoConnector = createMockTtsConnector('echo');
    const elevenLabsConnector = createMockTtsConnector('elevenlabs');
    connectorMocks.createStreamingTtsConnector.mockImplementation((provider: string) => {
      return provider === 'echo' ? echoConnector : elevenLabsConnector;
    });

    new DiscordVoiceRuntime({
      client: {
        on: vi.fn(),
        off: vi.fn(),
      } as any,
      config: makeConfig({
        ttsProvider: 'echo',
        echoTtsUrl: 'http://127.0.0.1:5050/v1/audio/speech',
        echoTtsVoice: 'echo-voice-1',
        echoTtsPreset: 'normal',
        echoTtsModel: 'echo-v1',
      }),
      eventBus: new EventBus(),
      getHandler: () => null,
    });

    expect(connectorMocks.createStreamingTtsConnector).toHaveBeenCalledTimes(1);
    const calls = connectorMocks.createStreamingTtsConnector.mock.calls;
    const providers = calls.map((call: unknown[]) => call[0]);
    expect(providers).toEqual(['echo']);
  });

  it('uses echo TTS when echo is configured as provider', async () => {
    const echoConnector = createMockTtsConnector('echo');
    const elevenLabsConnector = createMockTtsConnector('elevenlabs');
    connectorMocks.createStreamingTtsConnector.mockImplementation((provider: string) => {
      return provider === 'echo' ? echoConnector : elevenLabsConnector;
    });

    const runtime = new DiscordVoiceRuntime({
      client: {
        on: vi.fn(),
        off: vi.fn(),
      } as any,
      config: makeConfig({
        ttsProvider: 'echo',
        echoTtsUrl: 'http://127.0.0.1:5050/v1/audio/speech',
        echoTtsVoice: 'echo-voice-1',
        echoTtsPreset: 'normal',
      }),
      eventBus: new EventBus(),
      getHandler: () => null,
    });
    (runtime as any).player = {
      play: vi.fn(),
      stop: vi.fn(),
    };

    await (runtime as any).speakText('hello world');

    // Echo should be the preferred provider
    expect(reliabilityMocks.buildFallbackOrder).toHaveBeenCalledWith('echo', ['echo']);
  });

  it('emits partial transcript events and uses streaming TTS playback', async () => {
    connectorMocks.sttConnector.startStream.mockResolvedValue({
      transcripts: makeTranscriptStream(),
      writeAudio: vi.fn(async () => {}),
      endInput: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
    });

    connectorMocks.ttsConnector.synthesizeStream.mockResolvedValue({
      audio: makeAudioStream(),
      cancel: vi.fn(async () => {}),
    });
    connectorMocks.ttsConnector.synthesizeBuffer.mockResolvedValue(Buffer.from([9, 9, 9]));

    const eventBus = new EventBus();
    const partialEvents: Array<{ transcript: string }> = [];
    const finalEvents: Array<{ transcript: string }> = [];

    eventBus.on('channel.voice.transcript.partial', (event) => {
      partialEvents.push({ transcript: event.transcript });
    });
    eventBus.on('channel.voice.transcript', (event) => {
      finalEvents.push({ transcript: event.transcript });
    });

    const handler = vi.fn(async () => {
      return {
        content: 'assistant response',
        channelId: 'discord-voice:guild-1',
        metadata: {
          model: 'test-model',
          inputTokens: 10,
          outputTokens: 12,
          durationMs: 42,
        },
      };
    });

    const { runtime, player } = makeRuntimeHarness(eventBus, handler);
    (runtime as any).decodeOpusToPcm = vi.fn(async () => Buffer.alloc(40_000, 1));

    await (runtime as any).handleUtterance();

    expect(partialEvents).toEqual([{ transcript: 'hello' }]);
    expect(finalEvents).toEqual([{ transcript: 'hello world' }]);
    expect(handler).toHaveBeenCalledTimes(1);

    expect(connectorMocks.sttConnector.startStream).toHaveBeenCalledTimes(1);
    expect(connectorMocks.ttsConnector.synthesizeStream).toHaveBeenCalledTimes(1);
    expect(connectorMocks.ttsConnector.synthesizeBuffer).not.toHaveBeenCalled();
    expect(player.play).toHaveBeenCalledTimes(1);
  });

  it('emits a silence observation and skips STT/TTS for short captures', async () => {
    const eventBus = new EventBus();
    const observations: Array<{ kind: string; stage: string }> = [];
    eventBus.on('voice.turn.observation', (event) => {
      observations.push({ kind: event.kind, stage: event.stage });
    });

    const handler = vi.fn();
    const { runtime } = makeRuntimeHarness(eventBus, handler);
    (runtime as any).decodeOpusToPcm = vi.fn(async () => Buffer.alloc(8_000, 1));

    await (runtime as any).handleUtterance();

    expect(observations).toEqual([{ kind: 'silence', stage: 'ingest' }]);
    expect(connectorMocks.sttConnector.startStream).not.toHaveBeenCalled();
    expect(connectorMocks.ttsConnector.synthesizeStream).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('emits an empty-transcript observation when STT yields no final text', async () => {
    connectorMocks.sttConnector.startStream.mockResolvedValue({
      transcripts: makeFinalTranscriptStream('   '),
      writeAudio: vi.fn(async () => {}),
      endInput: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
    });

    const eventBus = new EventBus();
    const observations: Array<{ kind: string; stage: string }> = [];
    eventBus.on('voice.turn.observation', (event) => {
      observations.push({ kind: event.kind, stage: event.stage });
    });

    const handler = vi.fn();
    const { runtime } = makeRuntimeHarness(eventBus, handler);
    (runtime as any).decodeOpusToPcm = vi.fn(async () => Buffer.alloc(40_000, 1));

    await (runtime as any).handleUtterance();

    expect(observations).toEqual([{ kind: 'empty-transcript', stage: 'stt' }]);
    expect(handler).not.toHaveBeenCalled();
    expect(connectorMocks.ttsConnector.synthesizeStream).not.toHaveBeenCalled();
  });

  it('emits an empty-response observation when handler returns blank content', async () => {
    connectorMocks.sttConnector.startStream.mockResolvedValue({
      transcripts: makeFinalTranscriptStream('hello world'),
      writeAudio: vi.fn(async () => {}),
      endInput: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
    });

    const eventBus = new EventBus();
    const observations: Array<{ kind: string; stage: string }> = [];
    eventBus.on('voice.turn.observation', (event) => {
      observations.push({ kind: event.kind, stage: event.stage });
    });

    const handler = vi.fn(async () => {
      return {
        content: '   ',
        channelId: 'discord-voice:guild-1',
        metadata: {
          model: 'test-model',
          inputTokens: 10,
          outputTokens: 12,
          durationMs: 42,
        },
      };
    });
    const { runtime } = makeRuntimeHarness(eventBus, handler);
    (runtime as any).decodeOpusToPcm = vi.fn(async () => Buffer.alloc(40_000, 1));

    await (runtime as any).handleUtterance();

    expect(observations).toEqual([{ kind: 'empty-response', stage: 'llm' }]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(connectorMocks.ttsConnector.synthesizeStream).not.toHaveBeenCalled();
  });

  it('emits playback observations and structured turn errors when playback fails', async () => {
    connectorMocks.sttConnector.startStream.mockResolvedValue({
      transcripts: makeFinalTranscriptStream('hello world'),
      writeAudio: vi.fn(async () => {}),
      endInput: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
    });
    connectorMocks.ttsConnector.synthesizeStream.mockResolvedValue({
      audio: makeAudioStream(),
      cancel: vi.fn(async () => {}),
    });
    connectorMocks.ttsConnector.synthesizeBuffer.mockRejectedValue(new Error('tts buffer fallback failed'));

    voiceSdkMocks.entersState.mockRejectedValueOnce(new Error('audio player timed out'));

    const eventBus = new EventBus();
    const observations: Array<{ kind: string; stage: string }> = [];
    const turnErrors: Array<{ stage: string; code: string; error: string }> = [];
    eventBus.on('voice.turn.observation', (event) => {
      observations.push({ kind: event.kind, stage: event.stage });
    });
    eventBus.on('voice.turn.error', (event) => {
      turnErrors.push({
        stage: event.stage,
        code: event.code,
        error: event.error,
      });
    });

    const handler = vi.fn(async () => {
      return {
        content: 'assistant response',
        channelId: 'discord-voice:guild-1',
        metadata: {
          model: 'test-model',
          inputTokens: 10,
          outputTokens: 12,
          durationMs: 42,
        },
      };
    });
    const { runtime } = makeRuntimeHarness(eventBus, handler);
    (runtime as any).decodeOpusToPcm = vi.fn(async () => Buffer.alloc(40_000, 1));

    await expect((runtime as any).handleUtterance()).rejects.toThrow('tts buffer fallback failed');

    expect(observations).toContainEqual({ kind: 'playback-error', stage: 'tts' });
    expect(turnErrors).toEqual([
      expect.objectContaining({
        stage: 'tts',
        code: 'VOICE_TTS_FALLBACK_FAILED',
        error: 'tts buffer fallback failed',
      }),
    ]);
  });

  it('emits connection state events and attempts reconnect when disconnected', async () => {
    const eventBus = new EventBus();
    const stateEvents: Array<{ previousStatus: string; status: string; generation: number }> = [];
    eventBus.on('voice.connection.state', (event) => {
      stateEvents.push({
        previousStatus: event.previousStatus,
        status: event.status,
        generation: event.generation,
      });
    });

    const runtime = new DiscordVoiceRuntime({
      client: {
        on: vi.fn(),
        off: vi.fn(),
      } as any,
      config: makeConfig(),
      eventBus,
      getHandler: () => null,
    });

    const connection = createMockVoiceConnection();
    voiceSdkMocks.joinVoiceChannel.mockReturnValue(connection);

    await (runtime as any).joinChannel(makeVoiceChannel('channel-1'));

    connection.emitStateChange(voiceSdkMocks.VoiceConnectionStatus.Ready, voiceSdkMocks.VoiceConnectionStatus.Signalling);
    connection.emitStateChange(voiceSdkMocks.VoiceConnectionStatus.Signalling, voiceSdkMocks.VoiceConnectionStatus.Disconnected);
    await flushAsyncWork();

    expect(connection.on).toHaveBeenCalledWith('stateChange', expect.any(Function));
    expect(connection.rejoin).toHaveBeenCalledTimes(1);
    expect(stateEvents).toEqual([
      expect.objectContaining({
        previousStatus: voiceSdkMocks.VoiceConnectionStatus.Ready,
        status: voiceSdkMocks.VoiceConnectionStatus.Signalling,
        generation: 1,
      }),
      expect.objectContaining({
        previousStatus: voiceSdkMocks.VoiceConnectionStatus.Signalling,
        status: voiceSdkMocks.VoiceConnectionStatus.Disconnected,
        generation: 1,
      }),
    ]);
  });

  it('triggers decrypt recovery when ingest failures exceed tolerance', async () => {
    vi.useFakeTimers();
    try {
      const eventBus = new EventBus();
      const recoveryEvents: Array<{ attempt: number; failureCount: number; tolerance: number }> = [];
      eventBus.on('voice.connection.recovery', (event) => {
        recoveryEvents.push({
          attempt: event.attempt,
          failureCount: event.failureCount,
          tolerance: event.tolerance,
        });
      });

      const runtime = new DiscordVoiceRuntime({
        client: {
          on: vi.fn(),
          off: vi.fn(),
        } as any,
        config: makeConfig({
          voiceDecryptionFailureTolerance: 1,
        }),
        eventBus,
        getHandler: () => null,
      });

      const initialConnection = createMockVoiceConnection();
      const recoveredConnection = createMockVoiceConnection();
      voiceSdkMocks.joinVoiceChannel
        .mockReturnValueOnce(initialConnection)
        .mockReturnValueOnce(recoveredConnection);

      await (runtime as any).joinChannel(makeVoiceChannel('channel-1'));

      emitDecryptFailure(runtime);
      await flushMicrotasks();
      expect(recoveryEvents).toHaveLength(0);

      emitDecryptFailure(runtime);
      await flushMicrotasks();

      expect(recoveryEvents).toEqual([
        expect.objectContaining({
          attempt: 1,
          failureCount: 2,
          tolerance: 1,
        }),
      ]);
      expect(voiceSdkMocks.joinVoiceChannel).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(DECRYPT_RECOVERY_COOLDOWN_MS);
      await flushMicrotasks();

      expect(initialConnection.destroy).toHaveBeenCalledTimes(1);
      expect(voiceSdkMocks.joinVoiceChannel).toHaveBeenCalledTimes(2);
      expect((runtime as any).decryptFailureCount).toBe(0);
      expect((runtime as any).activeChannel?.id).toBe('channel-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for cooldown before rejoining during decrypt recovery', async () => {
    vi.useFakeTimers();
    try {
      const runtime = new DiscordVoiceRuntime({
        client: {
          on: vi.fn(),
          off: vi.fn(),
        } as any,
        config: makeConfig({
          voiceDecryptionFailureTolerance: 0,
        }),
        eventBus: new EventBus(),
        getHandler: () => null,
      });

      const initialConnection = createMockVoiceConnection();
      const recoveredConnection = createMockVoiceConnection();
      voiceSdkMocks.joinVoiceChannel
        .mockReturnValueOnce(initialConnection)
        .mockReturnValueOnce(recoveredConnection);

      await (runtime as any).joinChannel(makeVoiceChannel('channel-1'));

      emitDecryptFailure(runtime);
      await flushMicrotasks();

      expect(voiceSdkMocks.joinVoiceChannel).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(DECRYPT_RECOVERY_COOLDOWN_MS - 1);
      await flushMicrotasks();
      expect(voiceSdkMocks.joinVoiceChannel).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await flushMicrotasks();
      expect(voiceSdkMocks.joinVoiceChannel).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits exhausted recovery signal and stops rejoining after max attempts', async () => {
    vi.useFakeTimers();
    try {
      const eventBus = new EventBus();
      const recoveryAttempts: number[] = [];
      const exhaustedEvents: Array<{ maxAttempts: number; windowMs: number }> = [];
      const channelErrors: string[] = [];
      eventBus.on('voice.connection.recovery', (event) => {
        recoveryAttempts.push(event.attempt);
      });
      eventBus.on('voice.connection.recovery.exhausted', (event) => {
        exhaustedEvents.push({
          maxAttempts: event.maxAttempts,
          windowMs: event.windowMs,
        });
      });
      eventBus.on('channel.voice.error', (event) => {
        channelErrors.push(event.error);
      });

      const runtime = new DiscordVoiceRuntime({
        client: {
          on: vi.fn(),
          off: vi.fn(),
        } as any,
        config: makeConfig({
          voiceDecryptionFailureTolerance: 0,
        }),
        eventBus,
        getHandler: () => null,
      });

      const connection1 = createMockVoiceConnection();
      const connection2 = createMockVoiceConnection();
      const connection3 = createMockVoiceConnection();
      const connection4 = createMockVoiceConnection();
      voiceSdkMocks.joinVoiceChannel
        .mockReturnValueOnce(connection1)
        .mockReturnValueOnce(connection2)
        .mockReturnValueOnce(connection3)
        .mockReturnValueOnce(connection4);

      await (runtime as any).joinChannel(makeVoiceChannel('channel-1'));

      for (let attempt = 0; attempt < 3; attempt += 1) {
        emitDecryptFailure(runtime);
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(DECRYPT_RECOVERY_COOLDOWN_MS);
        await flushMicrotasks();
      }

      expect(voiceSdkMocks.joinVoiceChannel).toHaveBeenCalledTimes(4);
      expect(recoveryAttempts).toEqual([1, 2, 3]);

      emitDecryptFailure(runtime);
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(DECRYPT_RECOVERY_COOLDOWN_MS);
      await flushMicrotasks();

      expect(voiceSdkMocks.joinVoiceChannel).toHaveBeenCalledTimes(4);
      expect(exhaustedEvents).toEqual([
        expect.objectContaining({
          maxAttempts: 3,
          windowMs: 300_000,
        }),
      ]);
      expect(channelErrors.some((error) => error.includes('recovery exhausted'))).toBe(true);
      expect((runtime as any).connection).toBeNull();
      expect((runtime as any).activeChannel).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up runtime state when disconnected and reconnect fails', async () => {
    const eventBus = new EventBus();
    const endReasons: string[] = [];
    eventBus.on('channel.voice.end', (event) => {
      endReasons.push(event.reason);
    });

    const runtime = new DiscordVoiceRuntime({
      client: {
        on: vi.fn(),
        off: vi.fn(),
      } as any,
      config: makeConfig(),
      eventBus,
      getHandler: () => null,
    });

    const connection = createMockVoiceConnection();
    connection.rejoin.mockReturnValue(false);
    voiceSdkMocks.joinVoiceChannel.mockReturnValue(connection);

    await (runtime as any).joinChannel(makeVoiceChannel('channel-1'));

    connection.emitStateChange(voiceSdkMocks.VoiceConnectionStatus.Ready, voiceSdkMocks.VoiceConnectionStatus.Disconnected);
    await flushAsyncWork();

    expect(connection.receiver.speaking.off).toHaveBeenCalledWith('start', expect.any(Function));
    expect(connection.off).toHaveBeenCalledWith('stateChange', expect.any(Function));
    expect(connection.destroy).toHaveBeenCalledTimes(1);
    expect((runtime as any).connection).toBeNull();
    expect((runtime as any).player).toBeNull();
    expect((runtime as any).activeChannel).toBeNull();
    expect(endReasons).toContain('connection-disconnected');
  });

  it('cleans up runtime state when connection is destroyed', async () => {
    const eventBus = new EventBus();
    const endReasons: string[] = [];
    eventBus.on('channel.voice.end', (event) => {
      endReasons.push(event.reason);
    });

    const runtime = new DiscordVoiceRuntime({
      client: {
        on: vi.fn(),
        off: vi.fn(),
      } as any,
      config: makeConfig(),
      eventBus,
      getHandler: () => null,
    });

    const connection = createMockVoiceConnection();
    voiceSdkMocks.joinVoiceChannel.mockReturnValue(connection);

    await (runtime as any).joinChannel(makeVoiceChannel('channel-1'));

    connection.emitStateChange(voiceSdkMocks.VoiceConnectionStatus.Ready, voiceSdkMocks.VoiceConnectionStatus.Destroyed);
    await flushAsyncWork();

    expect(connection.receiver.speaking.off).toHaveBeenCalledWith('start', expect.any(Function));
    expect(connection.off).toHaveBeenCalledWith('stateChange', expect.any(Function));
    expect(connection.destroy).toHaveBeenCalledTimes(1);
    expect((runtime as any).connection).toBeNull();
    expect((runtime as any).player).toBeNull();
    expect((runtime as any).activeChannel).toBeNull();
    expect(endReasons).toContain('connection-destroyed');
  });

  it('ignores stale state events from prior connections', async () => {
    const eventBus = new EventBus();
    const stateEvents: string[] = [];
    const endReasons: string[] = [];
    eventBus.on('voice.connection.state', (event) => {
      stateEvents.push(event.status);
    });
    eventBus.on('channel.voice.end', (event) => {
      endReasons.push(event.reason);
    });

    const runtime = new DiscordVoiceRuntime({
      client: {
        on: vi.fn(),
        off: vi.fn(),
      } as any,
      config: makeConfig(),
      eventBus,
      getHandler: () => null,
    });

    const firstConnection = createMockVoiceConnection();
    const secondConnection = createMockVoiceConnection();
    voiceSdkMocks.joinVoiceChannel
      .mockReturnValueOnce(firstConnection)
      .mockReturnValueOnce(secondConnection);

    await (runtime as any).joinChannel(makeVoiceChannel('channel-1'));
    await (runtime as any).joinChannel(makeVoiceChannel('channel-2'));

    firstConnection.invokeLastStateListener(
      voiceSdkMocks.VoiceConnectionStatus.Ready,
      voiceSdkMocks.VoiceConnectionStatus.Destroyed,
    );
    await flushAsyncWork();

    expect((runtime as any).connection).toBe(secondConnection);
    expect((runtime as any).activeChannel?.id).toBe('channel-2');
    expect(stateEvents).toEqual([]);
    expect(endReasons).not.toContain('connection-destroyed');
  });

  it('cancels in-flight STT capture when leaving an active channel', async () => {
    const transcriptRelease = createDeferred<void>();
    const cancelStt = vi.fn(async () => {
      transcriptRelease.resolve();
    });

    connectorMocks.sttConnector.startStream.mockResolvedValue({
      transcripts: (async function* () {
        await transcriptRelease.promise;
      })(),
      writeAudio: vi.fn(async () => {}),
      endInput: vi.fn(async () => {}),
      cancel: cancelStt,
    });

    const eventBus = new EventBus();
    const handler = vi.fn();
    const { runtime } = makeRuntimeHarness(eventBus, handler);
    (runtime as any).decodeOpusToPcm = vi.fn(async () => Buffer.alloc(40_000, 1));

    const utterancePromise = (runtime as any).handleUtterance();
    await waitForCondition(() => connectorMocks.sttConnector.startStream.mock.calls.length === 1);

    await (runtime as any).leaveChannel('target-left');
    await utterancePromise.catch(() => undefined);

    expect(cancelStt).toHaveBeenCalled();
    expect(cancelStt.mock.calls.map((call) => call[0])).toContain('leave:target-left');
    expect((runtime as any).capturing).toBe(false);
    expect((runtime as any).activeTurnId).toBeNull();
  });

  it('cancels in-flight TTS synthesis when leaving during playback', async () => {
    connectorMocks.sttConnector.startStream.mockResolvedValue({
      transcripts: makeFinalTranscriptStream('hello world'),
      writeAudio: vi.fn(async () => {}),
      endInput: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
    });

    const cancelTts = vi.fn(async () => {});
    connectorMocks.ttsConnector.synthesizeStream.mockResolvedValue({
      audio: makeAudioStream(),
      cancel: cancelTts,
    });

    const eventBus = new EventBus();
    const handler = vi.fn(async () => {
      return {
        content: 'assistant response',
        channelId: 'discord-voice:guild-1',
        metadata: {
          model: 'test-model',
          inputTokens: 10,
          outputTokens: 12,
          durationMs: 42,
        },
      };
    });
    const { runtime } = makeRuntimeHarness(eventBus, handler);
    (runtime as any).decodeOpusToPcm = vi.fn(async () => Buffer.alloc(40_000, 1));
    (runtime as any).playReadableAudio = vi.fn(async (_audio: unknown, turn: { abortController?: AbortController }) => {
      const signal = turn.abortController?.signal;
      await new Promise<void>((resolve) => {
        if (!signal || signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });

    const utterancePromise = (runtime as any).handleUtterance();
    await waitForCondition(() => connectorMocks.ttsConnector.synthesizeStream.mock.calls.length === 1);

    await (runtime as any).leaveChannel('switch-channel');
    await utterancePromise.catch(() => undefined);

    expect(cancelTts).toHaveBeenCalled();
    expect(cancelTts.mock.calls.map((call) => call[0])).toContain('leave:switch-channel');
    expect((runtime as any).capturing).toBe(false);
    expect((runtime as any).activeTurnId).toBeNull();
  });

  it('guards stale turn cleanup from clearing current capture state', () => {
    const eventBus = new EventBus();
    const handler = vi.fn();
    const { runtime } = makeRuntimeHarness(eventBus, handler);

    const staleTurn = { token: Symbol('stale') };
    const currentTurn = { token: Symbol('current') };

    (runtime as any).activeTurn = currentTurn;
    (runtime as any).activeTurnId = 'voice-turn-current';
    (runtime as any).capturing = true;

    (runtime as any).resetTurnStateIfCurrent(staleTurn);

    expect((runtime as any).activeTurn).toBe(currentTurn);
    expect((runtime as any).activeTurnId).toBe('voice-turn-current');
    expect((runtime as any).capturing).toBe(true);
  });

  describe('Discord voice TTS provider config', () => {
    it('honors echo provider config instead of overriding to elevenlabs', () => {
      connectorMocks.createStreamingTtsConnector.mockImplementation(() => connectorMocks.ttsConnector);

      const runtime = new DiscordVoiceRuntime({
        client: { on: vi.fn(), off: vi.fn() } as any,
        config: makeConfig({
          ttsProvider: 'echo',
          echoTtsUrl: 'http://127.0.0.1:5050/v1/audio/speech',
          echoTtsVoice: 'echo-voice-1',
        }),
        eventBus: new EventBus(),
        getHandler: () => null,
      });

      expect((runtime as any).preferredTtsProviderId).toBe('echo');
      const calls = connectorMocks.createStreamingTtsConnector.mock.calls;
      const providers = calls.map((call) => call[0]);
      expect(providers[0]).toBe('echo');
    });

    it('throws when no TTS provider is explicitly configured', () => {
      connectorMocks.createStreamingTtsConnector.mockImplementation(() => connectorMocks.ttsConnector);

      expect(() => new DiscordVoiceRuntime({
        client: { on: vi.fn(), off: vi.fn() } as any,
        config: makeConfig({
          ttsProvider: undefined,
        }),
        eventBus: new EventBus(),
        getHandler: () => null,
      })).toThrow(
        'Missing runtime voice TTS provider selection: set "ttsProvider" in settings.json to "disabled" or a registered TTS provider id',
      );
    });

    it('skips elevenlabs connector when no voice ID is configured', () => {
      connectorMocks.createStreamingTtsConnector.mockImplementation((provider: string, runtimeConfig: Record<string, unknown>) => {
        if (provider === 'elevenlabs' && !runtimeConfig.voiceId) {
          throw new Error('missing elevenlabs voice id');
        }
        return connectorMocks.ttsConnector;
      });

      const runtime = new DiscordVoiceRuntime({
        client: { on: vi.fn(), off: vi.fn() } as any,
        config: makeConfig({
          elevenLabsVoiceId: '',
        }),
        eventBus: new EventBus(),
        getHandler: () => null,
      });

      // Voice ID is empty, so no elevenlabs connector — runtime should be disabled
      expect((runtime as any).enabled).toBe(false);
    });

    it('uses explicit voice ID when configured', () => {
      connectorMocks.createStreamingTtsConnector.mockImplementation(() => connectorMocks.ttsConnector);

      new DiscordVoiceRuntime({
        client: { on: vi.fn(), off: vi.fn() } as any,
        config: makeConfig({
          elevenLabsVoiceId: 'custom-voice-id',
        }),
        eventBus: new EventBus(),
        getHandler: () => null,
      });

      expect(connectorMocks.createStreamingTtsConnector).toHaveBeenCalledWith('elevenlabs', expect.objectContaining({
        voiceId: 'custom-voice-id',
      }));
    });

    it('disables voice runtime when no TTS connectors can be created', () => {
      connectorMocks.createStreamingTtsConnector.mockImplementation(() => {
        throw new Error('no config');
      });

      const runtime = new DiscordVoiceRuntime({
        client: { on: vi.fn(), off: vi.fn() } as any,
        config: makeConfig({
          elevenLabsApiKey: '',
          elevenLabsVoiceId: '',
        }),
        eventBus: new EventBus(),
        getHandler: () => null,
      });

      expect((runtime as any).enabled).toBe(false);
    });

    it('builds only the explicitly selected echo connector when both providers are configured', () => {
      connectorMocks.createStreamingTtsConnector.mockImplementation(() => connectorMocks.ttsConnector);

      new DiscordVoiceRuntime({
        client: { on: vi.fn(), off: vi.fn() } as any,
        config: makeConfig({
          ttsProvider: 'echo',
          echoTtsUrl: 'http://127.0.0.1:5050/v1/audio/speech',
          echoTtsVoice: 'echo-voice-1',
          elevenLabsApiKey: 'elevenlabs-key',
          elevenLabsVoiceId: 'voice-id',
        }),
        eventBus: new EventBus(),
        getHandler: () => null,
      });

      const calls = connectorMocks.createStreamingTtsConnector.mock.calls;
      const providers = calls.map((call) => call[0]);
      expect(providers).toEqual(['echo']);
    });
  });

  describe('Opus preflight', () => {
    it('checkOpusAvailability returns available when prism-media Decoder can be created', () => {
      // prism-media is mocked in this test suite, so Decoder creation should succeed
      const result = checkOpusAvailability();
      expect(result.available).toBe(true);
      expect(result.error).toBeNull();
    });

    it('voicePreflight reports missing config vars', () => {
      const result = voicePreflight(makeConfig({
        voiceTargetGuildId: '',
        voiceTargetUserId: '',
        deepgramApiKey: '',
      }));
      expect(result.configComplete).toBe(false);
      expect(result.missingConfig).toContain('VOICE_TARGET_GUILD_ID');
      expect(result.missingConfig).toContain('VOICE_TARGET_USER_ID');
      expect(result.missingConfig).toContain('VOICE_STT_PROVIDER_CONFIG');
    });

    it('voicePreflight reports config complete when all required vars are set', () => {
      const result = voicePreflight(makeConfig());
      expect(result.configComplete).toBe(true);
      expect(result.missingConfig).toEqual([]);
    });

    it('voicePreflight canReceive is true when opus available and config complete', () => {
      const result = voicePreflight(makeConfig());
      expect(result.canReceive).toBe(true);
      expect(result.opusAvailable).toBe(true);
    });

    it('keeps voice runtime enabled but disables receive when opus decoder is unavailable', () => {
      // Temporarily make prism.opus.Decoder throw to simulate missing opus
      const originalDecoder = (prism as any).opus.Decoder;
      (prism as any).opus.Decoder = class ThrowingDecoder {
        constructor() {
          throw new Error('Could not find an Opus module');
        }
      };

      try {
        const runtime = new DiscordVoiceRuntime({
          client: { on: vi.fn(), off: vi.fn() } as any,
          config: makeConfig(),
          eventBus: new EventBus(),
          getHandler: () => null,
        });

        expect((runtime as any).enabled).toBe(true);
        expect((runtime as any).opusAvailable).toBe(false);
        expect((runtime as any).receiveEnabled).toBe(false);
      } finally {
        (prism as any).opus.Decoder = originalDecoder;
      }
    });

    it('still joins voice channel when opus decoder is unavailable', async () => {
      const originalDecoder = (prism as any).opus.Decoder;
      (prism as any).opus.Decoder = class ThrowingDecoder {
        constructor() {
          throw new Error('Could not find an Opus module');
        }
      };

      try {
        const connection = createMockVoiceConnection();
        voiceSdkMocks.joinVoiceChannel.mockReturnValue(connection as any);
        const runtime = new DiscordVoiceRuntime({
          client: { on: vi.fn(), off: vi.fn() } as any,
          config: makeConfig(),
          eventBus: new EventBus(),
          getHandler: () => null,
        });

        await (runtime as any).joinChannel(makeVoiceChannel('channel-opusless'));

        expect(voiceSdkMocks.joinVoiceChannel).toHaveBeenCalledTimes(1);
        expect(connection.receiver.speaking.on).not.toHaveBeenCalled();
      } finally {
        (prism as any).opus.Decoder = originalDecoder;
      }
    });

    it('checkOpusAvailability returns unavailable when decoder throws', () => {
      const originalDecoder = (prism as any).opus.Decoder;
      (prism as any).opus.Decoder = class ThrowingDecoder {
        constructor() {
          throw new Error('Could not find an Opus module');
        }
      };

      try {
        const result = checkOpusAvailability();
        expect(result.available).toBe(false);
        expect(result.error).toContain('Could not find an Opus module');
        expect(result.backend).toBeNull();
      } finally {
        (prism as any).opus.Decoder = originalDecoder;
      }
    });
  });

  describe('Stream error hardening', () => {
    it('contains opus stream errors without crashing', async () => {
      const eventBus = new EventBus();
      const handler = vi.fn(async () => ({
        content: 'response',
        channelId: 'discord-voice:guild-1',
        metadata: { model: 'test', inputTokens: 0, outputTokens: 0, durationMs: 0 },
      }));
      const { runtime } = makeRuntimeHarness(eventBus, handler);

      // Simulate decodeOpusToPcm that throws a stream error
      (runtime as any).decodeOpusToPcm = vi.fn(async () => {
        const err = new Error('DecryptionFailed(UnencryptedWhenPassthroughDisabled)');
        throw err;
      });

      // Should not throw an unhandled error -- handleUtterance wraps errors in voice.turn.error
      const turnErrors: Array<{ stage: string; code: string }> = [];
      eventBus.on('voice.turn.error', (event) => {
        turnErrors.push({ stage: event.stage, code: event.code });
      });

      await expect((runtime as any).handleUtterance()).rejects.toThrow();
      expect(turnErrors.length).toBeGreaterThan(0);
    });

    it('executes degraded-threshold recovery with distinct detection vs execution telemetry', async () => {
      vi.useFakeTimers();
      try {
        const eventBus = new EventBus();
        const degradedEvents: Array<{
          phase: string;
          userId: string;
          errorCount: number;
          recoveryAttempt?: number;
        }> = [];
        const recoveryAttempts: number[] = [];
        eventBus.on('voice.stream.degraded', (event: any) => {
          degradedEvents.push({
            phase: event.phase,
            userId: event.userId,
            errorCount: event.errorCount,
            recoveryAttempt: event.recoveryAttempt,
          });
        });
        eventBus.on('voice.connection.recovery', (event) => {
          recoveryAttempts.push(event.attempt);
        });

        const runtime = new DiscordVoiceRuntime({
          client: {
            on: vi.fn(),
            off: vi.fn(),
          } as any,
          config: makeConfig(),
          eventBus,
          getHandler: () => null,
        });

        const initialConnection = createMockVoiceConnection();
        const recoveredConnectionA = createMockVoiceConnection();
        const recoveredConnectionB = createMockVoiceConnection();
        voiceSdkMocks.joinVoiceChannel
          .mockReturnValueOnce(initialConnection)
          .mockReturnValueOnce(recoveredConnectionA)
          .mockReturnValueOnce(recoveredConnectionB);

        await (runtime as any).joinChannel(makeVoiceChannel('channel-1'));

        // Threshold breach 1 -> should detect degradation + execute recovery.
        for (let i = 0; i < 10; i++) {
          (runtime as any).recordStreamError('user-1');
        }
        await flushMicrotasks();

        // Threshold breach 2 during in-flight recovery -> detect only, no overlapping recovery.
        for (let i = 0; i < 10; i++) {
          (runtime as any).recordStreamError('user-1');
        }
        await flushMicrotasks();

        const detectedBeforeRejoin = degradedEvents.filter((event) => event.phase === 'degraded-detected');
        const executedBeforeRejoin = degradedEvents.filter((event) => event.phase === 'recovery-executed');
        expect(detectedBeforeRejoin).toHaveLength(2);
        expect(executedBeforeRejoin).toEqual([
          expect.objectContaining({
            userId: 'user-1',
            errorCount: 10,
            recoveryAttempt: 1,
          }),
        ]);
        expect(recoveryAttempts).toEqual([1]);
        expect(voiceSdkMocks.joinVoiceChannel).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(DECRYPT_RECOVERY_COOLDOWN_MS);
        await flushMicrotasks();

        expect(initialConnection.destroy).toHaveBeenCalledTimes(1);
        expect(voiceSdkMocks.joinVoiceChannel).toHaveBeenCalledTimes(2);

        // Threshold breach 3 after first recovery completes -> recovery should run again.
        for (let i = 0; i < 10; i++) {
          (runtime as any).recordStreamError('user-1');
        }
        await flushMicrotasks();
        await flushMicrotasks();

        const executedAfterSecondStart = degradedEvents.filter((event) => event.phase === 'recovery-executed');
        expect(executedAfterSecondStart).toEqual([
          expect.objectContaining({ recoveryAttempt: 1 }),
          expect.objectContaining({ recoveryAttempt: 2 }),
        ]);
        expect(recoveryAttempts).toEqual([1, 2]);

        await vi.advanceTimersByTimeAsync(DECRYPT_RECOVERY_COOLDOWN_MS);
        await flushMicrotasks();

        expect(voiceSdkMocks.joinVoiceChannel).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('isolates per-user stream error counts', () => {
      const eventBus = new EventBus();
      const handler = vi.fn();
      const { runtime } = makeRuntimeHarness(eventBus, handler);

      // Record errors for different users
      for (let i = 0; i < 5; i++) {
        (runtime as any).recordStreamError('user-a');
      }
      for (let i = 0; i < 3; i++) {
        (runtime as any).recordStreamError('user-b');
      }

      expect((runtime as any).streamErrorCounts.get('user-a')).toBe(5);
      expect((runtime as any).streamErrorCounts.get('user-b')).toBe(3);
    });

    it('resets stream error counts when joining a new channel', async () => {
      const eventBus = new EventBus();
      const handler = vi.fn();
      const { runtime } = makeRuntimeHarness(eventBus, handler);

      (runtime as any).recordStreamError('user-1');
      (runtime as any).recordStreamError('user-1');
      expect((runtime as any).streamErrorCounts.size).toBe(1);

      // leaveChannel should reset stream error counts
      await (runtime as any).leaveChannel('test-reset');
      expect((runtime as any).streamErrorCounts.size).toBe(0);
    });

    it('handles decoder creation failure gracefully in decodeOpusToPcm', async () => {
      const eventBus = new EventBus();
      const handler = vi.fn();
      const { runtime } = makeRuntimeHarness(eventBus, handler);

      // Temporarily make Decoder throw
      const originalDecoder = (prism as any).opus.Decoder;
      (prism as any).opus.Decoder = class ThrowingDecoder {
        constructor() {
          throw new Error('Could not find an Opus module');
        }
      };

      try {
        const fakeStream = new PassThrough();
        await expect(
          (runtime as any).decodeOpusToPcm(fakeStream),
        ).rejects.toThrow('Opus decoder unavailable');
      } finally {
        (prism as any).opus.Decoder = originalDecoder;
      }
    });

    it('double-fault containment prevents process crash when emitVoiceError throws', () => {
      const eventBus = new EventBus();
      const runtime = new DiscordVoiceRuntime({
        client: { on: vi.fn(), off: vi.fn() } as any,
        config: makeConfig(),
        eventBus,
        getHandler: () => null,
      });

      // Make emitVoiceError's internal eventBus.emit throw
      const origEmit = eventBus.emit.bind(eventBus);
      let emitCallCount = 0;
      vi.spyOn(eventBus, 'emit').mockImplementation(async (...args) => {
        emitCallCount++;
        if (emitCallCount <= 2) {
          throw new Error('EventBus emit failure');
        }
        return origEmit(...(args as [string, unknown]));
      });

      // This should NOT throw -- double fault should be caught
      expect(() => {
        (runtime as any).emitVoiceError(new Error('test error'));
      }).not.toThrow();
    });
  });
});
