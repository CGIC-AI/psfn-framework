import { Buffer } from "node:buffer";

export interface WavOptions {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

export function pcm16MonoRms(chunk: Buffer): number {
  if (chunk.length < 2) {
    return 0;
  }
  let sum = 0;
  let samples = 0;
  for (let offset = 0; offset + 1 < chunk.length; offset += 2) {
    const sample = chunk.readInt16LE(offset) / 32768;
    sum += sample * sample;
    samples += 1;
  }
  if (samples === 0) {
    return 0;
  }
  return Math.sqrt(sum / samples);
}

export function pcm16Peak(chunk: Buffer): number {
  if (chunk.length < 2) {
    return 0;
  }
  let peak = 0;
  for (let offset = 0; offset + 1 < chunk.length; offset += 2) {
    const sample = Math.abs(chunk.readInt16LE(offset) / 32768);
    if (sample > peak) {
      peak = sample;
    }
  }
  return peak;
}

export function pcm16Gain(chunk: Buffer, gain: number): Buffer {
  if (gain === 1) {
    return chunk;
  }
  const out = Buffer.allocUnsafe(chunk.length);
  for (let offset = 0; offset + 1 < chunk.length; offset += 2) {
    const raw = chunk.readInt16LE(offset);
    const scaled = Math.max(-32768, Math.min(32767, Math.round(raw * gain)));
    out.writeInt16LE(scaled, offset);
  }
  return out;
}

export function wrapPcmAsWav(pcm: Buffer, options: WavOptions): Buffer {
  const { sampleRate, channels, bitsPerSample } = options;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
