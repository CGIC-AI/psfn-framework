/** A cohesive optional transport capability for continuous PCM microphone audio. */
export interface PcmAudioStreamPort {
  start(): Promise<void>;
  write(pcm: Uint8Array): Promise<void>;
  stop(): Promise<void>;
}
