import { describe, expect, it, vi } from 'vitest';
import { ElevenLabsStreamingTtsConnector } from './elevenlabs-stream.js';

async function collectAsync<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

function createReadableStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

describe('ElevenLabsStreamingTtsConnector', () => {
  it('streams audio chunks from the /stream endpoint', async () => {
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

    const connector = new ElevenLabsStreamingTtsConnector({
      apiKey: 'test-key',
      voiceId: 'voice-1',
      modelId: 'eleven_turbo_v2_5',
      endpointBase: 'https://api.elevenlabs.io/v1',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const session = await connector.synthesizeStream({ text: 'hello world', encoding: 'mp3' });
    const chunks = await collectAsync(session.audio);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(String(mockFetch.mock.calls[0][0])).toContain('/text-to-speech/voice-1/stream');
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

  it('falls back to buffered synthesis when stream endpoint fails', async () => {
    const bufferedAudio = Buffer.from([8, 9, 10]);
    const audioBuffer = bufferedAudio.buffer.slice(
      bufferedAudio.byteOffset,
      bufferedAudio.byteOffset + bufferedAudio.byteLength,
    );

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: async () => 'unavailable',
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => audioBuffer,
      } as unknown as Response);

    const connector = new ElevenLabsStreamingTtsConnector({
      apiKey: 'test-key',
      voiceId: 'voice-2',
      modelId: 'eleven_turbo_v2_5',
      endpointBase: 'https://api.elevenlabs.io/v1',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    const session = await connector.synthesizeStream({ text: 'fallback me', encoding: 'mp3' });
    const chunks = await collectAsync(session.audio);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(String(mockFetch.mock.calls[0][0])).toContain('/text-to-speech/voice-2/stream');
    expect(String(mockFetch.mock.calls[1][0])).toContain('/text-to-speech/voice-2');

    expect(chunks).toEqual([
      {
        audio: bufferedAudio,
        sequence: 0,
        isFinal: true,
        encoding: 'mp3',
        source: 'buffer-fallback',
      },
    ]);
  });
});
