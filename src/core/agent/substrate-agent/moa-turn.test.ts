import { describe, expect, it, vi } from 'vitest';
import { runMoaTurn, type ResolvedMoaSettings } from './moa-turn.js';
import { runDeliberation } from '../../../primitives/llm/deliberation.js';
import type { LLMContext, ObservabilityCallType, SubstrateMessage } from '../../../shared/contracts/runtime.js';

vi.mock('../../../primitives/llm/deliberation.js', () => ({
  runDeliberation: vi.fn(),
}));

const mockedRunDeliberation = vi.mocked(runDeliberation);

describe('runMoaTurn', () => {
  it('uses neutral role labels in the MoA transcript', async () => {
    mockedRunDeliberation.mockResolvedValueOnce({
      sessionId: 'session-1',
      output: 'final answer',
      stopReason: 'max_rounds',
      rounds: [
        {
          index: 0,
          voices: [
            {
              purpose: 'reasoning',
              content: 'analysis',
              model: 'reasoning-model',
              inputTokens: 1,
              outputTokens: 1,
            },
          ],
          synthesis: 'final answer',
          novelty: 1,
          fatigue: 0,
          continueProbability: 0,
          inputTokens: 2,
          outputTokens: 1,
          durationMs: 1,
        },
      ],
      voices: ['reasoning'],
      caps: { maxRounds: 1, maxTotalTokens: 1, maxWallTimeMs: 1 },
      totalInputTokens: 2,
      totalOutputTokens: 1,
      totalTokens: 3,
      estimatedCostUsd: 0,
      startedAt: 0,
      endedAt: 1,
      durationMs: 1,
    });

    const context: LLMContext = {
      systemPrompt: 'You are a helper.',
      messages: [
        { role: 'user', content: 'Hello', timestamp: Date.now() },
        { role: 'assistant', content: 'Hi', timestamp: Date.now() },
      ],
    } as LLMContext;
    const settings: ResolvedMoaSettings = {
      maxRounds: 1,
      timeoutMs: 1_000,
      referenceModels: [],
    };
    const emitTelemetry = vi.fn();

    await runMoaTurn({
      llmClient: {} as any,
      context,
      message: { channelId: 'api:test' } as SubstrateMessage,
      settings,
      turnId: 'turn-1',
      requestId: 'req-1',
      callType: 'chat' as ObservabilityCallType,
      contextWindow: 1_000,
      emitTelemetry,
    });

    const prompt = mockedRunDeliberation.mock.calls[0]?.[1] as string;
    expect(prompt).toContain('user:\nHello');
    expect(prompt).toContain('assistant:\nHi');
  });
});
