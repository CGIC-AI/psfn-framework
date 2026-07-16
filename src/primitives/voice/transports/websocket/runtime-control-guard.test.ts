import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketVoiceRuntime } from './runtime.js';
import {
  VOICE_WIRE_PROTOCOL,
  type VoiceWireOutboundFrame,
  type WebSocketVoiceSession,
} from './types.js';
import type { SttTranscriptChunk } from '../../connectors/stt/types.js';
import type { TtsAudioChunk } from '../../connectors/tts/types.js';

/**
 * psfn-framework-mmo9.7.5: spoken transport controls (stop / interrupt / repeat)
 * must be handled locally by the WebSocket voice runtime with ZERO invocations
 * of the assistant/model handler. This harness gives every session.start its own
 * fresh STT/TTS queues so multi-turn (populate-then-repeat) flows are testable.
 */

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined as never });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.values.length > 0) {
          return Promise.resolve({ done: false, value: this.values.shift() as T });
        }
        if (this.closed) {
          return Promise.resolve({ done: true, value: undefined as never });
        }
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

interface ControlHarness {
  runtime: WebSocketVoiceRuntime;
  session: WebSocketVoiceSession;
  outboundFrames: VoiceWireOutboundFrame[];
  onAssistantTurn: ReturnType<typeof vi.fn>;
  synthesizeStream: ReturnType<typeof vi.fn>;
  sttQueues: Array<AsyncQueue<SttTranscriptChunk>>;
  runTurn(sessionId: string, transcript: string): Promise<void>;
}

const runtimesToStop: WebSocketVoiceRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimesToStop.map((runtime) => runtime.stop()));
  runtimesToStop.length = 0;
});

function createTtsChunk(bytes: number[]): TtsAudioChunk {
  return {
    audio: new Uint8Array(bytes),
    sequence: 0,
    isFinal: true,
    encoding: 'pcm_s16le',
    source: 'stream',
  };
}

function createControlHarness(): ControlHarness {
  const session: WebSocketVoiceSession = {
    id: 'conn-ctl',
    connectionId: 'conn-ctl',
    openedAtMs: 1,
    lastSeenAtMs: 1,
  };

  const sttQueues: Array<AsyncQueue<SttTranscriptChunk>> = [];
  const startStream = vi.fn(async () => {
    const queue = new AsyncQueue<SttTranscriptChunk>();
    sttQueues.push(queue);
    return {
      transcripts: queue,
      writeAudio: vi.fn(async () => {}),
      endInput: vi.fn(async () => { queue.close(); }),
      cancel: vi.fn(async () => { queue.close(); }),
    };
  });

  // A fresh, single-chunk TTS stream per synth call so a replayed utterance
  // still produces observable playback frames.
  const synthesizeStream = vi.fn(async () => {
    const queue = new AsyncQueue<TtsAudioChunk>();
    queue.push(createTtsChunk([9, 9]));
    queue.close();
    return { audio: queue, cancel: vi.fn(async () => {}) };
  });

  const onAssistantTurn = vi.fn(async () => 'the time is noon');
  const outboundFrames: VoiceWireOutboundFrame[] = [];

  const runtime = new WebSocketVoiceRuntime({
    stt: { id: 'stt-test', startStream },
    tts: { id: 'tts-test', synthesizeStream },
    security: {
      validatePcmAudio: vi.fn(() => undefined),
      validateTranscriptText: vi.fn((text: string) => text.trim()),
      validateTtsInputText: vi.fn((text: string) => text.trim()),
      validateTtsAudioChunk: vi.fn((chunk: Uint8Array, total: number) => total + chunk.byteLength),
    },
    onAssistantTurn,
    emitFrame: (_session, frame) => { outboundFrames.push(frame); },
    sttConfig: { sampleRateHz: 16_000, channels: 1, encoding: 'pcm_s16le', interimResults: true },
  });
  runtimesToStop.push(runtime);

  const runTurn = async (sessionId: string, transcript: string): Promise<void> => {
    await runtime.handleFrame(session, { wire: VOICE_WIRE_PROTOCOL, type: 'session.start', sessionId });
    const queue = sttQueues[sttQueues.length - 1]!;
    queue.push({ type: 'final', text: transcript });
    await runtime.handleFrame(session, { wire: VOICE_WIRE_PROTOCOL, type: 'session.end', sessionId });
  };

  return { runtime, session, outboundFrames, onAssistantTurn, synthesizeStream, sttQueues, runTurn };
}

function playbackFrames(frames: VoiceWireOutboundFrame[]): VoiceWireOutboundFrame[] {
  return frames.filter((frame) => frame.type === 'playback.chunk');
}

function sessionEndAck(frames: VoiceWireOutboundFrame[]): VoiceWireOutboundFrame | undefined {
  return frames.find((frame) => frame.type === 'ack' && frame.ackType === 'session.end');
}

// Drive one STT session that emits several `final` transcripts before end.
async function runMultiFinalTurn(
  harness: ControlHarness,
  sessionId: string,
  finals: string[],
): Promise<void> {
  await harness.runtime.handleFrame(harness.session, {
    wire: VOICE_WIRE_PROTOCOL,
    type: 'session.start',
    sessionId,
  });
  const queue = harness.sttQueues[harness.sttQueues.length - 1]!;
  for (const text of finals) {
    queue.push({ type: 'final', text });
  }
  await harness.runtime.handleFrame(harness.session, {
    wire: VOICE_WIRE_PROTOCOL,
    type: 'session.end',
    sessionId,
  });
}

