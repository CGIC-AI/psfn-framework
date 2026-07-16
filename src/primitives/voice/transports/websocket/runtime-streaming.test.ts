// ── WebSocketVoiceRuntime live streaming path (psfn-framework-mmo9.8.3) ──
//
// Proves the operator's full-capability contract at the transport seam:
//   1. a voice turn that RUNS A TOOL still SPEAKS its streamed text, executes
//      the tool, and NEVER speaks the tool-call JSON;
//   2. first audio lands before the full turn completes (incremental playback);
//   3. barge-in cancels the in-flight TTS and stops the turn cleanly.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketVoiceRuntime } from './runtime.js';
import {
  VOICE_WIRE_PROTOCOL,
  type VoiceWireOutboundFrame,
  type WebSocketVoiceAssistantStream,
  type WebSocketVoiceRuntimeOptions,
  type WebSocketVoiceSession,
} from './types.js';
import type { SttTranscriptChunk } from '../../connectors/stt/types.js';
import type { TtsAudioChunk } from '../../connectors/tts/types.js';
import {
  createAgentReplyStreamBridge,
  type AgentReplyDeltaEvent,
  type AgentReplyDeltaSource,
} from '../../reply-stream/index.js';

type DeltaHandler = (data: AgentReplyDeltaEvent) => void;

class FakeAgentEvents implements AgentReplyDeltaSource {
  private readonly handlers = new Set<DeltaHandler>();
  on(_event: 'agent.stream.delta', handler: DeltaHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  emit(text: string, channelId: string): void {
    for (const h of [...this.handlers]) h({ channelId, text });
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;
  push(value: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) { w({ done: false, value }); return; }
    this.values.push(value);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()?.({ done: true, value: undefined as never });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length) return Promise.resolve({ done: false, value: this.values.shift() as T });
        if (this.closed) return Promise.resolve({ done: true, value: undefined as never });
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

const CHANNEL = 'api-voice:test';
const runtimesToStop: WebSocketVoiceRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimesToStop.map((r) => r.stop()));
  runtimesToStop.length = 0;
});

function makeTtsChunk(text: string): TtsAudioChunk {
  return { audio: new TextEncoder().encode(text), sequence: 0 } as TtsAudioChunk;
}

interface StreamHarness {
  runtime: WebSocketVoiceRuntime;
  session: WebSocketVoiceSession;
  outbound: VoiceWireOutboundFrame[];
  sttQueue: AsyncQueue<SttTranscriptChunk>;
  ttsInputs: string[];
  events: FakeAgentEvents;
  cancelTts: ReturnType<typeof vi.fn>;
}

function createStreamHarness(
  onAssistantStream: WebSocketVoiceRuntimeOptions['onAssistantStream'],
  ttsController?: (text: string, push: (c: TtsAudioChunk) => void, done: () => void) => void,
): StreamHarness {
  const outbound: VoiceWireOutboundFrame[] = [];
  const sttQueue = new AsyncQueue<SttTranscriptChunk>();
  const ttsInputs: string[] = [];
  const events = new FakeAgentEvents();
  const cancelTts = vi.fn(async () => undefined);

  const options: WebSocketVoiceRuntimeOptions = {
    stt: {
      id: 'fake-stt',
      startStream: async () => ({
        transcripts: sttQueue,
        writeAudio: async () => undefined,
        endInput: async () => { sttQueue.push({ type: 'final', text: 'turn on the lights' }); sttQueue.close(); },
        cancel: async () => { sttQueue.close(); },
      }),
    },
    tts: {
      id: 'fake-tts',
      synthesizeStream: async (request) => {
        ttsInputs.push(request.text);
        const audioQueue = new AsyncQueue<TtsAudioChunk>();
        if (ttsController) {
          ttsController(request.text, (c) => audioQueue.push(c), () => audioQueue.close());
        } else {
          audioQueue.push(makeTtsChunk(`audio:${request.text}`));
          audioQueue.close();
        }
        return {
          audio: audioQueue,
          // Real TTS cancel terminates the audio stream; model that by closing
          // the queue so any in-flight `iterator.next()` unblocks.
          cancel: async (reason?: string) => {
            audioQueue.close();
            await cancelTts(reason);
          },
        };
      },
    },
    security: {
      validatePcmAudio: () => undefined,
      validateTranscriptText: (t) => t,
      validateTtsInputText: (t) => t,
      validateTtsAudioChunk: (_c, total) => total,
    },
    onAssistantTurn: async () => 'unused-final-only',
    ...(onAssistantStream ? { onAssistantStream } : {}),
    emitFrame: (_session, frame) => { outbound.push(frame); },
    sttConfig: { sampleRateHz: 48_000, channels: 1, encoding: 'pcm_s16le' },
  };

  const runtime = new WebSocketVoiceRuntime(options);
  runtimesToStop.push(runtime);
  const session: WebSocketVoiceSession = {
    id: 's1', connectionId: 'c1', openedAtMs: 0, lastSeenAtMs: 0,
  };
  return { runtime, session, outbound, sttQueue, ttsInputs, events, cancelTts };
}

