import { describe, expect, it } from 'vitest';
import { VoicePipeline } from '../pipeline/pipeline.js';
import { VoiceOrchestrator } from './orchestrator.js';

describe('VoiceOrchestrator', () => {
  it('moves start -> running -> stopped on natural completion', async () => {
    const outputs: number[] = [];
    const transitions: string[] = [];

    const orchestrator = new VoiceOrchestrator({
      pipeline: VoicePipeline
        .fromSource<number>(async function* () {
          yield 5;
        })
        .toDefinition(async (output: number) => {
          outputs.push(output);
        }),
    });

    orchestrator.onTransition((transition) => {
      transitions.push(transition.to);
    });

    orchestrator.start();
    await orchestrator.waitForCompletion();
    await Promise.resolve();

    expect(outputs).toEqual([5]);
    expect(transitions).toEqual(['starting', 'running', 'stopped']);
    expect(orchestrator.getSnapshot().state).toBe('stopped');
  });

  it('stops an active run', async () => {
    const orchestrator = new VoiceOrchestrator({
      pipeline: VoicePipeline
        .fromSource<number>(async function* ({ signal }) {
          yield 1;
          await waitForAbort(signal);
        })
        .toDefinition(async () => {}),
    });

    orchestrator.start();
    await Promise.resolve();
    await orchestrator.stop('shutdown');

    const snapshot = orchestrator.getSnapshot();
    expect(snapshot.state).toBe('stopped');
    expect(snapshot.reason).toBe('shutdown');
  });

  it('supports stop/cancel races and resolves to cancelled', async () => {
    const orchestrator = new VoiceOrchestrator({
      pipeline: VoicePipeline
        .fromSource<number>(async function* ({ signal }) {
          yield 1;
          await waitForAbort(signal);
        })
        .toDefinition(async () => {}),
    });

    orchestrator.start();
    await Promise.resolve();

    const stopPromise = orchestrator.stop('graceful-stop');
    const cancelPromise = orchestrator.cancel('barge-in');
    await Promise.all([stopPromise, cancelPromise]);

    const snapshot = orchestrator.getSnapshot();
    expect(snapshot.state).toBe('cancelled');
    expect(snapshot.reason).toBe('barge-in');
  });
});

async function waitForAbort(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}
