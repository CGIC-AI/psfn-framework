import { VoicePipelineRunner } from '../pipeline/runner.js';
import type {
  VoiceOrchestratorListener,
  VoiceOrchestratorOptions,
  VoiceOrchestratorSnapshot,
  VoiceOrchestratorState,
  VoiceOrchestratorTransition,
} from './types.js';

export class VoiceOrchestrator<TInput, TOutput> {
  private readonly runner: VoicePipelineRunner<TInput, TOutput>;
  private readonly listeners = new Set<VoiceOrchestratorListener>();

  private snapshot: VoiceOrchestratorSnapshot = {
    state: 'idle',
    runId: 0,
  };

  constructor(options: VoiceOrchestratorOptions<TInput, TOutput>) {
    this.runner = new VoicePipelineRunner(options.pipeline);
  }

  getSnapshot(): VoiceOrchestratorSnapshot {
    return { ...this.snapshot };
  }

  onTransition(listener: VoiceOrchestratorListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (this.snapshot.state === 'starting' || this.snapshot.state === 'running') {
      return;
    }

    this.transitionTo('starting');
    this.runner.start();

    const runnerSnapshot = this.runner.snapshot;
    this.transitionTo('running', {
      runId: runnerSnapshot.runId,
      startedAt: Date.now(),
      endedAt: undefined,
      reason: undefined,
      error: undefined,
    });

    this.observeRunCompletion(runnerSnapshot.runId);
  }

  async stop(reason = 'stop-requested'): Promise<void> {
    if (!this.runner.isActive) {
      return;
    }

    this.transitionTo('stopping', { reason });
    await this.runner.stop(reason);
    this.syncTerminalState();
  }

  async cancel(reason = 'cancel-requested'): Promise<void> {
    if (!this.runner.isActive) {
      return;
    }

    await this.runner.cancel(reason);
    this.syncTerminalState();
  }

  async waitForCompletion(): Promise<void> {
    await this.runner.waitForCompletion();
  }

  private observeRunCompletion(runId: number): void {
    void this.runner.waitForCompletion().then(() => {
      if (this.snapshot.runId !== runId) {
        return;
      }

      this.syncTerminalState();
    });
  }

  private syncTerminalState(): void {
    const runnerSnapshot = this.runner.snapshot;
    const endedAt = Date.now();

    if (runnerSnapshot.state === 'failed') {
      this.transitionTo('failed', {
        reason: runnerSnapshot.reason,
        error: runnerSnapshot.error,
        endedAt,
      });
      return;
    }

    if (runnerSnapshot.state === 'cancelled') {
      this.transitionTo('cancelled', {
        reason: runnerSnapshot.reason,
        endedAt,
      });
      return;
    }

    if (runnerSnapshot.state === 'stopped' || runnerSnapshot.state === 'completed') {
      this.transitionTo('stopped', {
        reason: runnerSnapshot.reason,
        endedAt,
      });
    }
  }

  private transitionTo(
    nextState: VoiceOrchestratorState,
    updates: Partial<Omit<VoiceOrchestratorSnapshot, 'state'>> = {},
  ): void {
    const previousState = this.snapshot.state;
    const mergedSnapshot: VoiceOrchestratorSnapshot = {
      ...this.snapshot,
      ...updates,
      state: nextState,
    };

    if (
      previousState === nextState
      && mergedSnapshot.runId === this.snapshot.runId
      && mergedSnapshot.startedAt === this.snapshot.startedAt
      && mergedSnapshot.endedAt === this.snapshot.endedAt
      && mergedSnapshot.reason === this.snapshot.reason
      && mergedSnapshot.error === this.snapshot.error
    ) {
      return;
    }

    this.snapshot = mergedSnapshot;

    const transition: VoiceOrchestratorTransition = {
      from: previousState,
      to: nextState,
      runId: this.snapshot.runId,
      at: Date.now(),
      reason: updates.reason,
    };

    const snapshotCopy = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(transition, snapshotCopy);
    }
  }
}
