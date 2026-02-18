import { describe, expect, it, beforeEach, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventBus } from '../../event-bus.js';
import type { SubstrateConfig } from '../../types.js';

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
  };
});

const reliabilityMocks = vi.hoisted(() => {
  return {
    runWithVoiceStageBudget: vi.fn(async ({ task }: { task: () => Promise<unknown> }) => task()),
    resolveVoiceReliabilityBudgets: vi.fn(() => ({
      ingest: { timeoutMs: 10, maxRetries: 0, baseDelayMs: 0 },
      stt: { timeoutMs: 10, maxRetries: 0, baseDelayMs: 0 },
      llm: { timeoutMs: 10, maxRetries: 0, baseDelayMs: 0 },
      tts: { timeoutMs: 10, maxRetries: 0, baseDelayMs: 0 },
      output: { timeoutMs: 10, maxRetries: 0, baseDelayMs: 0 },
    })),
    buildFallbackOrder: vi.fn((_preferredId: string, providerIds: string[]) => providerIds),
    selectFallbackCandidate: vi.fn((preferredId: string, candidates: Array<{ id: string }>) => {
      return candidates.find((candidate) => candidate.id === preferredId) ?? candidates[0] ?? null;
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
  return {
    createAudioResource: vi.fn((resource: unknown) => ({ resource })),
    entersState: vi.fn(async () => undefined),
    createAudioPlayer: vi.fn(() => ({
      play: vi.fn(),
      stop: vi.fn(),
    })),
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
    joinVoiceChannel: vi.fn(),
    AudioPlayerStatus: {
      Playing: 'playing',
      Idle: 'idle',
    },
    VoiceConnectionStatus: {
      Ready: 'ready',
    },
  };
});

vi.mock('prism-media', () => {
  return {
    default: {
      opus: {
        Decoder: class MockDecoder {
          on(): void {}
          once(): void {}
        },
      },
    },
  };
});

vi.mock('../../voice/connectors/stt/index.js', () => {
  return {
    createStreamingSttConnector: connectorMocks.createStreamingSttConnector,
  };
});

vi.mock('../../voice/connectors/tts/index.js', () => {
  return {
    createStreamingTtsConnector: connectorMocks.createStreamingTtsConnector,
  };
});

vi.mock('../../voice/policy/reliability.js', () => {
  return {
    runWithVoiceStageBudget: reliabilityMocks.runWithVoiceStageBudget,
    resolveVoiceReliabilityBudgets: reliabilityMocks.resolveVoiceReliabilityBudgets,
    buildFallbackOrder: reliabilityMocks.buildFallbackOrder,
    selectFallbackCandidate: reliabilityMocks.selectFallbackCandidate,
  };
});

vi.mock('../../voice/policy/security.js', () => {
  return {
    resolveVoiceSecurityLimits: securityMocks.resolveVoiceSecurityLimits,
    validatePcmAudio: securityMocks.validatePcmAudio,
    validateTranscriptText: securityMocks.validateTranscriptText,
    validateTtsInputText: securityMocks.validateTtsInputText,
    validateTtsAudioChunk: securityMocks.validateTtsAudioChunk,
  };
});

import { DiscordVoiceRuntime } from './voice.js';

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
    memoryBudgetPct: 20,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    modelRoster: {
      chat: { model: 'test', provider: 'test', maxTokens: 1024, contextWindow: 10_000 },
    },
    voiceEnabled: true,
    voiceTargetGuildId: 'guild-1',
    voiceTargetUserId: 'user-1',
    deepgramApiKey: 'deepgram-key',
    elevenLabsApiKey: 'elevenlabs-key',
    elevenLabsVoiceId: 'voice-id',
    ...overrides,
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
    receiver: {
      subscribe: vi.fn(() => new PassThrough()),
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
    connectorMocks.createStreamingSttConnector.mockClear();
    connectorMocks.createStreamingTtsConnector.mockClear();
    connectorMocks.sttConnector.startStream.mockReset();
    connectorMocks.ttsConnector.synthesizeStream.mockReset();
    connectorMocks.ttsConnector.synthesizeBuffer.mockReset();

    reliabilityMocks.runWithVoiceStageBudget.mockClear();
    securityMocks.validatePcmAudio.mockReset();
    securityMocks.validateTranscriptText.mockReset();
    securityMocks.validateTranscriptText.mockImplementation((text: string) => text.trim());
    securityMocks.validateTtsInputText.mockReset();
    securityMocks.validateTtsInputText.mockImplementation((text: string) => text.trim());
    securityMocks.validateTtsAudioChunk.mockReset();
    securityMocks.validateTtsAudioChunk.mockImplementation((chunk: Uint8Array, total: number) => total + chunk.byteLength);

    voiceSdkMocks.entersState.mockReset();
    voiceSdkMocks.entersState.mockImplementation(async () => undefined);
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
});
