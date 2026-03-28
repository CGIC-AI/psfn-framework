import { describe, expect, it, vi } from 'vitest';
import type { TtsAudioChunk } from '../../../../src/primitives/voice/connectors/tts/types.js';
import type { WyomingFrame, WyomingTransportSession } from '../../protocol/index.js';
import { createWyomingTtsServiceAdapter } from './tts.js';

function createTransportSession(connectionId: string): WyomingTransportSession {
  return {
    id: connectionId,
    connectionId,
    openedAtMs: 1,
    lastSeenAtMs: 1,
  };
}

function createAudioStream(chunks: TtsAudioChunk[]): AsyncIterable<TtsAudioChunk> {
  return (async function* stream(): AsyncGenerator<TtsAudioChunk> {
    for (const chunk of chunks) {
      yield chunk;
    }
  })();
}

describe('Wyoming TTS service adapter', () => {
  it('maps synthesize requests into streaming TTS and emits audio frames', async () => {
    const synthesizeStream = vi.fn(async () => ({
      audio: createAudioStream([
        {
          audio: new Uint8Array([1, 2]),
          sequence: 0,
          isFinal: false,
          encoding: 'pcm_s16le',
          source: 'stream',
        },
        {
          audio: new Uint8Array([3, 4]),
          sequence: 1,
          isFinal: true,
          encoding: 'pcm_s16le',
          source: 'stream',
        },
      ]),
      cancel: vi.fn(async () => {}),
    }));

    const adapter = createWyomingTtsServiceAdapter({
      tts: {
        id: 'tts-test',
        synthesizeStream,
        synthesizeBuffer: vi.fn(),
      },
    });

    const result = await adapter.handle({
      transportSession: createTransportSession('conn-tts-1'),
      sessionId: 'session-a',
      frame: {
        type: 'synthesize',
        data: {
          session_id: 'session-a',
          text: 'hello',
          voice: 'voice-a',
          lang: 'en-US',
          name: 'model-a',
          format: 'pcm_s16le',
          rate: 16_000,
          channels: 1,
        },
      },
    }) as WyomingFrame[];

    expect(synthesizeStream).toHaveBeenCalledWith(expect.objectContaining({
      text: 'hello',
      voiceId: 'voice-a',
      encoding: 'pcm_s16le',
      sampleRateHz: 16_000,
    }));
    expect(result[0]).toEqual(expect.objectContaining({
      type: 'audio-start',
      data: expect.objectContaining({
        session_id: 'session-a',
        rate: 16_000,
        channels: 1,
        language: 'en-US',
        model: 'model-a',
      }),
    }));
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'audio-chunk',
        payload: new Uint8Array([1, 2]),
      }),
      expect.objectContaining({
        type: 'audio-stop',
      }),
      expect.objectContaining({
        type: 'synthesize-stopped',
      }),
    ]));
  });

  it('supports synthesize-start/chunk/stop compatibility flow', async () => {
    const synthesizeStream = vi.fn(async () => ({
      audio: createAudioStream([
        {
          audio: new Uint8Array([9, 9, 9]),
          sequence: 0,
          isFinal: true,
          encoding: 'mp3',
          source: 'stream',
        },
      ]),
      cancel: vi.fn(async () => {}),
    }));

    const adapter = createWyomingTtsServiceAdapter({
      tts: {
        id: 'tts-test',
        synthesizeStream,
        synthesizeBuffer: vi.fn(),
      },
      defaultRequest: {
        encoding: 'mp3',
      },
    });
    const transportSession = createTransportSession('conn-tts-2');

    await adapter.handle({
      transportSession,
      sessionId: 'session-b',
      frame: {
        type: 'synthesize-start',
        data: {
          session_id: 'session-b',
        },
      },
    });
    await adapter.handle({
      transportSession,
      sessionId: 'session-b',
      frame: {
        type: 'synthesize-chunk',
        data: {
          session_id: 'session-b',
          text: 'he',
        },
      },
    });
    await adapter.handle({
      transportSession,
      sessionId: 'session-b',
      frame: {
        type: 'synthesize-chunk',
        data: {
          session_id: 'session-b',
          text: 'llo',
        },
      },
    });

    const result = await adapter.handle({
      transportSession,
      sessionId: 'session-b',
      frame: {
        type: 'synthesize-stop',
        data: {
          session_id: 'session-b',
        },
      },
    }) as WyomingFrame[];

    expect(synthesizeStream).toHaveBeenCalledWith(expect.objectContaining({
      text: 'hello',
      encoding: 'mp3',
    }));
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'audio-start' }),
      expect.objectContaining({ type: 'audio-chunk' }),
      expect.objectContaining({ type: 'audio-stop' }),
    ]));
  });
});
