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

function makeCapability(): LLMRequestCapability {
  return new LLMRequestCapability(
    {} as SubstrateConfig,
    {} as ProviderRuntime,
  );
}

function makeRequiredContext(): LLMContext {
  return {
    systemPrompt: 'system',
    messages: [{ role: 'user', content: 'Use notify to send this.' }],
    tools: [
      { name: 'notify', description: 'Notify', inputSchema: { type: 'object' } },
      { name: 'memory', description: 'Memory', inputSchema: { type: 'object' } },
    ],
  };
}

describe('LLMRequestCapability explicit tool dispatch', () => {
  it('lets pi-ai format an OpenRouter auto choice after exposing only the required tool', () => {
    const capability = makeCapability();
    const priorOnPayload = vi.fn(async (payload: unknown) => payload);
    const requestOptions: LLMRequestOptions = {
      onPayload: priorOnPayload,
      provider: { order: ['example-provider'] },
    };
    const context = makeRequiredContext();

    const contract = capability.applyExplicitToolChoice(
      requestOptions,
      context,
      { originStage: 'agent.turn.prompt' },
      { api: 'openai-completions' } as Model<'openai-completions'>,
      openRouterCandidate,
    );
    const piContext = capability.buildPiContext(context, contract);

    expect(contract).toEqual({
      choice: { type: 'function', function: { name: 'notify' } },
      requiredToolName: 'notify',
    });
    expect(requestOptions).toMatchObject({
      toolChoice: 'auto',
      requiredToolName: 'notify',
      explicitToolContract: contract,
      provider: { order: ['example-provider'] },
    });
    expect(requestOptions.onPayload).toBe(priorOnPayload);
    expect(piContext.tools?.map(tool => tool.name)).toEqual(['notify']);
  });

  it('lets pi-ai format direct Z.AI auto choice without a payload rewrite', () => {
    const capability = makeCapability();
    const requestOptions: LLMRequestOptions = {};
    const context = makeRequiredContext();

    const contract = capability.applyExplicitToolChoice(
      requestOptions,
      context,
      { originStage: 'agent.turn.prompt' },
      {
        api: 'openai-completions',
        baseUrl: 'https://api.z.ai/api/paas/v4',
      } as Model<'openai-completions'>,
      { provider: 'vega-testing', model: 'zai-code/zai/glm-5.2' } as RoutingCandidate,
    );

    expect(requestOptions.toolChoice).toBe('auto');
    expect(requestOptions.onPayload).toBeUndefined();
    expect(capability.buildPiContext(context, contract).tools?.map(tool => tool.name)).toEqual([
      'notify',
    ]);
  });

  it('removes tools and omits provider tool choice after the explicit sequence completes', () => {
    const capability = makeCapability();
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

    const contract = capability.applyExplicitToolChoice(
      requestOptions,
      context,
      { originStage: 'agent.turn.prompt' },
      { api: 'openai-completions' } as Model<'openai-completions'>,
      openRouterCandidate,
    );

    expect(contract).toEqual({ choice: 'none' });
    expect(requestOptions.toolChoice).toBeUndefined();
    expect(requestOptions.explicitToolContract).toEqual({ choice: 'none' });
    expect(requestOptions.onPayload).toBeUndefined();
    expect(capability.buildPiContext(context, contract).tools).toBeUndefined();
  });
});
