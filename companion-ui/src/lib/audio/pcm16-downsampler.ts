export const COMPANION_PCM_SAMPLE_RATE_HZ = 16_000;
export const COMPANION_PCM_CHUNK_SAMPLES = 320;
export const COMPANION_PCM_CHUNK_BYTES = COMPANION_PCM_CHUNK_SAMPLES * 2;
export const COMPANION_PCM_WORKLET_NAME = 'psfn-companion-pcm16-capture';
const DOWNSAMPLE_EPSILON = 1e-9;

/**
 * Streaming box-filter downsampler for microphone mono floats. Fractional
 * source/target ratios retain their bucket state across AudioWorklet blocks.
 */
export class StreamingPcm16Downsampler {
  private readonly sourceSamplesPerOutput: number;
  private remainingSourceSamples: number;
  private weightedSum = 0;
  private accumulatedWeight = 0;

  constructor(
    sourceSampleRateHz: number,
    targetSampleRateHz = COMPANION_PCM_SAMPLE_RATE_HZ,
  ) {
    if (!Number.isFinite(sourceSampleRateHz)
      || !Number.isFinite(targetSampleRateHz)
      || targetSampleRateHz <= 0
      || sourceSampleRateHz < targetSampleRateHz) {
      throw new Error('Microphone sample rate cannot be downsampled to Companion PCM');
    }
    this.sourceSamplesPerOutput = sourceSampleRateHz / targetSampleRateHz;
    this.remainingSourceSamples = this.sourceSamplesPerOutput;
  }

  push(input: Float32Array): Int16Array {
    const output: number[] = [];
    for (const sample of input) {
      let remainingInputWeight = 1;
      while (remainingInputWeight > DOWNSAMPLE_EPSILON) {
        const weight = Math.min(remainingInputWeight, this.remainingSourceSamples);
        this.weightedSum += clampSample(sample) * weight;
        this.accumulatedWeight += weight;
        remainingInputWeight -= weight;
        this.remainingSourceSamples -= weight;
        if (this.remainingSourceSamples <= DOWNSAMPLE_EPSILON) {
          output.push(floatToPcm16(this.weightedSum / this.accumulatedWeight));
          this.weightedSum = 0;
          this.accumulatedWeight = 0;
          this.remainingSourceSamples = this.sourceSamplesPerOutput;
        }
      }
    }
    return Int16Array.from(output);
  }
}

export function encodePcm16LittleEndian(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * 2, samples[index] ?? 0, true);
  }
  return bytes;
}

function clampSample(sample: number): number {
  return Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0));
}

function floatToPcm16(sample: number): number {
  return Math.round(sample < 0 ? sample * 32_768 : sample * 32_767);
}
