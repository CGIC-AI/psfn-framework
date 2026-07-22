/**
 * Browser audio playback contract — inbound frame bracketing / reassembly.
 *
 * The hub streams a spoken reply as an ordered burst of plain-WebSocket text
 * frames on the retained hub message union (mirrored in
 * `src/lib/protocol/events.ts`): a `text` signal `audio-init` opens the reply,
 * one or more base64 `audio` frames carry the encoded audio body, and a `text`
 * signal `audio-end` closes it. This module is the pure, transport-agnostic
 * reassembler that turns that frame stream into whole utterances a Web Audio
 * player can decode.
 *
 * It holds NO device state and performs NO decoding — the reducer keeps the
 * raw base64 chunks (state stays JSON-serializable) and the playback controller
 * concatenates + decodes them at the sink. Every rule fails closed: audio that
 * arrives outside a bracket, a second `audio-init` over an open bracket, an
 * `audio-end` with nothing open, malformed base64, or a reply that blows the
 * size ceiling is rejected and recorded — never silently coerced into the
 * playable queue.
 */
import { base64ByteLength, isBase64 } from './base64.js';
import type { HubToClientMessage } from '../protocol/events.js';

/** Text-signal payloads that bracket a streamed audio reply. */
export const AUDIO_INIT_SIGNAL = 'audio-init';
export const AUDIO_END_SIGNAL = 'audio-end';

/** Fail-closed ceilings for one bracketed reply and the ready queue. */
export const VOICE_PLAYBACK_LIMITS = Object.freeze({
  /** Maximum decoded-equivalent bytes buffered for a single reply (8 MiB). */
  maxUtteranceBytes: 8 * 1024 * 1024,
  /** Maximum audio frames accepted inside one reply bracket. */
  maxChunksPerUtterance: 4096,
  /** Ready utterances retained before the oldest undelivered one is dropped. */
  maxQueuedUtterances: 8,
});

/** A fully bracketed, ready-to-decode audio reply. */
export interface CompletedUtterance {
  readonly id: string;
  /** Ordered base64 audio frames as received; the sink concatenates + decodes. */
  readonly chunksBase64: readonly string[];
  /** Total decoded-equivalent byte length across the chunks. */
  readonly byteLength: number;
  readonly receivedAt: string;
}

/** Serializable playback state carried inside the hub stream store. */
export interface VoicePlaybackState {
  /** True only when the session advertises the `streamed_audio` output ceiling. */
  readonly supported: boolean;
  /** True between a valid `audio-init` and its `audio-end`. */
  readonly bracketOpen: boolean;
  /** Base64 audio frames buffered for the currently open reply. */
  readonly pending: readonly string[];
  /** Decoded-equivalent bytes buffered for the currently open reply. */
  readonly pendingBytes: number;
  /** Ready utterances awaiting the playback sink, oldest first. */
  readonly queue: readonly CompletedUtterance[];
  /** Monotonic counter used to mint stable utterance ids. */
  readonly completedCount: number;
  /** Count of frames rejected fail-closed (anomaly telemetry, not fatal). */
  readonly droppedFrames: number;
  /** Most recent reassembly anomaly, surfaced for diagnostics. */
  readonly lastError: string | null;
}

export type PlaybackSignal =
  | { readonly kind: 'init' }
  | { readonly kind: 'chunk'; readonly base64: string }
  | { readonly kind: 'end' };

export function createVoicePlaybackState(supported = false): VoicePlaybackState {
  return {
    supported,
    bracketOpen: false,
    pending: [],
    pendingBytes: 0,
    queue: [],
    completedCount: 0,
    droppedFrames: 0,
    lastError: null,
  };
}

/**
 * Classify an inbound hub->client message as a playback signal, or `null` when
 * it is not part of the audio contract. Only the exact `audio-init` /
 * `audio-end` text signals bracket a reply; every other `text` payload is a
 * caption/status signal and is left untouched.
 */
export function classifyPlaybackSignal(message: HubToClientMessage): PlaybackSignal | null {
  if (message.type === 'audio') return { kind: 'chunk', base64: message.data };
  if (message.type === 'text') {
    if (message.data === AUDIO_INIT_SIGNAL) return { kind: 'init' };
    if (message.data === AUDIO_END_SIGNAL) return { kind: 'end' };
  }
  return null;
}

