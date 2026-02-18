export type VoiceFrameKind =
  | 'audio.input.chunk'
  | 'transcript.partial'
  | 'transcript.final'
  | 'token.delta'
  | 'token.final'
  | 'audio.output.chunk'
  | 'control'
  | 'error'
  | 'metric';

export interface VoiceFrameBase<TKind extends VoiceFrameKind, TPayload> {
  readonly kind: TKind;
  readonly sequence: number;
  readonly timestampMs: number;
  readonly streamId?: string;
  readonly interruptible: boolean;
  readonly payload: Readonly<TPayload>;
}

export interface VoiceAudioInputChunkPayload {
  readonly data: Uint8Array;
  readonly format: string;
  readonly sampleRateHz: number;
  readonly channels: number;
}

export interface VoiceTranscriptPayload {
  readonly text: string;
  readonly confidence?: number;
}

export interface VoiceTokenDeltaPayload {
  readonly token: string;
  readonly index: number;
}

export interface VoiceTokenFinalPayload {
  readonly text: string;
}

export interface VoiceAudioOutputChunkPayload {
  readonly data: Uint8Array;
  readonly format: string;
  readonly sampleRateHz: number;
  readonly channels: number;
}

export type VoiceControlCommand = 'start' | 'stop' | 'cancel' | 'interrupt' | 'flush' | 'resume';

export interface VoiceControlPayload {
  readonly command: VoiceControlCommand;
  readonly reason?: string;
  readonly targetStreamId?: string;
}

export interface VoiceErrorPayload {
  readonly message: string;
  readonly code?: string;
  readonly source?: string;
  readonly recoverable: boolean;
}

export interface VoiceMetricPayload {
  readonly name: string;
  readonly value: number;
  readonly unit?: string;
  readonly dimensions?: Readonly<Record<string, string | number | boolean>>;
}

export type VoiceAudioInputChunkFrame = VoiceFrameBase<'audio.input.chunk', VoiceAudioInputChunkPayload>;
export type VoiceTranscriptPartialFrame = VoiceFrameBase<'transcript.partial', VoiceTranscriptPayload>;
export type VoiceTranscriptFinalFrame = VoiceFrameBase<'transcript.final', VoiceTranscriptPayload>;
export type VoiceTokenDeltaFrame = VoiceFrameBase<'token.delta', VoiceTokenDeltaPayload>;
export type VoiceTokenFinalFrame = VoiceFrameBase<'token.final', VoiceTokenFinalPayload>;
export type VoiceAudioOutputChunkFrame = VoiceFrameBase<'audio.output.chunk', VoiceAudioOutputChunkPayload>;
export type VoiceControlFrame = VoiceFrameBase<'control', VoiceControlPayload>;
export type VoiceErrorFrame = VoiceFrameBase<'error', VoiceErrorPayload>;
export type VoiceMetricFrame = VoiceFrameBase<'metric', VoiceMetricPayload>;

export type VoiceFrame =
  | VoiceAudioInputChunkFrame
  | VoiceTranscriptPartialFrame
  | VoiceTranscriptFinalFrame
  | VoiceTokenDeltaFrame
  | VoiceTokenFinalFrame
  | VoiceAudioOutputChunkFrame
  | VoiceControlFrame
  | VoiceErrorFrame
  | VoiceMetricFrame;

export type VoiceDataFrame = Exclude<VoiceFrame, VoiceControlFrame>;

export const INTERRUPT_CONTROL_COMMANDS = ['cancel', 'interrupt', 'flush'] as const;
export type InterruptControlCommand = (typeof INTERRUPT_CONTROL_COMMANDS)[number];

export function isVoiceControlFrame(frame: VoiceFrame): frame is VoiceControlFrame {
  return frame.kind === 'control';
}

export function isVoiceDataFrame(frame: VoiceFrame): frame is VoiceDataFrame {
  return frame.kind !== 'control';
}

export function isInterruptControlFrame(frame: VoiceFrame): frame is VoiceControlFrame {
  return isVoiceControlFrame(frame) && INTERRUPT_CONTROL_COMMANDS.includes(frame.payload.command as InterruptControlCommand);
}
