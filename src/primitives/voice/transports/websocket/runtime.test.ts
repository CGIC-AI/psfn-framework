import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketVoiceRuntime } from './runtime.js';
import {
  VOICE_WIRE_PROTOCOL,
  type VoiceWireOutboundFrame,
  type WebSocketVoiceRuntimeOptions,
  type WebSocketVoiceSession,
} from './types.js';
import type { SttTranscriptChunk } from '../../connectors/stt/types.js';
import type { TtsAudioChunk } from '../../connectors/tts/types.js';
import {
  resolveVoiceReliabilityBudgets,
  runWithVoiceStageBudget,
} from '../../policy/reliability.js';

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private failure: Error | null = null;

  push(value: T): void {
    if (this.closed || this.failure) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }

    this.values.push(value);
  }

  close(): void {
    if (this.closed || this.failure) {
      return;
    }

    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.resolve({ done: true, value: undefined as never });
    }
  }

  fail(error: Error): void {
    if (this.closed || this.failure) {
      return;
    }

    this.failure = error;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
    };
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.values.length > 0) {
      const value = this.values.shift() as T;
      return Promise.resolve({ done: false, value });
    }

    if (this.failure) {
      return Promise.reject(this.failure);
    }

    if (this.closed) {
      return Promise.resolve({ done: true, value: undefined as never });
    }

    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }
}

interface RuntimeHarness {
  runtime: WebSocketVoiceRuntime;
  transportSession: WebSocketVoiceSession;
  outboundFrames: VoiceWireOutboundFrame[];
  sttQueue: AsyncQueue<SttTranscriptChunk>;
  ttsQueue: AsyncQueue<TtsAudioChunk>;
  startStream: ReturnType<typeof vi.fn>;
  writeAudio: ReturnType<typeof vi.fn>;
  endInput: ReturnType<typeof vi.fn>;
  cancelStt: ReturnType<typeof vi.fn>;
  synthesizeStream: ReturnType<typeof vi.fn>;
  cancelTts: ReturnType<typeof vi.fn>;
  onAssistantTurn: ReturnType<typeof vi.fn>;
}

const runtimesToStop: WebSocketVoiceRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimesToStop.map((runtime) => runtime.stop()));
  runtimesToStop.length = 0;
});

