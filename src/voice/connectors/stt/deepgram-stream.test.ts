import { describe, expect, it } from 'vitest';
import { DeepgramStreamingSttConnector, type WebSocketLike } from './deepgram-stream.js';

class FakeWebSocket implements WebSocketLike {
  readyState = 0;
  sent: Array<string | ArrayBuffer | ArrayBufferView> = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: unknown) => void): void {
    const entries = this.listeners.get(type) ?? [];
    entries.push(listener);
    this.listeners.set(type, entries);
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }

  emit(type: 'open' | 'message' | 'error' | 'close', event: unknown = {}): void {
    const entries = this.listeners.get(type) ?? [];
    for (const listener of entries) {
      listener(event);
    }
  }
}

async function collectAsync<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

describe('DeepgramStreamingSttConnector', () => {
  it('maps partial/final transcript chunks with confidence and timestamps', async () => {
    const socket = new FakeWebSocket();
    let openedUrl = '';
    let openedProtocols: string[] = [];

    const connector = new DeepgramStreamingSttConnector({
      apiKey: 'test-key',
      model: 'nova-3',
      webSocketFactory: (url, protocols) => {
        openedUrl = url;
        openedProtocols = protocols;
        queueMicrotask(() => {
          socket.readyState = 1;
          socket.emit('open');
        });
        return socket;
      },
      openTimeoutMs: 500,
      finalizeTimeoutMs: 50,
    });

    const session = await connector.startStream({
      sampleRateHz: 48_000,
      channels: 2,
      encoding: 'pcm_s16le',
      interimResults: true,
    });

    const transcriptPromise = collectAsync(session.transcripts);

    await session.writeAudio(new Uint8Array([1, 2, 3]));

    socket.emit('message', {
      data: JSON.stringify({
        type: 'Results',
        is_final: false,
        start: 0.25,
        duration: 0.5,
        channel: {
          alternatives: [
            {
              transcript: 'hello',
              confidence: 0.81,
            },
          ],
        },
      }),
    });

    socket.emit('message', {
      data: JSON.stringify({
        type: 'Results',
        is_final: true,
        speech_final: true,
        channel: {
          alternatives: [
            {
              transcript: 'hello world',
              confidence: 0.93,
              words: [
                { start: 0.25, end: 0.55 },
                { start: 0.56, end: 0.98 },
              ],
            },
          ],
        },
      }),
    });

    await session.endInput();
    socket.close(1000, 'done');

    const transcriptChunks = await transcriptPromise;

    expect(openedUrl).toContain('model=nova-3');
    expect(openedUrl).toContain('interim_results=true');
    expect(openedProtocols).toEqual(['token', 'test-key']);

    expect(transcriptChunks).toEqual([
      {
        type: 'partial',
        text: 'hello',
        confidence: 0.81,
        startMs: 250,
        endMs: 750,
      },
      {
        type: 'final',
        text: 'hello world',
        confidence: 0.93,
        startMs: 250,
        endMs: 980,
      },
    ]);

    expect(socket.sent[0]).toEqual(new Uint8Array([1, 2, 3]));
    expect(socket.sent.some((entry) => typeof entry === 'string' && entry.includes('Finalize'))).toBe(true);
  });

  it('fails the transcript stream when socket closes unexpectedly', async () => {
    const socket = new FakeWebSocket();

    const connector = new DeepgramStreamingSttConnector({
      apiKey: 'test-key',
      webSocketFactory: () => {
        queueMicrotask(() => {
          socket.readyState = 1;
          socket.emit('open');
        });
        return socket;
      },
      openTimeoutMs: 500,
    });

    const session = await connector.startStream({
      sampleRateHz: 48_000,
      channels: 1,
      encoding: 'pcm_s16le',
    });

    const iterator = session.transcripts[Symbol.asyncIterator]();
    socket.close(1011, 'upstream-error');

    await expect(iterator.next()).rejects.toThrow('unexpectedly');
  });
});
