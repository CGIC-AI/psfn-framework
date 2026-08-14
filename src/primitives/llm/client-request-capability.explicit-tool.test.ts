import { describe, expect, it, vi } from 'vitest';
import type { Model } from '@earendil-works/pi-ai';
import type { LLMContext } from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { LLMRequestCapability, type LLMRequestOptions } from './client-request-capability.js';
import type { ProviderRuntime } from './provider-runtime.js';
import type { RoutingCandidate } from './routing.js';

const openRouterCandidate = {
  provider: 'openrouter',
  model: 'example',
} as RoutingCandidate;

describe('LLMRequestCapability explicit tool payload', () => {
  it('uses Z.AI auto choice with one exposed tool and retains the exact postcondition', async () => {
    const capability = new LLMRequestCapability(
      {} as SubstrateConfig,
      {} as ProviderRuntime,
    );
    const requestOptions: LLMRequestOptions = {};
    const context: LLMContext = {
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'Use notify to send this.' }],
      tools: [
        { name: 'notify', description: 'Notify', inputSchema: { type: 'object' } },
        { name: 'memory', description: 'Memory', inputSchema: { type: 'object' } },
      ],
    };

    capability.applyExplicitToolChoice(
      requestOptions,
      context,
      { originStage: 'agent.turn.prompt' },
      {
        api: 'openai-completions',
        baseUrl: 'https://api.z.ai/api/paas/v4',
      } as Model<'openai-completions'>,
      { provider: 'vega-testing', model: 'zai-code/zai/glm-5.2' } as RoutingCandidate,
    );

    expect(requestOptions.toolChoice).toEqual({
      type: 'function',
      function: { name: 'notify' },
    });
    expect(requestOptions.requiredToolName).toBe('notify');
    expect(await requestOptions.onPayload?.({
      model: 'zai-code/zai/glm-5.2',
      messages: [],
      tools: [
        { type: 'function', function: { name: 'notify' } },
        { type: 'function', function: { name: 'memory' } },
      ],
    }, {
      api: 'openai-completions',
    } as Model<'openai-completions'>)).toEqual({
      model: 'zai-code/zai/glm-5.2',
      messages: [],
      tools: [{ type: 'function', function: { name: 'notify' } }],
      tool_choice: 'auto',
      parallel_tool_calls: false,
    });
  });

  it('injects the named choice into the final OpenAI completions wire payload', async () => {
    const capability = new LLMRequestCapability(
      {} as SubstrateConfig,
      {} as ProviderRuntime,
    );
    const priorOnPayload = vi.fn(async (payload: unknown) => ({
      ...(payload as Record<string, unknown>),
      transformed: true,
    }));
    const requestOptions: LLMRequestOptions = { onPayload: priorOnPayload };
    const context: LLMContext = {
      systemPrompt: 'system',
      messages: [{ role: 'user', content: 'Use notify to send this.' }],
      tools: [{ name: 'notify', description: 'Notify', inputSchema: { type: 'object' } }],
    };

    capability.applyExplicitToolChoice(
      requestOptions,
      context,
      { originStage: 'agent.turn.prompt' },
      { api: 'openai-completions' } as Model<'openai-completions'>,
      openRouterCandidate,
    );

    expect(requestOptions.toolChoice).toEqual({
      type: 'function',
      function: { name: 'notify' },
    });
    expect(requestOptions.requiredToolName).toBe('notify');
    expect(await requestOptions.onPayload?.(
      {
        model: 'example',
        messages: [],
        tools: [
          { type: 'function', function: { name: 'notify' } },
          { type: 'function', function: { name: 'north_star' } },
        ],
      },
      { api: 'openai-completions' } as Model<'openai-completions'>,
    )).toEqual({
      model: 'example',
      messages: [],
      tools: [{ type: 'function', function: { name: 'notify' } }],
      transformed: true,
      provider: { require_parameters: true },
      tool_choice: { type: 'function', function: { name: 'notify' } },
      parallel_tool_calls: false,
    });
    expect(priorOnPayload).toHaveBeenCalledOnce();
  });

  it('injects none after the requested tool sequence is complete', async () => {
    const capability = new LLMRequestCapability(
      {} as SubstrateConfig,
      {} as ProviderRuntime,
    );
    const requestOptions: LLMRequestOptions = {};
    const context: LLMContext = {
      systemPrompt: 'system',
      messages: [
        { role: 'user', content: 'Use notify to send this.' },
        {
          role: 'toolResult',
          toolCallId: 'notify-1',
          toolName: 'notify',
          content: 'sent',
          outcome: 'success',
          isError: false,
        },
      ] as LLMContext['messages'],
      tools: [{ name: 'notify', description: 'Notify', inputSchema: { type: 'object' } }],
    };

    capability.applyExplicitToolChoice(
      requestOptions,
      context,
      { originStage: 'agent.turn.prompt' },
      { api: 'openai-completions' } as Model<'openai-completions'>,
      openRouterCandidate,
    );

    expect(requestOptions.toolChoice).toBe('none');
    expect(await requestOptions.onPayload?.(
      { model: 'example', messages: [] },
      { api: 'openai-completions' } as Model<'openai-completions'>,
    )).toEqual({
      model: 'example',
      messages: [],
      provider: { require_parameters: true },
      tool_choice: 'none',
    });
  });
});
