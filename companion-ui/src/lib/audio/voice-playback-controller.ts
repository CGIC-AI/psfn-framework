/**
 * Browser voice playback for the companion PWA.
 *
 * The controller drains reassembled utterances (see `frame-reassembly.ts`),
 * decodes each to PCM through an injected clip source, plays them in order, and
 * ticks a precomputed amplitude envelope so the sprite mouth opens on the
 * companion's speech (v1 lipsync — amplitude only). All device coupling lives
 * behind the injected `AudioClipSource`, so the scheduling, sequencing, and
 * mouth logic are unit-testable with fakes.
 *
 * Fail-closed: a decode or playback failure closes the mouth, drops the failed
 * utterance, and continues; it never leaves the mouth stuck open or replays a
 * partial clip.
 */
import {
  buildAmplitudeEnvelope,
  DEFAULT_MOUTH_GATE,
  DEFAULT_NORMALIZE_OPTIONS,
  nextMouthOpen,
  type MouthGateOptions,
  type NormalizeOptions,
} from './amplitude.js';
import { decodeBase64ToBytes } from './base64.js';
import type { CompletedUtterance } from './frame-reassembly.js';

/** Mono PCM decoded from one encoded reply. */
export interface DecodedPcm {
  readonly sampleRate: number;
  readonly samples: Float32Array;
}

/** Handle for one in-flight clip. `finished` resolves at end or on `stop`. */
export interface PlayingClip {
  readonly finished: Promise<void>;
  stop(): void;
}

/** Device boundary: decode encoded audio bytes and play the resulting PCM. */
export interface AudioClipSource {
  decode(bytes: Uint8Array): Promise<DecodedPcm>;
  play(pcm: DecodedPcm): PlayingClip;
}

