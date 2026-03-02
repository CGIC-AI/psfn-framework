import { describe, expect, it, vi } from 'vitest';
import type { LLMProvider } from '../agent/contracts.js';
import type { CompletionPurpose, LLMContext, LLMResponse, StreamCallbacks } from '../types.js';
import { runDeliberation } from './deliberation.js';

interface ScriptedStep {
  purpose: CompletionPurpose;
  content: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  delayMs?: number;
}

function mockResponse(step: ScriptedStep): LLMResponse {
  return {
    content: step.content,
    toolCalls: [],
    model: step.model ?? `mock-${step.purpose}`,
    inputTokens: step.inputTokens ?? 12,
    outputTokens: step.outputTokens ?? 24,
    stopReason: 'stop',
  };
}

function scriptedProvider(steps: ScriptedStep[]): {
  provider: LLMProvider;
  calls: CompletionPurpose[];
  options: Array<Record<string, unknown> | undefined>;
} {
  const calls: CompletionPurpose[] = [];
  const options: Array<Record<string, unknown> | undefined> = [];
  let index = 0;

  const provider: LLMProvider = {
    stream: vi.fn(async (_context: LLMContext, _callbacks?: StreamCallbacks) => ({
      content: '',
      toolCalls: [],
      model: 'mock-stream',
      inputTokens: 0,
      outputTokens: 0,
      stopReason: 'stop',
    })),
    complete: vi.fn(async (
      _context: LLMContext,
      purpose: CompletionPurpose,
      requestOptions?: Record<string, unknown>,
    ) => {
      calls.push(purpose);
      options.push(requestOptions);
      const step = steps[index++];
      if (!step) {
        throw new Error(`No scripted response available for purpose ${purpose}`);
      }
      if (step.purpose !== purpose) {
        throw new Error(`Expected purpose ${step.purpose}, received ${purpose}`);
      }
      if (step.delayMs && step.delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, step.delayMs));
      }
      return mockResponse(step);
    }),
  };

  return { provider, calls, options };
}

