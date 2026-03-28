export type TtsAudioEncoding = 'pcm_s16le' | 'mp3' | 'opus';

export interface TtsSynthesisRequest {
  text: string;
  voiceId?: string;
  sampleRateHz?: number;
  encoding?: TtsAudioEncoding;
  allowBufferFallback?: boolean;
}

export interface TtsAudioChunk {
  audio: Uint8Array;
  sequence: number;
  isFinal: boolean;
  encoding: TtsAudioEncoding;
  source: 'stream' | 'buffer-fallback';
}

export interface TtsSynthesisSession {
  audio: AsyncIterable<TtsAudioChunk>;
  cancel(reason?: string): Promise<void>;
}

export interface StreamingTtsConnector {
  id: string;
  synthesizeStream(request: TtsSynthesisRequest, signal?: AbortSignal): Promise<TtsSynthesisSession>;
  synthesizeBuffer(request: TtsSynthesisRequest, signal?: AbortSignal): Promise<Buffer>;
}