describe('WebSocketVoiceRuntime', () => {
  it('creates per-session state on session.start and emits ack', async () => {
    const harness = createHarness();

    await harness.runtime.handleFrame(harness.transportSession, {
      wire: VOICE_WIRE_PROTOCOL,
      type: 'session.start',
      sessionId: 'voice-1',
    });

    expect(harness.startStream).toHaveBeenCalledOnce();
    expect(findAckFrame(harness.outboundFrames, 'session.start')).toBeDefined();
  });

  it('treats duplicate session.start as idempotent while start is in progress', async () => {
    const harness = createHarness();
    const startGate = createDeferred<void>();
    harness.startStream.mockImplementation(async () => {
      await startGate.promise;
      return {
        transcripts: harness.sttQueue,
        writeAudio: harness.writeAudio,
        endInput: harness.endInput,
        cancel: harness.cancelStt,
      };
    });

    const firstStart = harness.runtime.handleFrame(harness.transportSession, {
      wire: VOICE_WIRE_PROTOCOL,
      type: 'session.start',
      sessionId: 'voice-1',
    });
    await flushPromises();

    const secondStart = harness.runtime.handleFrame(harness.transportSession, {
      wire: VOICE_WIRE_PROTOCOL,
      type: 'session.start',
      sessionId: 'voice-1',
    });
    await flushPromises();

    expect(harness.startStream).toHaveBeenCalledTimes(1);

    startGate.resolve();
    await Promise.all([firstStart, secondStart]);

    const sessionStartAcks = harness.outboundFrames.filter((frame) => (
      frame.type === 'ack' && frame.ackType === 'session.start'
    ));
    expect(harness.startStream).toHaveBeenCalledTimes(1);
    expect(sessionStartAcks).toHaveLength(2);
  });

  it('acknowledges repeated session.start without restarting active streams', async () => {
    const harness = createHarness();

    await harness.runtime.handleFrame(harness.transportSession, {
      wire: VOICE_WIRE_PROTOCOL,
      type: 'session.start',
      sessionId: 'voice-1',
    });

    harness.outboundFrames.length = 0;
    await harness.runtime.handleFrame(harness.transportSession, {
      wire: VOICE_WIRE_PROTOCOL,
      type: 'session.start',
      sessionId: 'voice-1',
    });

    expect(harness.startStream).toHaveBeenCalledTimes(1);
    expect(harness.cancelStt).not.toHaveBeenCalled();
    expect(findAckFrame(harness.outboundFrames, 'session.start')).toBeDefined();
  });

  it('decodes audio.chunk, validates it, and streams transcript frames', async () => {
    const harness = createHarness();

    await harness.runtime.handleFrame(harness.transportSession, {
      wire: VOICE_WIRE_PROTOCOL,
      type: 'session.start',
      sessionId: 'voice-1',
    });

    harness.outboundFrames.length = 0;
    await harness.runtime.handleFrame(harness.transportSession, {
      wire: VOICE_WIRE_PROTOCOL,
      type: 'audio.chunk',
      sessionId: 'voice-1',
      seq: 1,
      audio: new Uint8Array([1, 2, 3, 4]),
    });

    harness.sttQueue.push({ type: 'partial', text: 'hello' });
    harness.sttQueue.push({ type: 'final', text: 'hello world' });
    await waitForCondition(() => containsTranscriptFrame(harness.outboundFrames, 'transcript.final', 'hello world'));

    expect(harness.writeAudio).toHaveBeenCalledWith(new Uint8Array([1, 2, 3, 4]));
    expect(findAckFrame(harness.outboundFrames, 'audio.chunk')).toBeDefined();
    expect(containsTranscriptFrame(harness.outboundFrames, 'transcript.partial', 'hello')).toBe(true);
    expect(containsTranscriptFrame(harness.outboundFrames, 'transcript.final', 'hello world')).toBe(true);
  });

  it('finalizes STT, calls assistant handler, and streams playback on session.end', async () => {
    const harness = createHarness();

    harness.ttsQueue.push(createTtsChunk(0, [10, 11], false));
    harness.ttsQueue.push(createTtsChunk(1, [12, 13], true));
    harness.ttsQueue.close();

    await harness.runtime.handleFrame(harness.transportSession, {
      wire: VOICE_WIRE_PROTOCOL,
      type: 'session.start',
      sessionId: 'voice-1',
    });

    harness.sttQueue.push({ type: 'final', text: 'what time is it' });
    await harness.runtime.handleFrame(harness.transportSession, {
      wire: VOICE_WIRE_PROTOCOL,
      type: 'session.end',
      sessionId: 'voice-1',
    });

    expect(harness.endInput).toHaveBeenCalledOnce();
    expect(harness.onAssistantTurn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'voice-1',
      transcript: 'what time is it',
    }));

    const playbackFrames = harness.outboundFrames.filter((frame) => frame.type === 'playback.chunk');
    expect(playbackFrames).toHaveLength(2);
    expect(playbackFrames).toContainEqual(expect.objectContaining({
      type: 'playback.chunk',
      seq: 0,
      audio: new Uint8Array([10, 11]),
    }));
    expect(playbackFrames).toContainEqual(expect.objectContaining({
      type: 'playback.chunk',
      seq: 1,
      audio: new Uint8Array([12, 13]),
    }));
    expect(findAckFrame(harness.outboundFrames, 'session.end')).toBeDefined();
  });

  it('cancels in-flight synthesis when interrupted', async () => {
    const harness = createHarness();

    await harness.runtime.handleFrame(harness.transportSession, {
      wire: VOICE_WIRE_PROTOCOL,
      type: 'session.start',
      sessionId: 'voice-1',
    });
    harness.sttQueue.push({ type: 'final', text: 'interrupt test' });

    const endPromise = harness.runtime.handleFrame(harness.transportSession, {
      wire: VOICE_WIRE_PROTOCOL,
      type: 'session.end',
      sessionId: 'voice-1',
    });

    await waitForCondition(() => harness.synthesizeStream.mock.calls.length === 1);
    harness.ttsQueue.push(createTtsChunk(0, [21, 22], false));
    await flushPromises();

    await harness.runtime.handleFrame(harness.transportSession, {
      wire: VOICE_WIRE_PROTOCOL,
      type: 'interrupt',
      sessionId: 'voice-1',
      reason: 'barge-in',
    });
    await endPromise;

    expect(harness.cancelStt).toHaveBeenCalled();
    expect(harness.cancelTts).toHaveBeenCalled();
    expect(findAckFrame(harness.outboundFrames, 'interrupt')).toBeDefined();
  });

  it('emits error frames for invalid audio payloads', async () => {
    const harness = createHarness();

    await harness.runtime.handleFrame(harness.transportSession, {
      wire: VOICE_WIRE_PROTOCOL,
      type: 'session.start',
      sessionId: 'voice-1',
    });

    harness.outboundFrames.length = 0;
    await harness.runtime.handleFrame(harness.transportSession, {
      wire: VOICE_WIRE_PROTOCOL,
      type: 'audio.chunk',
      sessionId: 'voice-1',
      seq: 0,
      audio: new Uint8Array(),
    });

    expect(harness.writeAudio).not.toHaveBeenCalled();
    expect(harness.outboundFrames).toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'INVALID_AUDIO_CHUNK',
      sessionId: 'voice-1',
    }));
  });

  // mmo9.6.4: the WebSocket path budgets synth-request -> first audible chunk
  // under the short, retry-safe `tts_first_byte` stage. A stalled first byte must
  // time out and re-synthesize, cancelling the prior session BEFORE the retry so
  // two streams never overlap.
  it('cancels the prior TTS session before re-synth when the first audible byte stalls', async () => {
    const events: string[] = [];
    const firstSession = {
      audio: {
        [Symbol.asyncIterator]() {
          return { next: () => new Promise<IteratorResult<TtsAudioChunk>>(() => {}) };
        },
      },
      cancel: vi.fn(async () => { events.push('cancel-prior'); }),
    };
    const secondQueue = new AsyncQueue<TtsAudioChunk>();
    secondQueue.push(createTtsChunk(0, [7, 8], true));
    secondQueue.close();
    const secondSession = { audio: secondQueue, cancel: vi.fn(async () => {}) };

    let synthCall = 0;
    const synthesizeStream = vi.fn(async () => {
      synthCall += 1;
      events.push(`synth-${synthCall}`);
      return synthCall === 1 ? firstSession : secondSession;
    });

    const budgets = resolveVoiceReliabilityBudgets({
      tts_first_byte: { timeoutMs: 25, maxRetries: 1, baseDelayMs: 0 },
    });
    const reliability = {
      runStage: <T>(stage: Parameters<typeof runWithVoiceStageBudget>[0]['stage'], task: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal) =>
        runWithVoiceStageBudget({ stage, budgets, signal, task }),
    };

    const harness = createHarness({
      tts: { id: 'tts-test', synthesizeStream },
      reliability,
    });

    await harness.runtime.handleFrame(harness.transportSession, {
      wire: VOICE_WIRE_PROTOCOL,
      type: 'session.start',
      sessionId: 'voice-1',
    });
    harness.sttQueue.push({ type: 'final', text: 'hi' });
    await harness.runtime.handleFrame(harness.transportSession, {
      wire: VOICE_WIRE_PROTOCOL,
      type: 'session.end',
      sessionId: 'voice-1',
    });

    expect(synthesizeStream).toHaveBeenCalledTimes(2);
    expect(firstSession.cancel).toHaveBeenCalledWith('tts-first-byte-retry');
    expect(events).toEqual(['synth-1', 'cancel-prior', 'synth-2']);

    const playbackFrames = harness.outboundFrames.filter((frame) => frame.type === 'playback.chunk');
    expect(playbackFrames).toHaveLength(1);
    expect(playbackFrames[0]).toEqual(expect.objectContaining({
      type: 'playback.chunk',
      seq: 0,
      audio: new Uint8Array([7, 8]),
    }));
  });
});

