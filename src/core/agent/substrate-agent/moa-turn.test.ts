import { describe, expect, it, vi } from 'vitest';
import { runMoaTurn, type ResolvedMoaSettings } from './moa-turn.js';
import { runDeliberation } from '../../../primitives/llm/deliberation.js';
import type { LLMContext, ObservabilityCallType, SubstrateMessage } from '../../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { ChargePolicyConfig } from '../../../system/config/charge-policy-config.js';

vi.mock('../../../primitives/llm/deliberation.js', () => ({
  runDeliberation: vi.fn(),
}));

const mockedRunDeliberation = vi.mocked(runDeliberation);

function makeChargePolicy(): ChargePolicyConfig {
  return {
    schemaVersion: 1,
    runChargeQuotaByLane: {
      interactive: 100,
      background: 100,
      maintenance: 0,
      subagent: 100,
      shard: 100,
    },
    surfaceCosts: {
      ownerFileInspection: 0,
      localFilesystem: 0,
      memoryRead: 0,
      memoryWrite: 0,
      localEmbedding: 0,
      externalEmbedding: 0,
      localImageGeneration: 0,
      paidImageGeneration: 6,
      thinkExtensionBand: 1,
      subagentLaunch: 1,
      shardLaunch: 8,
      externalModelConsult: 1,
      moaRoundBase: 1,
    },
    moa: {
      perRoundMultiplierByReferenceModelClass: {
        local: 1,
        subscription: 1,
        cheap_cloud: 1,
        premium_cloud: 2,
      },
    },
    referenceModelClassPricing: {
      local: 0,
      subscription: 0,
      cheap_cloud: 1,
      premium_cloud: 4,
    },
  };
}

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
      config: {} as SubstrateConfig,
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

  it('emits base round and consult charge events for MoA deliberation', async () => {
    mockedRunDeliberation.mockResolvedValueOnce({
      sessionId: 'session-2',
      output: 'final answer',
      stopReason: 'max_rounds',
      rounds: [
        {
          index: 0,
          voices: [
            {
              purpose: 'reasoning',
              content: 'analysis',
              model: 'openrouter/cheap-model',
              inputTokens: 1,
              outputTokens: 1,
            },
          ],
          synthesis: 'final answer',
          aggregatorModel: 'openrouter/premium-model',
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

    const emitted: Array<[string, Record<string, unknown>]> = [];
    const emitTelemetry = vi.fn((eventName: string, payload: Record<string, unknown>) => {
      emitted.push([eventName, payload]);
    });

    await runMoaTurn({
      llmClient: {} as any,
      context: {
        systemPrompt: 'You are a helper.',
        messages: [],
      } as LLMContext,
      message: { channelId: 'api:test' } as SubstrateMessage,
      settings: {
        maxRounds: 1,
        timeoutMs: 1_000,
        referenceModels: ['openrouter/cheap-model'],
        aggregatorModel: 'openrouter/premium-model',
      },
      config: {
        chargePolicy: makeChargePolicy(),
      } as SubstrateConfig,
      turnId: 'turn-2',
      requestId: 'req-2',
      callType: 'chat' as ObservabilityCallType,
      contextWindow: 1_000,
      emitTelemetry,
    });

    const chargeEvents = emitted.filter(([eventName]) => eventName === 'agent.charge');
    expect(chargeEvents.map(([, payload]) => (payload as any).surface)).toEqual([
      'moaRoundBase',
      'externalModelConsult',
      'externalModelConsult',
    ]);
  });
});
