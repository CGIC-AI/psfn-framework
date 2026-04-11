export interface VoiceInputCaptureOptions {
  userId: string;
  silenceDurationMs: number;
}

export interface VoiceTransportInput {
  onSpeakingStart(userId: string, onStart: () => void): () => void;
  captureOpus(options: VoiceInputCaptureOptions): NodeJS.ReadableStream;
}

export interface VoiceTransportOutput {
  playAudio(audio: Buffer): Promise<void>;
  stop(): void;
}