describe('WebSocketVoiceRuntime deterministic control-intent guard (mmo9.7.5)', () => {
  it.each(['stop', 'be quiet', 'wait wait', 'hold on', 'never mind'])(
    'handles spoken control "%s" locally with zero model invocations',
    async (phrase) => {
      const harness = createControlHarness();

      await harness.runTurn('voice-1', phrase);

      expect(harness.onAssistantTurn).not.toHaveBeenCalled();
      // stop/interrupt speak nothing back — no synthesis at all.
      expect(harness.synthesizeStream).not.toHaveBeenCalled();
      // The turn still closes cleanly with a session.end ack.
      expect(sessionEndAck(harness.outboundFrames)).toBeDefined();
      expect(playbackFrames(harness.outboundFrames)).toHaveLength(0);
    },
  );

  it('guards a control-only multi-final session (d8vq.1 stacked controls)', async () => {
    const harness = createControlHarness();

    // Every final is a control ("stop","stop") — deterministic silence, ZERO
    // model/synthesis calls, clean close.
    await runMultiFinalTurn(harness, 'voice-1', ['stop', 'stop']);

    expect(harness.onAssistantTurn).not.toHaveBeenCalled();
    expect(harness.synthesizeStream).not.toHaveBeenCalled();
    expect(sessionEndAck(harness.outboundFrames)).toBeDefined();
    expect(playbackFrames(harness.outboundFrames)).toHaveLength(0);
  });

  it('takes the last final on a control-only session with differing intents (d8vq.1 last-wins)', async () => {
    const harness = createControlHarness();

    // First turn: a real reply so a subsequent "repeat" would have something to
    // replay — this proves the session resolves to "stop" (silence), not repeat.
    await harness.runTurn('voice-1', 'what time is it');
    expect(harness.onAssistantTurn).toHaveBeenCalledTimes(1);
    expect(harness.synthesizeStream).toHaveBeenCalledTimes(1);

    harness.onAssistantTurn.mockClear();
    harness.synthesizeStream.mockClear();
    harness.outboundFrames.length = 0;

    // Control-only ["repeat","stop"]: last-wins -> stop -> deterministic silence,
    // NOT a replay of the prior utterance.
    await runMultiFinalTurn(harness, 'voice-2', ['repeat', 'stop']);

    expect(harness.onAssistantTurn).not.toHaveBeenCalled();
    expect(harness.synthesizeStream).not.toHaveBeenCalled();
    expect(playbackFrames(harness.outboundFrames)).toHaveLength(0);
    expect(sessionEndAck(harness.outboundFrames)).toBeDefined();
  });

  it('sends a content-then-control multi-final session to the model, never swallowing it (d8vq.1)', async () => {
    const harness = createControlHarness();

    // "don't stop": STT splits into ["don't","stop"]. The joined transcript is
    // not a control and a non-control final is present, so the whole turn must
    // reach the model — the pre-existing safe-direction limitation. Never a
    // silent drop.
    await runMultiFinalTurn(harness, 'voice-1', ["don't", 'stop']);

    expect(harness.onAssistantTurn).toHaveBeenCalledTimes(1);
    expect(harness.onAssistantTurn).toHaveBeenCalledWith(expect.objectContaining({
      transcript: "don't stop",
    }));
  });

  it('sends longer content-then-control multi-final speech to the model (d8vq.1)', async () => {
    const harness = createControlHarness();

    await runMultiFinalTurn(harness, 'voice-1', ['tell me about cats', 'stop']);

    expect(harness.onAssistantTurn).toHaveBeenCalledTimes(1);
    expect(harness.onAssistantTurn).toHaveBeenCalledWith(expect.objectContaining({
      transcript: 'tell me about cats stop',
    }));
  });

  it('does not treat ordinary speech containing a control word as a control', async () => {
    const harness = createControlHarness();

    await harness.runTurn('voice-1', 'stop by the store on your way home');

    expect(harness.onAssistantTurn).toHaveBeenCalledTimes(1);
    expect(harness.onAssistantTurn).toHaveBeenCalledWith(expect.objectContaining({
      transcript: 'stop by the store on your way home',
    }));
  });

  it('replays the last utterance on spoken "repeat" with zero model invocations', async () => {
    const harness = createControlHarness();

    // First turn: a real model reply is synthesized and remembered.
    await harness.runTurn('voice-1', 'what time is it');
    expect(harness.onAssistantTurn).toHaveBeenCalledTimes(1);
    expect(harness.synthesizeStream).toHaveBeenCalledTimes(1);

    harness.onAssistantTurn.mockClear();
    harness.outboundFrames.length = 0;

    // Second turn: spoken "repeat that" replays locally — no model call, but the
    // last utterance is re-synthesized and streamed back.
    await harness.runTurn('voice-2', 'repeat that');

    expect(harness.onAssistantTurn).not.toHaveBeenCalled();
    expect(harness.synthesizeStream).toHaveBeenCalledTimes(2);
    const replayRequest = harness.synthesizeStream.mock.calls[1]![0] as { text: string };
    expect(replayRequest.text).toBe('the time is noon');
    expect(playbackFrames(harness.outboundFrames).length).toBeGreaterThan(0);
    expect(sessionEndAck(harness.outboundFrames)).toBeDefined();
  });

  it('replays nothing (still no model call) when there is no prior utterance', async () => {
    const harness = createControlHarness();

    await harness.runTurn('voice-1', 'say that again');

    expect(harness.onAssistantTurn).not.toHaveBeenCalled();
    expect(harness.synthesizeStream).not.toHaveBeenCalled();
    expect(sessionEndAck(harness.outboundFrames)).toBeDefined();
  });
});
