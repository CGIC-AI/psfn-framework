import type { VoiceFrame } from './frames.js';
import type {
  VoiceFrameOutput,
  VoiceFrameProcessor,
  VoiceMaybePromise,
  VoiceProcessorContext,
  VoiceProcessorRuntimeContext,
} from './contracts.js';

export interface VoiceProcessorDefinition<
  TIn extends VoiceFrame = VoiceFrame,
  TOut extends VoiceFrame = VoiceFrame,
> {
  readonly id: string;
  readonly inputKinds?: readonly TIn['kind'][];
  readonly outputKinds?: readonly TOut['kind'][];
  process(frame: TIn, context: VoiceProcessorContext<TOut>): VoiceMaybePromise<VoiceFrameOutput<TOut>>;
  start?(context: VoiceProcessorRuntimeContext): VoiceMaybePromise<void>;
  stop?(): VoiceMaybePromise<void>;
  cancel?(reason?: string): VoiceMaybePromise<void>;
}

class InlineVoiceProcessor<
  TIn extends VoiceFrame,
  TOut extends VoiceFrame,
> implements VoiceFrameProcessor<TIn, TOut> {
  readonly id: string;
  readonly inputKinds?: readonly TIn['kind'][];
  readonly outputKinds?: readonly TOut['kind'][];

  private readonly onProcess: VoiceProcessorDefinition<TIn, TOut>['process'];
  private readonly onStart: VoiceProcessorDefinition<TIn, TOut>['start'];
  private readonly onStop: VoiceProcessorDefinition<TIn, TOut>['stop'];
  private readonly onCancel: VoiceProcessorDefinition<TIn, TOut>['cancel'];

  constructor(definition: VoiceProcessorDefinition<TIn, TOut>) {
    this.id = definition.id;
    this.inputKinds = definition.inputKinds;
    this.outputKinds = definition.outputKinds;
    this.onProcess = definition.process;
    this.onStart = definition.start;
    this.onStop = definition.stop;
    this.onCancel = definition.cancel;
  }

  process(frame: TIn, context: VoiceProcessorContext<TOut>): VoiceMaybePromise<VoiceFrameOutput<TOut>> {
    return this.onProcess(frame, context);
  }

  async start(context: VoiceProcessorRuntimeContext): Promise<void> {
    await this.onStart?.(context);
  }

  async stop(): Promise<void> {
    await this.onStop?.();
  }

  async cancel(reason?: string): Promise<void> {
    await this.onCancel?.(reason);
  }
}

export function createVoiceProcessor<
  TIn extends VoiceFrame = VoiceFrame,
  TOut extends VoiceFrame = VoiceFrame,
>(definition: VoiceProcessorDefinition<TIn, TOut>): VoiceFrameProcessor<TIn, TOut> {
  return new InlineVoiceProcessor(definition);
}

export async function emitProcessorOutput<TOut extends VoiceFrame>(
  output: VoiceFrameOutput<TOut>,
  context: VoiceProcessorContext<TOut>,
): Promise<void> {
  if (!output) return;

  if (Array.isArray(output)) {
    for (const frame of output as readonly TOut[]) {
      await context.emit(frame as TOut);
    }
    return;
  }

  await context.emit(output as TOut);
}

export async function processFrameThroughProcessor<
  TIn extends VoiceFrame,
  TOut extends VoiceFrame,
>(
  processor: VoiceFrameProcessor<TIn, TOut>,
  frame: TIn,
  context: VoiceProcessorContext<TOut>,
): Promise<void> {
  const output = await processor.process(frame, context);
  await emitProcessorOutput(output, context);
}
