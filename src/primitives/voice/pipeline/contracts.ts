import type { VoiceFrame } from './frames.js';

export type VoiceMaybePromise<T> = T | Promise<T>;

export type VoiceFrameOutput<TOut extends VoiceFrame = VoiceFrame> = TOut | readonly TOut[] | void;

export interface VoiceProcessorRuntimeContext {
  readonly signal?: AbortSignal;
}

export interface VoiceProcessorContext<TOut extends VoiceFrame = VoiceFrame> {
  readonly signal?: AbortSignal;
  emit(frame: TOut): VoiceMaybePromise<void>;
}

export interface VoiceProcessorLifecycle {
  start?(context: VoiceProcessorRuntimeContext): VoiceMaybePromise<void>;
  stop?(): VoiceMaybePromise<void>;
  cancel?(reason?: string): VoiceMaybePromise<void>;
}

export interface VoiceFrameProcessor<
  TIn extends VoiceFrame = VoiceFrame,
  TOut extends VoiceFrame = VoiceFrame,
> extends VoiceProcessorLifecycle {
  readonly id: string;
  readonly inputKinds?: readonly TIn['kind'][];
  readonly outputKinds?: readonly TOut['kind'][];
  process(frame: TIn, context: VoiceProcessorContext<TOut>): VoiceMaybePromise<VoiceFrameOutput<TOut>>;
}
