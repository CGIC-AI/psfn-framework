export type MaybePromise<T> = T | Promise<T>;

export interface VoicePipelineContext {
  signal: AbortSignal;
  runId: number;
}

export type VoicePipelineStageOutput<TOutput> = TOutput | ReadonlyArray<TOutput> | undefined;

export type VoicePipelineSource<TInput> = (
  context: VoicePipelineContext,
) => AsyncIterable<TInput> | Iterable<TInput>;

export type VoicePipelineProcessor<TInput, TOutput> = (
  input: TInput,
  context: VoicePipelineContext,
) => MaybePromise<VoicePipelineStageOutput<TOutput>>;

export type VoicePipelineSink<TOutput> = (
  output: TOutput,
  context: VoicePipelineContext,
) => MaybePromise<void>;

export interface VoicePipelineDefinition<TInput, TOutput> {
  source: VoicePipelineSource<TInput>;
  processors: ReadonlyArray<VoicePipelineProcessor<unknown, unknown>>;
  sink: VoicePipelineSink<TOutput>;
}

const EMPTY_OUTPUTS: readonly [] = [];

export function toPipelineOutputs<TOutput>(
  value: VoicePipelineStageOutput<TOutput>,
): ReadonlyArray<TOutput> {
  if (value === undefined) {
    return EMPTY_OUTPUTS as ReadonlyArray<TOutput>;
  }

  if (Array.isArray(value)) {
    return value as ReadonlyArray<TOutput>;
  }
  return [value as TOutput];
}

export class VoicePipeline<TInput, TOutput = TInput> {
  private readonly source: VoicePipelineSource<TInput>;
  private readonly processors: ReadonlyArray<VoicePipelineProcessor<unknown, unknown>>;

  private constructor(
    source: VoicePipelineSource<TInput>,
    processors: ReadonlyArray<VoicePipelineProcessor<unknown, unknown>>,
  ) {
    this.source = source;
    this.processors = processors;
  }

  static fromSource<TInput>(source: VoicePipelineSource<TInput>): VoicePipeline<TInput, TInput> {
    return new VoicePipeline(source, []);
  }

  pipe<TNext>(processor: VoicePipelineProcessor<TOutput, TNext>): VoicePipeline<TInput, TNext> {
    return new VoicePipeline<TInput, TNext>(
      this.source,
      [...this.processors, processor as VoicePipelineProcessor<unknown, unknown>],
    );
  }

  toDefinition(sink: VoicePipelineSink<TOutput>): VoicePipelineDefinition<TInput, TOutput> {
    return {
      source: this.source,
      processors: this.processors,
      sink,
    };
  }
}
