import { describe, expect, it, vi } from 'vitest';
import { EchoStreamingTtsConnector } from './echo-stream.js';

async function collectAsync<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

function createReadableStream(chunks: Uint8Array[], close = true): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }

      if (close) {
        controller.close();
      }
    },
  });
}

describe('EchoStreamingTtsConnector', () => {
  it('streams audio chunks from /v1/audio/speech with Echo request mapping', async () => {
    const mockFetch = vi.fn(async () => {
      return {
        ok: true,
        body: createReadableStream([
          new Uint8Array([1, 2]),
          new Uint8Array([3, 4]),
          new Uint8Array([5]),
        ]),
      } as unknown as Response;
    });

    const connector = new EchoStreamingTtsConnector({
      voice: '11labs-Allison',
      preset: 'Independent-High-Speaker-CFG',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const session = await connector.synthesizeStream({ text: 'hello world', encoding: 'mp3' });
    const chunks = await collectAsync(session.audio);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toBe('http://220.158.196.150:8001/v1/audio/speech');

    const options = mockFetch.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(options.body));
    expect(payload).toEqual({
      input: 'hello world',
      voice: '11labs-Allison',
      response_format: 'mp3',
      stream: true,
      extra_body: {
        preset: 'Independent-High-Speaker-CFG',
      },
    });

    expect(chunks).toEqual([
      {
        audio: new Uint8Array([1, 2]),
        sequence: 0,
        isFinal: false,
        encoding: 'mp3',
        source: 'stream',
      },
      {
        audio: new Uint8Array([3, 4]),
        sequence: 1,
        isFinal: false,
        encoding: 'mp3',
        source: 'stream',
      },
      {
        audio: new Uint8Array([5]),
        sequence: 2,
        isFinal: true,
        encoding: 'mp3',
        source: 'stream',
      },
    ]);
  });

  it('returns a full buffer from synthesizeBuffer', async () => {
    const bufferedAudio = Buffer.from([8, 9, 10]);
    const audioBuffer = bufferedAudio.buffer.slice(
      bufferedAudio.byteOffset,
      bufferedAudio.byteOffset + bufferedAudio.byteLength,
    );

    const mockFetch = vi.fn(async () => {
      return {
        ok: true,
        arrayBuffer: async () => audioBuffer,
      } as unknown as Response;
    });

    const connector = new EchoStreamingTtsConnector({
      baseUrl: 'http://localhost:18001/',
      voice: 'default-voice',
      preset: 'Independent-High-Speaker-CFG',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const audio = await connector.synthesizeBuffer({
      text: 'buffer me',
      encoding: 'opus',
      voiceId: 'override-voice',
    });

    expect(audio).toEqual(bufferedAudio);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toBe('http://localhost:18001/v1/audio/speech');

    const options = mockFetch.mock.calls[0][1] as RequestInit;
    const payload = JSON.parse(String(options.body));
    expect(payload).toEqual({
      input: 'buffer me',
      voice: 'override-voice',
      response_format: 'opus',
      stream: false,
      extra_body: {
        preset: 'Independent-High-Speaker-CFG',
      },
    });
  });

  it('returns deterministic HTTP errors for synthesizeBuffer', async () => {
    const mockFetch = vi.fn(async () => {
      return {
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        text: async () => 'upstream unavailable',
      } as unknown as Response;
    });

    const connector = new EchoStreamingTtsConnector({
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    await expect(connector.synthesizeBuffer({ text: 'failing request', encoding: 'mp3' }))
      .rejects
      .toThrow('Echo buffered TTS failed: 502 Bad Gateway upstream unavailable');
  });

  it('returns deterministic HTTP errors for synthesizeStream', async () => {
    const mockFetch = vi.fn(async () => {
      return {
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: async () => 'stream unavailable',
      } as unknown as Response;
    });

    const connector = new EchoStreamingTtsConnector({
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    await expect(connector.synthesizeStream({ text: 'failing stream', encoding: 'mp3' }))
      .rejects
      .toThrow('Echo streaming TTS failed: 503 Service Unavailable stream unavailable');
  });

  it('supports cancellation for active streaming sessions', async () => {
    const mockFetch = vi.fn(async () => {
      return {
        ok: true,
        body: createReadableStream([
          new Uint8Array([1]),
          new Uint8Array([2]),
        ], false),
      } as unknown as Response;
    });

    const connector = new EchoStreamingTtsConnector({
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const session = await connector.synthesizeStream({ text: 'cancel me', encoding: 'mp3' });
    const iterator = session.audio[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({
      done: false,
      value: {
        audio: new Uint8Array([1]),
        sequence: 0,
        isFinal: false,
        encoding: 'mp3',
        source: 'stream',
      },
    });

    await session.cancel('test cancel');

    await expect(iterator.next()).rejects.toMatchObject({
      name: 'AbortError',
      message: 'Echo streaming TTS aborted',
    });
  });
});
