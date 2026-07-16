import { describe, expect, it, vi } from 'vitest';
import type {
  CompletionPurpose,
  LLMContext,
  LLMResponse,
  SubstrateMessage,
} from '../../../shared/contracts/runtime.js';
import type {
  LLMProviderCompletionOptions,
  LLMProviderPort,
} from '../contracts.js';
import { createTurnId } from '../../turns/id.js';
import { buildMoaPrompt, runMoaTurn } from './moa-turn.js';

describe('runMoaTurn provider prompt authority', () => {
  it('keeps the canonical system prefix on every voice and aggregator request without demoting it into user content', async () => {
    const authoritativeSystemPrompt = [
      '<immutable_human_safety_amendments>POLICY_SENTINEL</immutable_human_safety_amendments>',
      '<identity>IDENTITY_SENTINEL</identity>',
      '<runtime_emotional_affect>AFFECT_SENTINEL</runtime_emotional_affect>',
    ].join('\n\n');
    const context: LLMContext = {
      systemPrompt: `${authoritativeSystemPrompt}\n\nSESSION_CONTEXT_SENTINEL`,
      sessionPromptBlocks: [{
        id: 'memory.retrieval',
        content: 'SESSION_CONTEXT_SENTINEL',
      }],
      messages: [
        { role: 'user', content: 'EARLIER_USER_SENTINEL' },
        { role: 'assistant', content: 'EARLIER_ASSISTANT_SENTINEL' },
      ],
    };
    const currentTurn: Parameters<typeof buildMoaPrompt>[1] = {
      role: 'user',
      content: 'CURRENT_TURN_SENTINEL',
    };
    const prompt = buildMoaPrompt(context, currentTurn);
    const providerContexts: LLMContext[] = [];
    const providerOptions: Array<LLMProviderCompletionOptions | undefined> = [];
    const scriptedModels = ['model-ref-a', 'model-ref-b', 'model-agg'];
    const scriptedContent = ['Reference voice A', 'Reference voice B', 'Synthesized MoA reply'];
    let completionIndex = 0;
    const llmClient: LLMProviderPort = {
      stream: vi.fn(async () => ({
        content: '',
        toolCalls: [],
        model: 'mock-stream',
        inputTokens: 0,
        outputTokens: 0,
        stopReason: 'stop',
      } satisfies LLMResponse)),
      complete: vi.fn(async (
        providerContext: LLMContext,
        _purpose: CompletionPurpose,
        options?: LLMProviderCompletionOptions,
      ) => {
        const model = scriptedModels[completionIndex];
        const content = scriptedContent[completionIndex];
        if (!model || !content) {
          throw new Error(`Unexpected MoA completion ${String(completionIndex + 1)}`);
        }
        completionIndex += 1;
        providerContexts.push(providerContext);
        providerOptions.push(options);
        return {
          content,
          toolCalls: [],
          model,
          inputTokens: 10,
          outputTokens: 10,
          stopReason: 'stop',
        } satisfies LLMResponse;
      }),
    };
    const message: SubstrateMessage = {
      id: 'message-1',
      channelId: 'api:test',
      channelType: 'api',
      authorId: 'user-1',
      authorName: 'User',
      content: currentTurn.content,
      timestamp: new Date('2026-07-16T02:00:00.000Z'),
      isDirectMessage: true,
    };

    const result = await runMoaTurn({
      llmClient,
      context,
      message,
      prompt,
      authoritativeSystemPrompt,
      settings: {
        maxRounds: 1,
        maxTokensPerRound: 120,
        timeoutMs: 30_000,
        referenceModels: ['model-ref-a', 'model-ref-b'],
        aggregatorModel: 'model-agg',
      },
      turnId: createTurnId(),
      requestId: 'request-1',
      callType: 'chat',
      contextWindow: 16_000,
      emitTelemetry: vi.fn(),
    });

    expect(prompt).toContain('SESSION_CONTEXT_SENTINEL');
    expect(prompt).toContain('EARLIER_USER_SENTINEL');
    expect(prompt).toContain('EARLIER_ASSISTANT_SENTINEL');
    expect(prompt).toContain('CURRENT_TURN_SENTINEL');
    expect(prompt).not.toContain('POLICY_SENTINEL');
    expect(prompt).not.toContain('IDENTITY_SENTINEL');
    expect(prompt).not.toContain('AFFECT_SENTINEL');

    expect(providerContexts).toHaveLength(3);
    for (const providerContext of providerContexts) {
      expect(providerContext.systemPrompt.startsWith(authoritativeSystemPrompt)).toBe(true);
      const userContent = providerContext.messages.map(entry => entry.content).join('\n\n');
      expect(userContent).not.toContain('POLICY_SENTINEL');
      expect(userContent).not.toContain('IDENTITY_SENTINEL');
      expect(userContent).not.toContain('AFFECT_SENTINEL');
      expect(userContent).toContain('CURRENT_TURN_SENTINEL');
    }
    expect(providerContexts[0]?.systemPrompt).toContain('analytical inner voice');
    expect(providerContexts[1]?.systemPrompt).toContain('intuitive inner voice');
    expect(providerContexts[2]?.systemPrompt).toContain('inner synthesis layer');
    expect(providerOptions[0]).toMatchObject({ modelHint: { model: 'model-ref-a', maxTokens: 120 } });
    expect(providerOptions[1]).toMatchObject({ modelHint: { model: 'model-ref-b', maxTokens: 100 } });
    expect(providerOptions[2]).toMatchObject({ modelHint: { model: 'model-agg', maxTokens: 80 } });
    expect(result.output).toBe('Synthesized MoA reply');
    expect(result.rounds).toBe(1);
  });
});
