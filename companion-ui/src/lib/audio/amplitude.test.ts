import { describe, expect, it } from 'vitest';
import {
  buildAmplitudeEnvelope,
  DEFAULT_MOUTH_GATE,
  nextMouthOpen,
  normalizeAmplitude,
  rmsAmplitude,
} from './amplitude.js';

describe('rmsAmplitude', () => {
  it('is zero for silence and an empty frame', () => {
    expect(rmsAmplitude(new Float32Array(0))).toBe(0);
    expect(rmsAmplitude(new Float32Array([0, 0, 0]))).toBe(0);
  });

  it('computes root-mean-square loudness and clamps to 0..1', () => {
    expect(rmsAmplitude(new Float32Array([1, 1, 1]))).toBeCloseTo(1, 6);
    expect(rmsAmplitude(new Float32Array([0.5, -0.5]))).toBeCloseTo(0.5, 6);
    expect(rmsAmplitude(new Float32Array([2, -2]))).toBe(1);
  });
});

describe('normalizeAmplitude', () => {
  it('reads below-floor as silence and above-ceil as full open', () => {
    expect(normalizeAmplitude(0.01, { floor: 0.02, ceil: 0.4, gamma: 1 })).toBe(0);
    expect(normalizeAmplitude(0.5, { floor: 0.02, ceil: 0.4, gamma: 1 })).toBe(1);
  });

  it('maps the mid-range monotonically', () => {
    const low = normalizeAmplitude(0.1, { floor: 0, ceil: 1, gamma: 1 });
    const high = normalizeAmplitude(0.6, { floor: 0, ceil: 1, gamma: 1 });
    expect(low).toBeCloseTo(0.1, 6);
    expect(high).toBeGreaterThan(low);
  });

  it('returns 0 for a degenerate floor/ceil window', () => {
    expect(normalizeAmplitude(0.5, { floor: 0.5, ceil: 0.5, gamma: 1 })).toBe(0);
  });
});

describe('nextMouthOpen hysteresis', () => {
  it('opens only above the open threshold', () => {
    expect(nextMouthOpen(false, 0.1, DEFAULT_MOUTH_GATE)).toBe(false);
    expect(nextMouthOpen(false, 0.2, DEFAULT_MOUTH_GATE)).toBe(true);
  });

  it('stays open through the gap and closes at the close threshold', () => {
    // Between close and open thresholds an already-open mouth stays open.
    expect(nextMouthOpen(true, 0.1, DEFAULT_MOUTH_GATE)).toBe(true);
    expect(nextMouthOpen(true, 0.05, DEFAULT_MOUTH_GATE)).toBe(false);
  });
});

describe('buildAmplitudeEnvelope', () => {
  it('returns one entry per frame window', () => {
    const samples = new Float32Array(48_000).fill(0.5);
    const envelope = buildAmplitudeEnvelope(samples, 48_000, 100);
    // 48000 samples / (48000*0.1=4800 per frame) = 10 frames.
    expect(envelope).toHaveLength(10);
    for (const value of envelope) expect(value).toBe(1);
  });

  it('is empty for degenerate inputs', () => {
    expect(buildAmplitudeEnvelope(new Float32Array(0), 48_000, 60)).toHaveLength(0);
    expect(buildAmplitudeEnvelope(new Float32Array([1, 1]), 0, 60)).toHaveLength(0);
    expect(buildAmplitudeEnvelope(new Float32Array([1, 1]), 48_000, 0)).toHaveLength(0);
  });

  it('tracks a loud segment followed by silence', () => {
    const loud = new Float32Array(4_800).fill(0.8);
    const quiet = new Float32Array(4_800).fill(0);
    const samples = new Float32Array([...loud, ...quiet]);
    const envelope = buildAmplitudeEnvelope(samples, 48_000, 100);
    expect(envelope).toHaveLength(2);
    expect(envelope[0]).toBeGreaterThan(0.5);
    expect(envelope[1]).toBe(0);
  });
});
