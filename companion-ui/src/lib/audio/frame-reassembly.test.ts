import { describe, expect, it } from 'vitest';
import type { HubToClientMessage } from '../protocol/events.js';
import {
  AUDIO_END_SIGNAL,
  AUDIO_INIT_SIGNAL,
  VOICE_PLAYBACK_LIMITS,
  classifyPlaybackSignal,
  consumeUtterance,
  createVoicePlaybackState,
  reduceVoicePlayback,
  resetVoicePlayback,
  type VoicePlaybackState,
} from './frame-reassembly.js';

const AT = '2026-07-22T00:00:00.000Z';
// 'AAAA' decodes to 3 bytes of standard base64.
const CHUNK = 'AAAA';

function supported(): VoicePlaybackState {
  return createVoicePlaybackState(true);
}

function drive(state: VoicePlaybackState, ...signals: HubToClientMessage[]): VoicePlaybackState {
  return signals.reduce((current, message) => {
    const signal = classifyPlaybackSignal(message);
    return signal ? reduceVoicePlayback(current, signal, AT) : current;
  }, state);
}

const init: HubToClientMessage = { type: 'text', data: AUDIO_INIT_SIGNAL };
const end: HubToClientMessage = { type: 'text', data: AUDIO_END_SIGNAL };
const audio = (data: string): HubToClientMessage => ({ type: 'audio', data });

describe('classifyPlaybackSignal', () => {
  it('maps only the exact bracket text signals and audio frames', () => {
    expect(classifyPlaybackSignal(init)).toEqual({ kind: 'init' });
    expect(classifyPlaybackSignal(end)).toEqual({ kind: 'end' });
    expect(classifyPlaybackSignal(audio(CHUNK))).toEqual({ kind: 'chunk', base64: CHUNK });
  });

  it('ignores caption text and non-audio frames', () => {
    expect(classifyPlaybackSignal({ type: 'text', data: 'hello there' })).toBeNull();
    expect(classifyPlaybackSignal({ type: 'status', data: 'call_initialized' })).toBeNull();
    expect(classifyPlaybackSignal({ type: 'pong', sentAt: 1 })).toBeNull();
  });
});

describe('reduceVoicePlayback bracketing/reassembly', () => {
  it('reassembles a bracketed reply into one queued utterance', () => {
    const state = drive(supported(), init, audio(CHUNK), audio(CHUNK), end);
    expect(state.bracketOpen).toBe(false);
    expect(state.queue).toHaveLength(1);
    expect(state.queue[0]).toMatchObject({
      id: 'utterance-1',
      chunksBase64: [CHUNK, CHUNK],
      byteLength: 6,
      receivedAt: AT,
    });
    expect(state.droppedFrames).toBe(0);
    expect(state.lastError).toBeNull();
  });

  it('mints monotonic ids across consecutive replies', () => {
    let state = drive(supported(), init, audio(CHUNK), end);
    state = drive(state, init, audio(CHUNK), end);
    expect(state.queue.map((entry) => entry.id)).toEqual(['utterance-1', 'utterance-2']);
  });

  it('tracks an open bracket while audio arrives', () => {
    const state = drive(supported(), init, audio(CHUNK));
    expect(state.bracketOpen).toBe(true);
    expect(state.pending).toEqual([CHUNK]);
    expect(state.queue).toHaveLength(0);
  });
});

describe('reduceVoicePlayback fail-closed rules', () => {
  it('drops audio that arrives outside a bracket', () => {
    const state = drive(supported(), audio(CHUNK));
    expect(state.queue).toHaveLength(0);
    expect(state.bracketOpen).toBe(false);
    expect(state.droppedFrames).toBe(1);
    expect(state.lastError).toMatch(/outside a reply bracket/);
  });

  it('drops an audio-end with no open bracket', () => {
    const state = drive(supported(), end);
    expect(state.queue).toHaveLength(0);
    expect(state.droppedFrames).toBe(1);
    expect(state.lastError).toMatch(/no open reply bracket/);
  });

  it('discards a partial reply when a second audio-init arrives', () => {
    const state = drive(supported(), init, audio(CHUNK), init);
    expect(state.bracketOpen).toBe(true);
    expect(state.pending).toHaveLength(0);
    expect(state.queue).toHaveLength(0);
    expect(state.lastError).toMatch(/still open/);
  });

  it('rejects malformed base64 and discards the reply', () => {
    const state = drive(supported(), init, audio('not base64!!'));
    expect(state.bracketOpen).toBe(false);
    expect(state.queue).toHaveLength(0);
    expect(state.lastError).toMatch(/valid base64/);
  });

  it('closes an empty bracket without queueing an utterance', () => {
    const state = drive(supported(), init, end);
    expect(state.queue).toHaveLength(0);
    expect(state.bracketOpen).toBe(false);
    expect(state.lastError).toMatch(/empty reply/);
  });

  it('aborts a reply that exceeds the chunk ceiling', () => {
    let state = reduceVoicePlayback(supported(), { kind: 'init' }, AT);
    for (let index = 0; index < VOICE_PLAYBACK_LIMITS.maxChunksPerUtterance; index += 1) {
      state = reduceVoicePlayback(state, { kind: 'chunk', base64: CHUNK }, AT);
    }
    expect(state.pending).toHaveLength(VOICE_PLAYBACK_LIMITS.maxChunksPerUtterance);
    state = reduceVoicePlayback(state, { kind: 'chunk', base64: CHUNK }, AT);
    expect(state.bracketOpen).toBe(false);
    expect(state.queue).toHaveLength(0);
    expect(state.lastError).toMatch(/size ceiling/);
  });

  it('never buffers audio when the session lacks the streamed_audio ceiling', () => {
    const state = drive(createVoicePlaybackState(false), init, audio(CHUNK), end);
    expect(state.supported).toBe(false);
    expect(state.queue).toHaveLength(0);
    expect(state.bracketOpen).toBe(false);
    expect(state.droppedFrames).toBe(3);
    expect(state.lastError).toMatch(/without a streamed_audio session ceiling/);
  });

  it('caps the ready queue and drops the oldest undelivered utterance', () => {
    let state = supported();
    const total = VOICE_PLAYBACK_LIMITS.maxQueuedUtterances + 2;
    for (let index = 0; index < total; index += 1) {
      state = drive(state, init, audio(CHUNK), end);
    }
    expect(state.queue).toHaveLength(VOICE_PLAYBACK_LIMITS.maxQueuedUtterances);
    // Oldest ids dropped; newest retained.
    expect(state.queue[0]?.id).toBe('utterance-3');
    expect(state.queue.at(-1)?.id).toBe(`utterance-${total}`);
    expect(state.droppedFrames).toBe(2);
  });
});

describe('queue + reset helpers', () => {
  it('consumes one utterance by id', () => {
    let state = drive(supported(), init, audio(CHUNK), end);
    state = drive(state, init, audio(CHUNK), end);
    const next = consumeUtterance(state, 'utterance-1');
    expect(next.queue.map((entry) => entry.id)).toEqual(['utterance-2']);
    expect(consumeUtterance(next, 'missing')).toBe(next);
  });

  it('reset preserves the support flag but clears buffered audio', () => {
    const state = drive(supported(), init, audio(CHUNK));
    const reset = resetVoicePlayback(state);
    expect(reset.supported).toBe(true);
    expect(reset.bracketOpen).toBe(false);
    expect(reset.pending).toHaveLength(0);
    expect(reset.queue).toHaveLength(0);
  });
});
