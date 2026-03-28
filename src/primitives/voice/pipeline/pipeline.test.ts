import { describe, expect, it } from 'vitest';
import { VoicePipeline, toPipelineOutputs } from './pipeline.js';
import { VoicePipelineRunner } from './runner.js';

describe('toPipelineOutputs', () => {
  it('normalizes undefined/single/list outputs', () => {
    expect(toPipelineOutputs(undefined)).toEqual([]);
    expect(toPipelineOutputs(42)).toEqual([42]);
    expect(toPipelineOutputs([1, 2, 3])).toEqual([1, 2, 3]);
  });
});

describe('VoicePipeline', () => {
  it('composes processors and produces sink output', async () => {
    const values: number[] = [];

    const definition = VoicePipeline
      .fromSource<number>(async function* () {
        yield 1;
        yield 2;
      })
      .pipe((input: number) => input + 1)
      .pipe((input: number) => [input * 2, input * 3])
      .toDefinition(async (output: number) => {
        values.push(output);
      });

    const runner = new VoicePipelineRunner(definition);
    runner.start();
    await runner.waitForCompletion();

    expect(values).toEqual([4, 6, 6, 9]);
    expect(runner.snapshot.state).toBe('completed');
  });
});
