export type SttAudioEncoding = 'pcm_s16le' | 'opus';

export interface SttStreamConfig {
  sampleRateHz: number;
  channels: number;
  encoding: SttAudioEncoding;
  language?: string;
  interimResults?: boolean;
  model?: string;
}

export interface SttTranscriptChunk {
  type: 'partial' | 'final';
  text: string;
  confidence?: number;
  startMs?: number;
  endMs?: number;
}

export interface SttStreamSession {
  transcripts: AsyncIterable<SttTranscriptChunk>;
  writeAudio(chunk: Uint8Array): Promise<void>;
  endInput(): Promise<void>;
  cancel(reason?: string): Promise<void>;
}

export interface StreamingSttConnector {
  id: string;
  startStream(config: SttStreamConfig, signal?: AbortSignal): Promise<SttStreamSession>;
}
