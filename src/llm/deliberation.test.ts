import { describe, expect, it, vi } from 'vitest';
import type { LLMProvider } from '../agent/contracts.js';
import type { CompletionPurpose, LLMContext, LLMResponse, StreamCallbacks } from '../types.js';
import { runDeliberation } from './deliberation.js';

interface ScriptedStep {
  purpose: CompletionPurpose;
  content: string;
  inputTokens?: number;
  outputTokens?: number;
  delayMs?: number;
}

function mockResponse(step: ScriptedStep): LLMResponse {
  return {
    content: step.content,
    toolCalls: [],
    model: `mock-${step.purpose}`,
    inputTokens: step.inputTokens ?? 12,
    outputTokens: step.outputTokens ?? 24,
    stopReason: 'stop',
  };
}

function scriptedProvider(steps: ScriptedStep[]): {
  provider: LLMProvider;
  calls: CompletionPurpose[];
} {
  const calls: CompletionPurpose[] = [];
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
    complete: vi.fn(async (_context: LLMContext, purpose: CompletionPurpose) => {
      calls.push(purpose);
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

  return { provider, calls };
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
});
