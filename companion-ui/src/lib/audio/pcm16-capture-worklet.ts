import {
  COMPANION_PCM_CHUNK_BYTES,
  COMPANION_PCM_CHUNK_SAMPLES,
  COMPANION_PCM_WORKLET_NAME,
  encodePcm16LittleEndian,
  StreamingPcm16Downsampler,
} from './pcm16-downsampler.js';

declare const sampleRate: number;

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  abstract process(inputs: Float32Array[][]): boolean;
}

declare function registerProcessor(
  name: string,
  processor: new () => AudioWorkletProcessor,
): void;

class CompanionPcm16CaptureProcessor extends AudioWorkletProcessor {
  private readonly downsampler = new StreamingPcm16Downsampler(sampleRate);
  private readonly chunk = new Uint8Array(COMPANION_PCM_CHUNK_BYTES);
  private chunkOffset = 0;

  process(inputs: Float32Array[][]): boolean {
    const mono = inputs[0]?.[0];
    if (!mono || mono.length === 0) return true;
    const pcm = encodePcm16LittleEndian(this.downsampler.push(mono));
    let sourceOffset = 0;
    while (sourceOffset < pcm.byteLength) {
      const copied = Math.min(pcm.byteLength - sourceOffset, this.chunk.byteLength - this.chunkOffset);
      this.chunk.set(pcm.subarray(sourceOffset, sourceOffset + copied), this.chunkOffset);
      this.chunkOffset += copied;
      sourceOffset += copied;
      if (this.chunkOffset === this.chunk.byteLength) {
        const frame = this.chunk.slice().buffer;
        this.port.postMessage({ type: 'pcm', pcm: frame }, [frame]);
        this.chunkOffset = 0;
      }
    }
    return true;
  }
}

registerProcessor(COMPANION_PCM_WORKLET_NAME, CompanionPcm16CaptureProcessor);

export { COMPANION_PCM_CHUNK_SAMPLES };