describe('runDeliberation', () => {
  it('uses multi-purpose rounds and tapers when novelty collapses', async () => {
    const { provider, calls } = scriptedProvider([
      { purpose: 'reasoning', content: 'Structural lens says stability needs explicit commitments.' },
      { purpose: 'background', content: 'Emotional lens says trust feels fragile and needs reassurance.' },
      { purpose: 'reasoning', content: 'Synthesis: stability needs explicit commitments and reassurance.' },
      { purpose: 'reasoning', content: 'Structural lens repeats explicit commitments as the core need.' },
      { purpose: 'background', content: 'Emotional lens repeats reassurance as the core need.' },
      { purpose: 'reasoning', content: 'Synthesis: stability needs explicit commitments and reassurance.' },
    ]);

    const result = await runDeliberation(provider, 'Reflect on relationship drift', {
      caps: { maxRounds: 6, maxTotalTokens: 10_000, maxWallTimeMs: 20_000 },
    });

    expect(result.stopReason).toBe('fatigue_taper');
    expect(result.rounds).toHaveLength(2);
    expect(calls).toContain('reasoning');
    expect(calls).toContain('background');
    expect(result.totalTokens).toBeGreaterThan(0);
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('stops on token cap', async () => {
    const { provider } = scriptedProvider([
      { purpose: 'reasoning', content: 'Voice one', inputTokens: 160, outputTokens: 160 },
      { purpose: 'background', content: 'Voice two', inputTokens: 160, outputTokens: 160 },
    ]);

    const result = await runDeliberation(provider, 'Cap on tokens', {
      caps: { maxRounds: 5, maxTotalTokens: 300, maxWallTimeMs: 20_000 },
    });

    expect(result.stopReason).toBe('token_cap');
    expect(result.rounds).toHaveLength(1);
    expect(result.totalTokens).toBeGreaterThanOrEqual(300);
  });

  it('stops on wall-time cap', async () => {
    const { provider } = scriptedProvider([
      { purpose: 'reasoning', content: 'Slow voice', delayMs: 260 },
    ]);

    const result = await runDeliberation(provider, 'Cap on time', {
      caps: { maxRounds: 5, maxTotalTokens: 5_000, maxWallTimeMs: 250 },
    });

    expect(result.stopReason).toBe('time_cap');
    expect(result.rounds).toHaveLength(1);
  });

  it('stops at max rounds when fatigue never triggers', async () => {
    const { provider } = scriptedProvider([
      { purpose: 'reasoning', content: 'Round one structural signal.' },
      { purpose: 'background', content: 'Round one embodied signal.' },
      { purpose: 'reasoning', content: 'Ocean tide lunar pull.' },
      { purpose: 'reasoning', content: 'Round two structural signal.' },
      { purpose: 'background', content: 'Round two embodied signal.' },
      { purpose: 'reasoning', content: 'Granite circuit thermal flux.' },
    ]);

    const result = await runDeliberation(provider, 'Max rounds check', {
      caps: { maxRounds: 2, maxTotalTokens: 20_000, maxWallTimeMs: 20_000 },
    });

    expect(result.stopReason).toBe('max_rounds');
    expect(result.rounds).toHaveLength(2);
  });

  it('propagates model hints for reference voices and aggregator', async () => {
    const { provider, options } = scriptedProvider([
      { purpose: 'reasoning', content: 'Voice one', model: 'model-a', inputTokens: 10, outputTokens: 10 },
      { purpose: 'background', content: 'Voice two', model: 'model-b', inputTokens: 10, outputTokens: 10 },
      { purpose: 'reasoning', content: 'Synthesis output', model: 'model-agg', inputTokens: 10, outputTokens: 10 },
    ]);

    const result = await runDeliberation(provider, 'Hint routing', {
      referenceModels: ['model-a', 'model-b'],
      aggregatorModel: 'model-agg',
      caps: { maxRounds: 1, maxTotalTokens: 10_000, maxWallTimeMs: 20_000, maxTokensPerRound: 120 },
    });

    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0].aggregatorModel).toBe('model-agg');
    expect(options[0]).toMatchObject({ modelHint: { model: 'model-a', maxTokens: 120 } });
    expect(options[1]).toMatchObject({ modelHint: { model: 'model-b', maxTokens: 100 } });
    expect(options[2]).toMatchObject({ modelHint: { model: 'model-agg', maxTokens: 80 } });
  });

  it('stops when maxTokensPerRound is exhausted mid-round', async () => {
    const { provider, calls } = scriptedProvider([
      { purpose: 'reasoning', content: 'Voice one only', inputTokens: 30, outputTokens: 20 },
    ]);

    const result = await runDeliberation(provider, 'Per-round token cap', {
      caps: { maxRounds: 5, maxTotalTokens: 10_000, maxWallTimeMs: 20_000, maxTokensPerRound: 40 },
    });

    expect(result.stopReason).toBe('token_cap');
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0].voices).toHaveLength(1);
    expect(calls).toEqual(['reasoning']);
  });

  it('propagates structured origin metadata across deliberation voice and aggregator calls', async () => {
    const { provider, options } = scriptedProvider([
      { purpose: 'reasoning', content: 'Voice one', model: 'model-a', inputTokens: 10, outputTokens: 10 },
      { purpose: 'background', content: 'Voice two', model: 'model-b', inputTokens: 10, outputTokens: 10 },
      { purpose: 'reasoning', content: 'Synthesis output', model: 'model-agg', inputTokens: 10, outputTokens: 10 },
    ]);

    await runDeliberation(provider, 'Origin metadata check', {
      correlation: {
        turnId: 'turn-1',
        requestId: 'req-1',
        channelId: 'internal:heartbeat',
        callType: 'scheduled',
        originType: 'scheduled',
        originStage: 'heartbeat.deliberation',
        toolName: 'heartbeat_run_template',
        toolCallId: 'tool-77',
        purpose: 'heartbeat.deliberation',
      },
      caps: { maxRounds: 1, maxTotalTokens: 10_000, maxWallTimeMs: 20_000 },
    });

    expect(options[0]).toMatchObject({
      correlation: {
        turnId: 'turn-1',
        requestId: 'req-1',
        channelId: 'internal:heartbeat',
        callType: 'scheduled',
        originType: 'scheduled',
        originStage: 'deliberation.voice.reasoning',
        toolName: 'heartbeat_run_template',
        toolCallId: 'tool-77',
        purpose: 'deliberation.voice.reasoning',
      },
    });
    expect(options[2]).toMatchObject({
      correlation: {
        originStage: 'deliberation.aggregator',
        toolCallId: 'tool-77',
      },
    });
  });
});
