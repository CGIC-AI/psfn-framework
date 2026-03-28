import { describe, expect, it, vi } from 'vitest';
import type { SttTranscriptChunk } from '../../../../src/voice/connectors/stt/types.js';
import type { WyomingFrame, WyomingTransportSession } from '../../protocol/index.js';
import { createWyomingAsrServiceAdapter } from './asr.js';

class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        if (this.values.length > 0) {
          return { value: this.values.shift() as T, done: false };
        }
        if (this.closed) {
          return { value: undefined, done: true };
        }
        return await new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

function createTransportSession(connectionId: string): WyomingTransportSession {
  return {
    id: connectionId,
    connectionId,
    openedAtMs: 1,
    lastSeenAtMs: 1,
  };
}

describe('Wyoming ASR service adapter', () => {
  it('bridges transcribe/audio events into streaming STT sessions', async () => {
    const transcripts = new AsyncQueue<SttTranscriptChunk>();
    const writeAudio = vi.fn(async () => {});
    const endInput = vi.fn(async () => {
      transcripts.push({
        type: 'final',
        text: 'hello world',
        confidence: 0.9,
      });
      transcripts.close();
    });
    const cancel = vi.fn(async () => {
      transcripts.close();
    });
    const startStream = vi.fn(async () => ({
      transcripts,
      writeAudio,
      endInput,
      cancel,
    }));

    const adapter = createWyomingAsrServiceAdapter({
      stt: {
        id: 'stt-test',
        startStream,
      },
    });
    const transportSession = createTransportSession('conn-asr-1');

    await adapter.handle({
      transportSession,
      sessionId: 'session-a',
      frame: {
        type: 'transcribe',
        data: {
          session_id: 'session-a',
          lang: 'en-US',
          name: 'asr-model',
          rate: 16_000,
          channels: 1,
          format: 'pcm_s16le',
        },
      },
    });

    expect(startStream).toHaveBeenCalledWith(expect.objectContaining({
      language: 'en-US',
      model: 'asr-model',
      sampleRateHz: 16_000,
      channels: 1,
      encoding: 'pcm_s16le',
    }));

    await adapter.handle({
      transportSession,
      sessionId: 'session-a',
      frame: {
        type: 'audio.chunk',
        data: {
          session_id: 'session-a',
        },
        payload: new Uint8Array([1, 2, 3]),
      },
    });
    expect(writeAudio).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));

    const stopResult = await adapter.handle({
      transportSession,
      sessionId: 'session-a',
      frame: {
        type: 'audio-stop',
        data: {
          session_id: 'session-a',
        },
      },
    }) as WyomingFrame[];

    expect(stopResult).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'transcript',
        data: expect.objectContaining({
          text: 'hello world',
          is_final: true,
        }),
      }),
    ]));
  });

  it('auto-starts compatibility sessions on audio chunks and validates payloads', async () => {
    const transcripts = new AsyncQueue<SttTranscriptChunk>();
    const writeAudio = vi.fn(async () => {});
    const startStream = vi.fn(async () => ({
      transcripts,
      writeAudio,
      endInput: vi.fn(async () => {}),
      cancel: vi.fn(async () => {
        transcripts.close();
      }),
    }));

    const adapter = createWyomingAsrServiceAdapter({
      stt: {
        id: 'stt-test',
        startStream,
      },
    });
    const transportSession = createTransportSession('conn-asr-2');

    await adapter.handle({
      transportSession,
      sessionId: 'session-b',
      frame: {
        type: 'audio-chunk',
        data: {
          session_id: 'session-b',
        },
        payload: new Uint8Array([9, 9]),
      },
    });

    expect(startStream).toHaveBeenCalledTimes(1);
    expect(writeAudio).toHaveBeenCalledTimes(1);

    const invalid = await adapter.handle({
      transportSession,
      sessionId: 'session-b',
      frame: {
        type: 'audio-chunk',
        data: {
          session_id: 'session-b',
          audio: '!!!bad-base64!!!',
        },
      },
    }) as WyomingFrame;

    expect(invalid).toEqual(expect.objectContaining({
      type: 'error',
      data: expect.objectContaining({
        code: 'invalid_request',
        service: 'asr',
      }),
    }));
  });
});