export interface VoicePlaybackControllerOptions {
  readonly source: AudioClipSource;
  /** Called on every mouth transition and at clip end (closed). */
  readonly onMouthOpen: (open: boolean, envelope: number) => void;
  /** Called when audible playback starts or ends, independent of mouth amplitude. */
  readonly onPlaybackActive?: (active: boolean) => void;
  /** Optional structured error sink for decode/playback anomalies. */
  readonly onError?: (message: string) => void;
  /** Envelope frame size in milliseconds (default 60ms). */
  readonly frameMs?: number;
  readonly gate?: MouthGateOptions;
  readonly normalize?: NormalizeOptions;
  readonly setInterval?: (callback: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

const DEFAULT_FRAME_MS = 60;

export class VoicePlaybackController {
  private readonly source: AudioClipSource;
  private readonly onMouthOpen: (open: boolean, envelope: number) => void;
  private readonly onPlaybackActive?: (active: boolean) => void;
  private readonly onError?: (message: string) => void;
  private readonly frameMs: number;
  private readonly gate: MouthGateOptions;
  private readonly normalize: NormalizeOptions;
  private readonly schedule: (callback: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;

  private chain: Promise<void> = Promise.resolve();
  private current: PlayingClip | null = null;
  private tickHandle: unknown = null;
  private mouthOpen = false;
  private playbackActive = false;
  private generation = 0;
  private disposed = false;

  constructor(options: VoicePlaybackControllerOptions) {
    this.source = options.source;
    this.onMouthOpen = options.onMouthOpen;
    this.onPlaybackActive = options.onPlaybackActive;
    this.onError = options.onError;
    this.frameMs = options.frameMs && options.frameMs > 0 ? options.frameMs : DEFAULT_FRAME_MS;
    this.gate = options.gate ?? DEFAULT_MOUTH_GATE;
    this.normalize = options.normalize ?? DEFAULT_NORMALIZE_OPTIONS;
    this.schedule = options.setInterval
      ?? ((callback, ms) => globalThis.setInterval(callback, ms));
    this.cancel = options.clearInterval
      ?? ((handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>));
  }

  /** Queue one reassembled utterance for sequential playback. */
  enqueue(utterance: CompletedUtterance): void {
    if (this.disposed) return;
    const generation = this.generation;
    this.chain = this.chain.then(() => this.playOne(utterance, generation));
  }

  /** Barge-in: stop the current clip, drop the queue, and close the mouth. */
  stop(): void {
    this.generation += 1;
    this.stopCurrent();
    this.chain = Promise.resolve();
    this.setMouth(false, 0);
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
  }

  private async playOne(utterance: CompletedUtterance, generation: number): Promise<void> {
    if (this.disposed || generation !== this.generation) return;
    let pcm: DecodedPcm;
    try {
      pcm = await this.source.decode(this.concatBytes(utterance));
    } catch (error) {
      this.reportError(error, 'decode');
      return;
    }
    if (this.disposed || generation !== this.generation) return;

    const envelope = buildAmplitudeEnvelope(pcm.samples, pcm.sampleRate, this.frameMs, this.normalize);
    let clip: PlayingClip;
    try {
      clip = this.source.play(pcm);
    } catch (error) {
      this.reportError(error, 'play');
      return;
    }
    this.current = clip;
    this.setPlaybackActive(true);
    this.startTicking(envelope, generation);
    try {
      await clip.finished;
    } catch (error) {
      this.reportError(error, 'play');
    } finally {
      if (this.current === clip) {
        this.current = null;
        this.setPlaybackActive(false);
      }
      this.stopTicking();
      if (generation === this.generation) this.setMouth(false, 0);
    }
  }

  private concatBytes(utterance: CompletedUtterance): Uint8Array {
    const decoded = utterance.chunksBase64.map((chunk) => decodeBase64ToBytes(chunk));
    const total = decoded.reduce((sum, part) => sum + part.length, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of decoded) {
      bytes.set(part, offset);
      offset += part.length;
    }
    return bytes;
  }

  private startTicking(envelope: number[], generation: number): void {
    this.stopTicking();
    if (envelope.length === 0) return;
    let index = 0;
    this.tickHandle = this.schedule(() => {
      if (generation !== this.generation) {
        this.stopTicking();
        return;
      }
      const value = index < envelope.length ? envelope[index] ?? 0 : 0;
      index += 1;
      this.setMouth(nextMouthOpen(this.mouthOpen, value, this.gate), value);
      if (index >= envelope.length) this.stopTicking();
    }, this.frameMs);
  }

  private stopTicking(): void {
    if (this.tickHandle !== null) {
      this.cancel(this.tickHandle);
      this.tickHandle = null;
    }
  }

  private stopCurrent(): void {
    this.stopTicking();
    const clip = this.current;
    this.current = null;
    this.setPlaybackActive(false);
    if (clip) {
      try {
        clip.stop();
      } catch (error) {
        this.reportError(error, 'play');
      }
    }
  }

  private setMouth(open: boolean, envelope: number): void {
    // Emit on every transition; emit the closing edge unconditionally so the
    // sprite never latches open after a clip ends.
    if (open === this.mouthOpen && !(open === false && envelope === 0)) return;
    this.mouthOpen = open;
    this.onMouthOpen(open, envelope);
  }

  private setPlaybackActive(active: boolean): void {
    if (active === this.playbackActive) return;
    this.playbackActive = active;
    this.onPlaybackActive?.(active);
  }

  private reportError(error: unknown, phase: 'decode' | 'play'): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.onError?.(`Voice ${phase} failed: ${detail}`);
  }
}

/**
 * Default browser clip source backed by Web Audio. `decodeAudioData` handles
 * the encoded reply body (e.g. mp3); the first channel is used as the mono
 * lipsync signal. The `AudioContext` is injected so tests never touch the DOM.
 */
export function createWebAudioClipSource(context: AudioContextLike): AudioClipSource {
  return {
    async decode(bytes) {
      // decodeAudioData consumes the ArrayBuffer, so hand it a fresh copy.
      const copy = bytes.slice();
      const buffer = await context.decodeAudioData(copy.buffer);
      return { sampleRate: buffer.sampleRate, samples: buffer.getChannelData(0) };
    },
    play(pcm) {
      const buffer = context.createBuffer(1, pcm.samples.length, pcm.sampleRate);
      buffer.copyToChannel(pcm.samples, 0);
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(context.destination);
      let stopped = false;
      const finished = new Promise<void>((resolve) => {
        node.onended = () => resolve();
      });
      node.start();
      return {
        finished,
        stop() {
          if (stopped) return;
          stopped = true;
          try {
            node.stop();
          } catch {
            // A node that already ended throws on stop(); the clip is done.
          }
        },
      };
    },
  };
}

/** Minimal Web Audio surface the default clip source needs. */
export interface AudioContextLike {
  readonly destination: AudioNodeLike;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioBufferSourceLike;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): void;
}

export interface AudioBufferLike {
  readonly sampleRate: number;
  readonly length: number;
  getChannelData(channel: number): Float32Array;
  copyToChannel(source: Float32Array, channel: number): void;
}

export interface AudioBufferSourceLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  onended: (() => void) | null;
  start(): void;
  stop(): void;
}
