import { describe, expect, it } from 'vitest';
import { createWavFromPcm16le } from './audio.js';

describe('createWavFromPcm16le', () => {
  it('builds a valid WAV header and appends PCM bytes', () => {
    const pcm = Buffer.from([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80, 0x34, 0x12]);
    const wav = createWavFromPcm16le(pcm, 48_000, 2);

    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.subarray(12, 16).toString('ascii')).toBe('fmt ');
    expect(wav.subarray(36, 40).toString('ascii')).toBe('data');
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.readUInt32LE(24)).toBe(48_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.subarray(44)).toEqual(pcm);
  });
});