function reject(state: VoicePlaybackState, error: string): VoicePlaybackState {
  return { ...state, droppedFrames: state.droppedFrames + 1, lastError: error };
}

function discardBracket(state: VoicePlaybackState, error: string): VoicePlaybackState {
  return {
    ...state,
    bracketOpen: false,
    pending: [],
    pendingBytes: 0,
    droppedFrames: state.droppedFrames + Math.max(1, state.pending.length),
    lastError: error,
  };
}

/**
 * Advance the reassembler by one playback signal. Pure and total: it never
 * throws, and any protocol violation resets fail-closed with `lastError` set
 * rather than admitting a partial or unbounded reply into the queue.
 */
export function reduceVoicePlayback(
  state: VoicePlaybackState,
  signal: PlaybackSignal,
  at: string,
): VoicePlaybackState {
  if (!state.supported) {
    // Fail closed: a session without the streamed_audio ceiling must never
    // buffer audio. Receiving any is an anomaly — drop and record it.
    return reject(state, 'Audio frame arrived without a streamed_audio session ceiling');
  }

  switch (signal.kind) {
    case 'init': {
      const base = state.bracketOpen
        ? discardBracket(state, 'audio-init arrived while a reply was still open')
        : state;
      return { ...base, bracketOpen: true, pending: [], pendingBytes: 0 };
    }
    case 'chunk': {
      if (!state.bracketOpen) {
        return reject(state, 'audio chunk arrived outside a reply bracket');
      }
      if (!isBase64(signal.base64)) {
        return discardBracket(state, 'audio chunk was not valid base64');
      }
      const chunkBytes = base64ByteLength(signal.base64);
      if (state.pending.length + 1 > VOICE_PLAYBACK_LIMITS.maxChunksPerUtterance
        || state.pendingBytes + chunkBytes > VOICE_PLAYBACK_LIMITS.maxUtteranceBytes) {
        return discardBracket(state, 'reply exceeded the playback size ceiling');
      }
      return {
        ...state,
        pending: [...state.pending, signal.base64],
        pendingBytes: state.pendingBytes + chunkBytes,
      };
    }
    case 'end': {
      if (!state.bracketOpen) {
        return reject(state, 'audio-end arrived with no open reply bracket');
      }
      if (state.pending.length === 0) {
        // A well-formed but empty reply: close the bracket, enqueue nothing.
        return {
          ...state,
          bracketOpen: false,
          pending: [],
          pendingBytes: 0,
          lastError: 'audio-end closed an empty reply bracket',
        };
      }
      const completedCount = state.completedCount + 1;
      const utterance: CompletedUtterance = {
        id: `utterance-${completedCount}`,
        chunksBase64: state.pending,
        byteLength: state.pendingBytes,
        receivedAt: at,
      };
      const queue = [...state.queue, utterance];
      const overflow = queue.length - VOICE_PLAYBACK_LIMITS.maxQueuedUtterances;
      return {
        ...state,
        bracketOpen: false,
        pending: [],
        pendingBytes: 0,
        completedCount,
        queue: overflow > 0 ? queue.slice(overflow) : queue,
        droppedFrames: overflow > 0 ? state.droppedFrames + overflow : state.droppedFrames,
        lastError: null,
      };
    }
  }
}

/** Remove one delivered utterance from the ready queue by id. */
export function consumeUtterance(state: VoicePlaybackState, id: string): VoicePlaybackState {
  const queue = state.queue.filter((entry) => entry.id !== id);
  return queue.length === state.queue.length ? state : { ...state, queue };
}

/** Reset audio buffering while preserving the negotiated support flag. */
export function resetVoicePlayback(state: VoicePlaybackState): VoicePlaybackState {
  return createVoicePlaybackState(state.supported);
}

export function cloneVoicePlaybackState(state: VoicePlaybackState): VoicePlaybackState {
  return {
    ...state,
    pending: [...state.pending],
    queue: state.queue.map((entry) => ({ ...entry, chunksBase64: [...entry.chunksBase64] })),
  };
}
