/**
 * v1 lipsync amplitude helpers.
 *
 * The sprite mouth opens and closes on the loudness of the companion's spoken
 * reply — amplitude only, no viseme modelling (7ang.7 non-goal). These pure
 * functions turn decoded PCM into a bounded 0..1 amplitude envelope and a
 * hysteresis-gated mouth-open boolean so a single loud sample cannot make the
 * mouth flicker.
 */

/** Root-mean-square loudness of a PCM frame, clamped to 0..1. */
export function rmsAmplitude(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / samples.length);
  return rms > 1 ? 1 : rms < 0 ? 0 : rms;
}

export interface NormalizeOptions {
  /** Amplitudes at or below this read as silence (0). */
  readonly floor: number;
  /** Amplitudes at or above this saturate the envelope (1). */
  readonly ceil: number;
  /** Perceptual curve; >1 lifts quiet speech, <1 compresses. */
  readonly gamma: number;
}

export const DEFAULT_NORMALIZE_OPTIONS: NormalizeOptions = Object.freeze({
  floor: 0.02,
  ceil: 0.4,
  gamma: 0.6,
});

/** Map a raw RMS amplitude into a perceptual 0..1 mouth-openness envelope. */
export function normalizeAmplitude(
  raw: number,
  options: NormalizeOptions = DEFAULT_NORMALIZE_OPTIONS,
): number {
  const { floor, ceil, gamma } = options;
  if (!(ceil > floor)) return 0;
  if (raw <= floor) return 0;
  if (raw >= ceil) return 1;
  const linear = (raw - floor) / (ceil - floor);
  const shaped = gamma > 0 ? linear ** gamma : linear;
  return shaped > 1 ? 1 : shaped < 0 ? 0 : shaped;
}

/**
 * Reduce decoded PCM to a per-frame normalized amplitude envelope. Each entry
 * is the perceptual openness (0..1) of one `frameMs` window; the playback
 * controller ticks through these in sync with the audio clock to drive the
 * mouth. `frameMs` must be positive.
 */
export function buildAmplitudeEnvelope(
  samples: Float32Array,
  sampleRate: number,
  frameMs: number,
  normalize: NormalizeOptions = DEFAULT_NORMALIZE_OPTIONS,
): number[] {
  if (samples.length === 0 || sampleRate <= 0 || frameMs <= 0) return [];
  const frameSize = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
  const envelope: number[] = [];
  for (let start = 0; start < samples.length; start += frameSize) {
    const frame = samples.subarray(start, Math.min(start + frameSize, samples.length));
    envelope.push(normalizeAmplitude(rmsAmplitude(frame), normalize));
  }
  return envelope;
}

export interface MouthGateOptions {
  /** Envelope must exceed this to open a closed mouth. */
  readonly openThreshold: number;
  /** Envelope must fall to/below this to close an open mouth. */
  readonly closeThreshold: number;
}

export const DEFAULT_MOUTH_GATE: MouthGateOptions = Object.freeze({
  openThreshold: 0.18,
  closeThreshold: 0.08,
});

/**
 * Hysteresis gate: opening needs more energy than staying open, so the mouth
 * does not chatter around a single threshold. `closeThreshold` must be below
 * `openThreshold`; otherwise the gate falls back to a single-threshold compare.
 */
export function nextMouthOpen(
  open: boolean,
  envelope: number,
  options: MouthGateOptions = DEFAULT_MOUTH_GATE,
): boolean {
  const { openThreshold, closeThreshold } = options;
  if (open) return envelope > closeThreshold;
  return envelope >= openThreshold;
}
