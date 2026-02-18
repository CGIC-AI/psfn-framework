export type PipelineTaskState =
  | 'idle'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'stopped'
  | 'cancelled'
  | 'failed';

export interface PipelineTaskContext {
  signal: AbortSignal;
}

export type PipelineTaskExecutor = (context: PipelineTaskContext) => Promise<void>;

export interface PipelineTaskSnapshot {
  state: PipelineTaskState;
  reason?: string;
  error?: Error;
}

export class PipelineTask {
  private readonly executor: PipelineTaskExecutor;
  private readonly controller = new AbortController();

  private taskState: PipelineTaskState = 'idle';
  private completion: Promise<void> | null = null;
  private stopRequested = false;
  private cancelRequested = false;
  private reason?: string;
  private error?: Error;

  constructor(executor: PipelineTaskExecutor) {
    this.executor = executor;
  }

  get state(): PipelineTaskState {
    return this.taskState;
  }

  get snapshot(): PipelineTaskSnapshot {
    return {
      state: this.taskState,
      reason: this.reason,
      error: this.error,
    };
  }

  start(): Promise<void> {
    if (this.taskState !== 'idle') {
      throw new Error('PipelineTask can only be started from idle state');
    }

    this.taskState = 'running';
    this.completion = this.runExecutor();
    return this.completion;
  }

  async stop(reason = 'stop-requested'): Promise<void> {
    if (this.isTerminal(this.taskState)) {
      return;
    }

    if (this.taskState === 'idle') {
      this.stopRequested = true;
      this.reason = reason;
      this.taskState = 'stopped';
      return;
    }

    this.stopRequested = true;
    if (!this.reason) {
      this.reason = reason;
    }

    if (this.taskState === 'running') {
      this.taskState = 'stopping';
    }

    this.abort(reason);
    await this.wait();
  }

  async cancel(reason = 'cancel-requested'): Promise<void> {
    if (this.taskState === 'cancelled') {
      return;
    }

    if (this.taskState === 'idle') {
      this.cancelRequested = true;
      this.reason = reason;
      this.taskState = 'cancelled';
      return;
    }

    if (this.isTerminal(this.taskState)) {
      return;
    }

    this.cancelRequested = true;
    this.reason = reason;

    this.abort(reason);
    await this.wait();
  }

  async wait(): Promise<void> {
    if (!this.completion) {
      return;
    }

    await this.completion;
  }

  private async runExecutor(): Promise<void> {
    try {
      await this.executor({ signal: this.controller.signal });
    } catch (error) {
      this.error = toError(error);
    } finally {
      this.finalizeState();
    }
  }

  private finalizeState(): void {
    const aborted = this.controller.signal.aborted;

    if (this.error) {
      if (aborted && this.cancelRequested) {
        this.taskState = 'cancelled';
        return;
      }

      if (aborted && this.stopRequested) {
        this.taskState = 'stopped';
        return;
      }

      if (aborted) {
        this.taskState = 'cancelled';
        return;
      }

      this.taskState = 'failed';
      return;
    }

    if (this.cancelRequested) {
      this.taskState = 'cancelled';
      return;
    }

    if (this.stopRequested) {
      this.taskState = 'stopped';
      return;
    }

    this.taskState = 'completed';
  }

  private abort(reason: string): void {
    if (!this.controller.signal.aborted) {
      this.controller.abort(reason);
    }
  }

  private isTerminal(state: PipelineTaskState): boolean {
    return state === 'completed' || state === 'stopped' || state === 'cancelled' || state === 'failed';
  }
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}