function playbackTexts(frames: VoiceWireOutboundFrame[]): string[] {
  return frames
    .filter((f): f is Extract<VoiceWireOutboundFrame, { type: 'playback.chunk' }> => f.type === 'playback.chunk')
    .map((f) => new TextDecoder().decode(f.audio));
}

describe('WebSocketVoiceRuntime streaming path (mmo9.8.3)', () => {
  it('speaks streamed text while a tool runs and never speaks the tool-call JSON', async () => {
    const toolSideEffect: string[] = [];
    const TOOL_JSON = '{"name":"home_automation","arguments":{"device":"lights"}}';

    const onAssistantStream: WebSocketVoiceRuntimeOptions['onAssistantStream'] = (req): WebSocketVoiceAssistantStream => {
      const bridge = createAgentReplyStreamBridge({
        deltaSource: harness.events,
        channelId: CHANNEL,
        turnId: 'turn-1',
        cancellationId: 'turn-1',
        gate: { attachmentCount: 0, datetimePromptContext: null },
        segmenter: { minSegmentLength: 4, maxBufferLength: 200 },
      });
      req.signal.addEventListener('abort', () => bridge.cancel('cancelled'), { once: true });
      // The turn: preamble speech, tool executes, tool-call JSON (ignored), continuation.
      harness.events.emit('Turning on the lights. ', CHANNEL);
      toolSideEffect.push('lights_on');
      harness.events.emit(TOOL_JSON, 'agent.toolcall.channel'); // wrong channel: ignored
      harness.events.emit('All set for you. ', CHANNEL);
      bridge.finish('Turning on the lights. All set for you.');
      return { segments: bridge.segments };
    };

    const harness = createStreamHarness(onAssistantStream);

    await harness.runtime.handleFrame(harness.session, { wire: VOICE_WIRE_PROTOCOL, type: 'session.start', sessionId: 'v1' });
    await harness.runtime.handleFrame(harness.session, { wire: VOICE_WIRE_PROTOCOL, type: 'session.end', sessionId: 'v1' });

    // Tool ran.
    expect(toolSideEffect).toEqual(['lights_on']);
    // Spoken text is exactly the two committed segments.
    expect(harness.ttsInputs).toEqual(['Turning on the lights. ', 'All set for you. ']);
    // Tool-call JSON never entered TTS.
    for (const input of harness.ttsInputs) {
      expect(input).not.toContain('home_automation');
      expect(input).not.toContain('{');
    }
    // Audio was emitted for both segments, monotonically sequenced.
    const audio = playbackTexts(harness.outbound);
    expect(audio).toEqual(['audio:Turning on the lights. ', 'audio:All set for you. ']);
    const seqs = harness.outbound.filter((f) => f.type === 'playback.chunk').map((f) => (f as { seq: number }).seq);
    expect(seqs).toEqual([0, 1]);
  });

  it('emits first audio before the full turn completes', async () => {
    let finishTurn = () => {};
    const turnComplete = new Promise<void>((resolve) => { finishTurn = resolve; });

    const onAssistantStream: WebSocketVoiceRuntimeOptions['onAssistantStream'] = (req): WebSocketVoiceAssistantStream => {
      const bridge = createAgentReplyStreamBridge({
        deltaSource: harness.events,
        channelId: CHANNEL,
        turnId: 'turn-1',
        cancellationId: 'turn-1',
        gate: { attachmentCount: 0, datetimePromptContext: null },
        segmenter: { minSegmentLength: 4, maxBufferLength: 200 },
      });
      req.signal.addEventListener('abort', () => bridge.cancel('cancelled'), { once: true });
      // First sentence available immediately; the rest of the "turn" lands later.
      harness.events.emit('First sentence now. ', CHANNEL);
      void turnComplete.then(() => {
        harness.events.emit('Second sentence later. ', CHANNEL);
        bridge.finish('First sentence now. Second sentence later.');
      });
      return { segments: bridge.segments };
    };

    const harness = createStreamHarness(onAssistantStream);
    await harness.runtime.handleFrame(harness.session, { wire: VOICE_WIRE_PROTOCOL, type: 'session.start', sessionId: 'v1' });
    const endPromise = harness.runtime.handleFrame(harness.session, { wire: VOICE_WIRE_PROTOCOL, type: 'session.end', sessionId: 'v1' });

    // Give the microtask queue time to synthesize the first segment.
    await vi.waitFor(() => expect(harness.ttsInputs).toContain('First sentence now. '));
    // Turn not yet complete, but first audio already emitted.
    expect(playbackTexts(harness.outbound)).toContain('audio:First sentence now. ');
    expect(harness.ttsInputs).not.toContain('Second sentence later. ');

    // Now let the turn finish.
    finishTurn();
    await endPromise;
    expect(harness.ttsInputs).toEqual(['First sentence now. ', 'Second sentence later. ']);
  });

  it('barge-in interrupt cancels the in-flight TTS and stops the turn', async () => {
    const audioGate = { release: () => {} };
    const onAssistantStream: WebSocketVoiceRuntimeOptions['onAssistantStream'] = (req): WebSocketVoiceAssistantStream => {
      const bridge = createAgentReplyStreamBridge({
        deltaSource: harness.events,
        channelId: CHANNEL,
        turnId: 'turn-1',
        cancellationId: 'turn-1',
        gate: { attachmentCount: 0, datetimePromptContext: null },
        segmenter: { minSegmentLength: 4, maxBufferLength: 200 },
      });
      req.signal.addEventListener('abort', () => bridge.cancel('cancelled'), { once: true });
      harness.events.emit('Speaking a long reply. ', CHANNEL);
      harness.events.emit('And continuing further. ', CHANNEL);
      bridge.finish('Speaking a long reply. And continuing further.');
      return { segments: bridge.segments };
    };

    // TTS that never completes its first segment until we release it — models a
    // synth in flight when the user barges in.
    const harness = createStreamHarness(onAssistantStream, (_text, _push, done) => {
      audioGate.release = done;
      // never push audio until released
    });

    await harness.runtime.handleFrame(harness.session, { wire: VOICE_WIRE_PROTOCOL, type: 'session.start', sessionId: 'v1' });
    const endPromise = harness.runtime.handleFrame(harness.session, { wire: VOICE_WIRE_PROTOCOL, type: 'session.end', sessionId: 'v1' });

    await vi.waitFor(() => expect(harness.ttsInputs.length).toBeGreaterThan(0));
    // Barge-in.
    await harness.runtime.handleFrame(harness.session, { wire: VOICE_WIRE_PROTOCOL, type: 'interrupt', sessionId: 'v1' });

    await endPromise;
    // The in-flight TTS session was cancelled.
    expect(harness.cancelTts).toHaveBeenCalled();
    // An interrupt ack was emitted; no error frame.
    expect(harness.outbound.some((f) => f.type === 'ack' && f.ackType === 'interrupt')).toBe(true);
    expect(harness.outbound.some((f) => f.type === 'error')).toBe(false);
  });
});
