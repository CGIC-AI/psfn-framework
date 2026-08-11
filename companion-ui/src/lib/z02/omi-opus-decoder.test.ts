import { describe, expect, it, vi } from 'vitest';
import {
  WebCodecsOmiOpusDecoder,
  type OmiWebCodecs,
  type OmiWebCodecsAudioData,
  type OmiWebCodecsDecoder,
} from './omi-opus-decoder.js';

describe('WebCodecs Omi Opus decoder', () => {
  it('decodes each 20 ms Opus frame to 16 kHz mono PCM16', async () => {
    const pcm = vi.fn();
    const closed = vi.fn();
    const harness = createWebCodecsHarness(Uint8Array.of(0x00, 0x01, 0xfe, 0xff), closed);
    const decoder = new WebCodecsOmiOpusDecoder({ pcm, error: vi.fn() }, harness.codecs);

    decoder.decode(Uint8Array.of(0xaa, 0xbb));
    decoder.decode(Uint8Array.of(0xcc));
    await flushPromises();

    expect(harness.configures).toEqual([{
      codec: 'opus',
      numberOfChannels: 1,
      sampleRate: 16_000,
    }]);
    expect(harness.chunks).toEqual([
      { data: Uint8Array.of(0xaa, 0xbb), duration: 20_000, timestamp: 0, type: 'key' },
      { data: Uint8Array.of(0xcc), duration: 20_000, timestamp: 20_000, type: 'key' },
    ]);
    expect(pcm).toHaveBeenNthCalledWith(1, {
      channels: 1,
      pcm: Uint8Array.of(0x00, 0x01, 0xfe, 0xff),
      sampleRateHz: 16_000,
      timestampUs: 0,
    });
    expect(closed).toHaveBeenCalledTimes(2);
  });

  it('fails closed if the decoder returns a different audio format', async () => {
    const error = vi.fn();
    const harness = createWebCodecsHarness(Uint8Array.of(0, 0), vi.fn(), { sampleRate: 48_000 });
    const decoder = new WebCodecsOmiOpusDecoder({ pcm: vi.fn(), error }, harness.codecs);

    decoder.decode(Uint8Array.of(0xaa));
    await flushPromises();

    expect(error).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Omi decoder produced 48000 Hz / 1 channel audio',
    }));
  });
});

function createWebCodecsHarness(
  decodedPcm: Uint8Array,
  close: () => void,
  format: { sampleRate?: number; channels?: number } = {},
) {
  const chunks: Array<Record<string, unknown>> = [];
  const configures: Array<Record<string, unknown>> = [];
  let output: ((data: OmiWebCodecsAudioData) => void) | null = null;
  const decoder: OmiWebCodecsDecoder = {
    state: 'unconfigured',
    configure(config) {
      configures.push(config);
      this.state = 'configured';
    },
    decode() {
      const bytes = decodedPcm.slice();
      output?.({
        numberOfChannels: format.channels ?? 1,
        sampleRate: format.sampleRate ?? 16_000,
        allocationSize: () => bytes.byteLength,
        async copyTo(destination) { destination.set(bytes); },
        close,
      });
    },
    async flush() {},
    close() { this.state = 'closed'; },
  };
  const codecs: OmiWebCodecs = {
    createDecoder(init) {
      output = init.output;
      return decoder;
    },
    createEncodedChunk(init) {
      chunks.push({ ...init, data: init.data.slice() });
      return { marker: chunks.length };
    },
  };
  return { chunks, codecs, configures };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
