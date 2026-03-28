import type {
  SttStreamConfig,
  StreamingSttConnector,
} from '../../connectors/stt/types.js';
import type {
  StreamingTtsConnector,
  TtsSynthesisRequest,
} from '../../connectors/tts/types.js';
import type { VoiceRuntimeStage } from '../../policy/reliability.js';

export const VOICE_WIRE_PROTOCOL = 'voice-wire-v1' as const;

export interface VoiceWireFrameBase {
  wire: typeof VOICE_WIRE_PROTOCOL;
  sessionId: string;
  timestampMs?: number;
}

export interface VoiceSessionStartFrame extends VoiceWireFrameBase {
  type: 'session.start';
}

export interface VoiceAudioChunkFrame extends VoiceWireFrameBase {
  type: 'audio.chunk';
  seq: number;
  audioBase64: string;
}

export interface VoiceSessionEndFrame extends VoiceWireFrameBase {
  type: 'session.end';
}

export interface VoiceInterruptFrame extends VoiceWireFrameBase {
  type: 'interrupt';
  reason?: string;
}

export interface VoicePingFrame extends VoiceWireFrameBase {
  type: 'ping';
}

export interface VoiceAckFrame extends VoiceWireFrameBase {
  type: 'ack';
  ackType: VoiceWireInboundFrame['type'];
}

export interface VoiceTranscriptFrame extends VoiceWireFrameBase {
  type: 'transcript.partial' | 'transcript.final';
  text: string;
}

export interface VoicePlaybackFrame extends VoiceWireFrameBase {
  type: 'playback.chunk';
  seq: number;
  audioBase64: string;
}

export interface VoicePongFrame extends VoiceWireFrameBase {
  type: 'pong';
}

export interface VoiceWireErrorFrame extends VoiceWireFrameBase {
  type: 'error';
  code: string;
  message: string;
}

export type VoiceWireInboundFrame =
  | VoiceSessionStartFrame
  | VoiceAudioChunkFrame
  | VoiceSessionEndFrame
  | VoiceInterruptFrame
  | VoicePingFrame;

export type VoiceWireOutboundFrame =
  | VoiceAckFrame
  | VoiceTranscriptFrame
  | VoicePlaybackFrame
  | VoicePongFrame
  | VoiceWireErrorFrame;

export type VoiceWireFrame = VoiceWireInboundFrame | VoiceWireOutboundFrame;

export interface WebSocketVoiceSession {
  id: string;
  connectionId: string;
  openedAtMs: number;
  lastSeenAtMs: number;
}

export interface WebSocketVoiceConnection {
  id: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: (data: string) => void): () => void;
  onClose(handler: () => void): () => void;
}

export interface WebSocketVoiceServerOptions {
  maxFrameBytes: number;
  sessionTimeoutMs: number;
  now?: () => number;
}

export interface WebSocketVoiceServerHooks {
  onSessionOpen?: (session: WebSocketVoiceSession) => void | Promise<void>;
  onSessionClose?: (
    session: WebSocketVoiceSession,
    reason: 'timeout' | 'client_disconnect' | 'decode_error' | 'shutdown',
  ) => void | Promise<void>;
  onFrame?: (session: WebSocketVoiceSession, frame: VoiceWireInboundFrame) => void | Promise<void>;
}

export interface VoiceRuntimeSecurityPolicy {
  validatePcmAudio(pcm: Uint8Array): void;
  validateTranscriptText(text: string): string;
  validateTtsInputText(text: string): string;
  validateTtsAudioChunk(chunk: Uint8Array, totalBytesSoFar: number): number;
}

export interface VoiceRuntimeReliabilityPolicy {
  runStage<T>(stage: VoiceRuntimeStage, task: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export interface WebSocketVoiceRuntimeAssistantRequest {
  transportSession: WebSocketVoiceSession;
  sessionId: string;
  transcript: string;
  signal: AbortSignal;
}

export type WebSocketVoiceRuntimeAssistantHandler = (
  request: WebSocketVoiceRuntimeAssistantRequest,
) => Promise<string>;

export interface WebSocketVoiceRuntimeOptions {
  stt: StreamingSttConnector;
  tts: StreamingTtsConnector;
  security: VoiceRuntimeSecurityPolicy;
  onAssistantTurn: WebSocketVoiceRuntimeAssistantHandler;
  emitFrame: (session: WebSocketVoiceSession, frame: VoiceWireOutboundFrame) => void | Promise<void>;
  sttConfig: SttStreamConfig;
  ttsRequest?: Omit<TtsSynthesisRequest, 'text'>;
  reliability?: VoiceRuntimeReliabilityPolicy;
  maxAudioChunkBytes?: number;
  now?: () => number;
}