function createHarness(overrides: Partial<WebSocketVoiceRuntimeOptions> = {}): RuntimeHarness {
  const transportSession: WebSocketVoiceSession = {
    id: 'conn-1',
    connectionId: 'conn-1',
    openedAtMs: 1,
    lastSeenAtMs: 1,
  };

  const sttQueue = new AsyncQueue<SttTranscriptChunk>();
  const writeAudio = vi.fn(async () => {});
  const endInput = vi.fn(async () => {
    sttQueue.close();
  });
  const cancelStt = vi.fn(async () => {
    sttQueue.close();
  });
  const startStream = vi.fn(async () => ({
    transcripts: sttQueue,
    writeAudio,
    endInput,
    cancel: cancelStt,
  }));

  const ttsQueue = new AsyncQueue<TtsAudioChunk>();
  const cancelTts = vi.fn(async () => {
    ttsQueue.close();
  });
  const synthesizeStream = vi.fn(async () => ({
    audio: ttsQueue,
    cancel: cancelTts,
  }));

  const onAssistantTurn = vi.fn(async () => 'assistant reply');
  const outboundFrames: VoiceWireOutboundFrame[] = [];

  const runtime = new WebSocketVoiceRuntime({
    stt: {
      id: 'stt-test',
      startStream,
    },
    tts: {
      id: 'tts-test',
      synthesizeStream,
    },
    security: {
      validatePcmAudio: vi.fn(() => undefined),
      validateTranscriptText: vi.fn((text: string) => text.trim()),
      validateTtsInputText: vi.fn((text: string) => text.trim()),
      validateTtsAudioChunk: vi.fn((chunk: Uint8Array, totalBytesSoFar: number) => totalBytesSoFar + chunk.byteLength),
    },
    onAssistantTurn,
    emitFrame: async (_session, frame) => {
      outboundFrames.push(frame);
    },
    sttConfig: {
      sampleRateHz: 16_000,
      channels: 1,
      encoding: 'pcm_s16le',
      interimResults: true,
    },
    ...overrides,
  });

  runtimesToStop.push(runtime);

  return {
    runtime,
    transportSession,
    outboundFrames,
    sttQueue,
    ttsQueue,
    startStream,
    writeAudio,
    endInput,
    cancelStt,
    synthesizeStream,
    cancelTts,
    onAssistantTurn,
  };
}

function containsTranscriptFrame(
  frames: VoiceWireOutboundFrame[],
  type: 'transcript.partial' | 'transcript.final',
  text: string,
): boolean {
  return frames.some((frame) => frame.type === type && frame.text === text);
}

function findAckFrame(
  frames: VoiceWireOutboundFrame[],
  ackType: 'session.start' | 'audio.chunk' | 'session.end' | 'interrupt' | 'ping',
) {
  return frames.find((frame) => frame.type === 'ack' && frame.ackType === ackType);
}

function createTtsChunk(sequence: number, bytes: number[], isFinal: boolean): TtsAudioChunk {
  return {
    audio: new Uint8Array(bytes),
    sequence,
    isFinal,
    encoding: 'pcm_s16le',
    source: 'stream',
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolveDeferred!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolveDeferred = resolvePromise;
    reject = rejectPromise;
  });

  const resolve = (value?: T | PromiseLike<T>) => {
    resolveDeferred(value as T | PromiseLike<T>);
  };

  return {
    promise,
    resolve,
    reject,
  };
}

async function waitForCondition(condition: () => boolean, maxAttempts = 40): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (condition()) {
      return;
    }
    await flushPromises();
  }

  throw new Error('Condition not met within wait window');
}
