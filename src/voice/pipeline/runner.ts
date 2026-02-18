import {
  toPipelineOutputs,
  type VoicePipelineContext,
  type VoicePipelineDefinition,
} from './pipeline.js';
import { PipelineTask, type PipelineTaskState } from './task.js';

export type VoicePipelineRunnerState =
  | 'idle'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'stopped'
  | 'cancelled'
  | 'failed';

export interface VoicePipelineRunnerSnapshot {
  state: VoicePipelineRunnerState;
  runId: number;
  reason?: string;
  error?: Error;
}

export class VoicePipelineRunner<TInput, TOutput> {
  private readonly definition: VoicePipelineDefinition<TInput, TOutput>;

  private runnerState: VoicePipelineRunnerState = 'idle';
  private runId = 0;
  private task: PipelineTask | null = null;
  private completion: Promise<void> = Promise.resolve();
  private reason?: string;
  private error?: Error;

  constructor(definition: VoicePipelineDefinition<TInput, TOutput>) {
    this.definition = definition;
  }

  get snapshot(): VoicePipelineRunnerSnapshot {
    return {
      state: this.runnerState,
      runId: this.runId,
      reason: this.reason,
      error: this.error,
    };
  }

  get isActive(): boolean {
    return this.runnerState === 'running' || this.runnerState === 'stopping';
  }

  start(): void {
    if (this.isActive) {
      return;
    }

    this.runId += 1;
    this.reason = undefined;
    this.error = undefined;
    this.runnerState = 'running';

    const activeRunId = this.runId;
    const task = new PipelineTask(async ({ signal }) => {
      const context: VoicePipelineContext = {
        signal,
        runId: activeRunId,
      };
      await this.execute(context);
    });

    this.task = task;
    this.completion = task.start().then(() => {
      const taskSnapshot = task.snapshot;
      this.reason = taskSnapshot.reason;
      this.error = taskSnapshot.error;
      this.runnerState = mapTaskState(task.state);
    });
  }

  async stop(reason = 'stop-requested'): Promise<void> {
    if (!this.task || !this.isActive) {
      return;
    }

    this.runnerState = 'stopping';
    await this.task.stop(reason);
    await this.completion;
  }

  async cancel(reason = 'cancel-requested'): Promise<void> {
    if (!this.task || !this.isActive) {
      return;
    }

    await this.task.cancel(reason);
    await this.completion;
  }

  async waitForCompletion(): Promise<void> {
    await this.completion;
  }

  private async execute(context: VoicePipelineContext): Promise<void> {
    for await (const sourceItem of this.definition.source(context)) {
      if (context.signal.aborted) {
        break;
      }

      let stageOutputs: ReadonlyArray<unknown> = [sourceItem];
      for (const processor of this.definition.processors) {
        if (context.signal.aborted) {
          break;
        }

        const nextOutputs: unknown[] = [];
        for (const stageOutput of stageOutputs) {
          if (context.signal.aborted) {
            break;
          }

          const result = await processor(stageOutput, context);
          nextOutputs.push(...toPipelineOutputs(result));
        }

        stageOutputs = nextOutputs;
        if (stageOutputs.length === 0) {
          break;
        }
      }

      if (context.signal.aborted) {
        break;
      }

      for (const output of stageOutputs) {
        if (context.signal.aborted) {
          break;
        }

        await this.definition.sink(output as TOutput, context);
      }
    }
  }
}

function mapTaskState(state: PipelineTaskState): VoicePipelineRunnerState {
  switch (state) {
    case 'completed':
      return 'completed';
    case 'stopped':
      return 'stopped';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
    case 'running':
    case 'stopping':
      return 'running';
    case 'idle':
    default:
      return 'idle';
  }
}
