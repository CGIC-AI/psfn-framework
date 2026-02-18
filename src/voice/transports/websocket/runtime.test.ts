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
      audioBase64: Buffer.from([1, 2, 3, 4]).toString('base64'),
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
      audioBase64: Buffer.from([10, 11]).toString('base64'),
    }));
    expect(playbackFrames).toContainEqual(expect.objectContaining({
      type: 'playback.chunk',
      seq: 1,
      audioBase64: Buffer.from([12, 13]).toString('base64'),
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
      audioBase64: 'not-base64!!!',
    });

    expect(harness.writeAudio).not.toHaveBeenCalled();
    expect(harness.outboundFrames).toContainEqual(expect.objectContaining({
      type: 'error',
      code: 'INVALID_AUDIO_BASE64',
      sessionId: 'voice-1',
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

async function waitForCondition(condition: () => boolean, maxAttempts = 40): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (condition()) {
      return;
    }
    await flushPromises();
  }

  throw new Error('Condition not met within wait window');
}
