import { describe, expect, it, vi } from 'vitest';
import type { CompletedUtterance } from './frame-reassembly.js';
import {
  VoicePlaybackController,
  type AudioClipSource,
  type DecodedPcm,
  type PlayingClip,
} from './voice-playback-controller.js';

const AT = '2026-07-22T00:00:00.000Z';

function utterance(id: string): CompletedUtterance {
  // 'AAAA' is valid base64 (3 bytes); the fake source ignores the bytes.
  return { id, chunksBase64: ['AAAA', 'AAAA'], byteLength: 6, receivedAt: AT };
}

function loudPcm(): DecodedPcm {
  return { sampleRate: 48_000, samples: new Float32Array(9_600).fill(0.8) };
}

interface Harness {
  controller: VoicePlaybackController;
  decode: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
  mouth: Array<{ open: boolean; envelope: number }>;
  errors: string[];
  tick: () => void;
  finishCurrent: () => void;
  stopSpy: ReturnType<typeof vi.fn>;
}

function harness(pcm: DecodedPcm = loudPcm(), decodeError?: Error): Harness {
  let intervalCb: (() => void) | null = null;
  let resolveFinished: (() => void) | null = null;
  const stopSpy = vi.fn();
  const mouth: Array<{ open: boolean; envelope: number }> = [];
  const errors: string[] = [];

  const decode = vi.fn(async (): Promise<DecodedPcm> => {
    if (decodeError) throw decodeError;
    return pcm;
  });
  const play = vi.fn((): PlayingClip => {
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    return { finished, stop: stopSpy };
  });
  const source: AudioClipSource = { decode, play };

  const controller = new VoicePlaybackController({
    source,
    onMouthOpen: (open, envelope) => mouth.push({ open, envelope }),
    onError: (message) => errors.push(message),
    frameMs: 60,
    setInterval: (cb) => {
      intervalCb = cb;
      return 1;
    },
    clearInterval: () => {
      intervalCb = null;
    },
  });

  return {
    controller,
    decode,
    play,
    mouth,
    errors,
    stopSpy,
    tick: () => intervalCb?.(),
    finishCurrent: () => resolveFinished?.(),
  };
}

describe('VoicePlaybackController', () => {
  it('decodes, plays, and opens the mouth on a loud reply', async () => {
    const h = harness();
    h.controller.enqueue(utterance('utterance-1'));

    await vi.waitFor(() => expect(h.play).toHaveBeenCalledTimes(1));
    expect(h.decode).toHaveBeenCalledTimes(1);

    h.tick();
    expect(h.mouth.at(-1)).toEqual({ open: true, envelope: 1 });

    h.finishCurrent();
    await vi.waitFor(() => expect(h.mouth.at(-1)?.open).toBe(false));
  });

  it('plays queued utterances sequentially', async () => {
    const h = harness();
    h.controller.enqueue(utterance('utterance-1'));
    h.controller.enqueue(utterance('utterance-2'));

    await vi.waitFor(() => expect(h.play).toHaveBeenCalledTimes(1));
    h.finishCurrent();
    await vi.waitFor(() => expect(h.play).toHaveBeenCalledTimes(2));
  });

  it('stops the current clip and closes the mouth on barge-in', async () => {
    const h = harness();
    h.controller.enqueue(utterance('utterance-1'));
    await vi.waitFor(() => expect(h.play).toHaveBeenCalledTimes(1));
    h.tick();
    expect(h.mouth.at(-1)?.open).toBe(true);

    h.controller.stop();
    expect(h.stopSpy).toHaveBeenCalledTimes(1);
    expect(h.mouth.at(-1)?.open).toBe(false);
  });

  it('reports a decode failure and never plays or opens the mouth', async () => {
    const h = harness(loudPcm(), new Error('bad mp3'));
    h.controller.enqueue(utterance('utterance-1'));

    await vi.waitFor(() => expect(h.errors).toHaveLength(1));
    expect(h.errors[0]).toMatch(/Voice decode failed: bad mp3/);
    expect(h.play).not.toHaveBeenCalled();
    expect(h.mouth.every((entry) => entry.open === false)).toBe(true);
  });
});
