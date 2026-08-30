import { describe, expect, it } from 'vitest';
import {
  encodePcm16LittleEndian,
  StreamingPcm16Downsampler,
} from './pcm16-downsampler.js';

describe('StreamingPcm16Downsampler', () => {
  it('box-filters 48 kHz mono into exact 16 kHz PCM across worklet blocks', () => {
    const downsampler = new StreamingPcm16Downsampler(48_000);
    const first = downsampler.push(Float32Array.from({ length: 127 }, () => 0.5));
    const second = downsampler.push(Float32Array.from({ length: 353 }, () => 0.5));

    expect([...first, ...second]).toHaveLength(160);
    expect([...first, ...second].every(sample => sample === 16_384)).toBe(true);
  });

  it('retains fractional buckets for 44.1 kHz input without drift per frame', () => {
    const downsampler = new StreamingPcm16Downsampler(44_100);

    expect(downsampler.push(Float32Array.from({ length: 441 }, () => -0.25)))
      .toHaveLength(160);
  });

  it('clips non-finite and out-of-range samples and writes little-endian bytes', () => {
    const bytes = encodePcm16LittleEndian(Int16Array.of(-32_768, 0, 32_767));
    expect([...bytes]).toEqual([0x00, 0x80, 0x00, 0x00, 0xff, 0x7f]);

    const downsampler = new StreamingPcm16Downsampler(16_000);
    expect([...downsampler.push(Float32Array.of(-2, Number.NaN, 2))])
      .toEqual([-32_768, 0, 32_767]);
  });

  it('rejects source rates that would require fabricated upsampling', () => {
    expect(() => new StreamingPcm16Downsampler(8_000)).toThrow(/cannot be downsampled/u);
  });
});
