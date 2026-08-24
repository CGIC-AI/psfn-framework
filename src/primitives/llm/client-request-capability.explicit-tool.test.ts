import { describe, expect, it, vi } from 'vitest';
import type { Model } from '@earendil-works/pi-ai';
import type { LLMContext } from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { LLMRequestCapability, type LLMRequestOptions } from './client-request-capability.js';
import type { ProviderRuntime } from './provider-runtime.js';

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
  it('lets pi-ai require the sole exposed OpenRouter tool', () => {
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
    );
    const piContext = capability.buildPiContext(context, contract);

    expect(contract).toEqual({
      choice: { type: 'function', function: { name: 'notify' } },
      requiredToolName: 'notify',
    });
    expect(requestOptions).toMatchObject({
      toolChoice: 'required',
      requiredToolName: 'notify',
      explicitToolContract: contract,
      provider: { order: ['example-provider'] },
    });
    expect(requestOptions.onPayload).toBe(priorOnPayload);
    expect(piContext.tools?.map(tool => tool.name)).toEqual(['notify']);
  });

  it('lets pi-ai require the sole exposed direct Z.AI tool without a payload rewrite', () => {
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
    );

    expect(requestOptions.toolChoice).toBe('required');
    expect(requestOptions.onPayload).toBeUndefined();
    expect(capability.buildPiContext(context, contract).tools?.map(tool => tool.name)).toEqual([
      'notify',
    ]);
  });

  it('disables Kimi Code reasoning for a required tool without changing GLM', () => {
    const capability = makeCapability();
    const context = makeRequiredContext();
    const kimiOptions: LLMRequestOptions = { reasoning: 'medium' };
    const glmOptions: LLMRequestOptions = { reasoning: 'medium' };

    capability.applyExplicitToolChoice(
      kimiOptions,
      context,
      { originStage: 'agent.turn.prompt' },
      {
        api: 'openai-completions',
        baseUrl: 'https://api.kimi.com/coding/v1',
      } as Model<'openai-completions'>,
    );
    capability.applyExplicitToolChoice(
      glmOptions,
      context,
      { originStage: 'agent.turn.prompt' },
      {
        api: 'openai-completions',
        baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      } as Model<'openai-completions'>,
    );

    expect(kimiOptions.toolChoice).toBe('required');
    expect(kimiOptions.reasoning).toBeUndefined();
    expect(glmOptions).toMatchObject({
      toolChoice: 'required',
      reasoning: 'medium',
    });
  });

  it('gives pi-ai an exact model schema for an exact-arguments request', () => {
    const capability = makeCapability();
    const requestOptions: LLMRequestOptions = {};
    const context: LLMContext = {
      systemPrompt: 'system',
      messages: [{
        role: 'user',
        content: 'Call repo exactly once with arguments {"action":"branch"}.',
      }],
      tools: [{
        name: 'repo',
        description: 'Repository operations',
        inputSchema: {
          anyOf: [
            { type: 'object', properties: { action: { const: 'inspect' } } },
            { type: 'object', properties: { action: { const: 'branch' } } },
          ],
        },
      }],
    };

    const contract = capability.applyExplicitToolChoice(
      requestOptions,
      context,
      { originStage: 'agent.turn.prompt' },
      { api: 'openai-completions' } as Model<'openai-completions'>,
    );

    expect(contract).toMatchObject({
      requiredToolName: 'repo',
      expectedArguments: { action: 'branch' },
    });
    expect(capability.buildPiContext(context, contract).tools?.[0]?.parameters).toEqual({
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['branch'] },
      },
      required: ['action'],
      additionalProperties: false,
    });
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
    );

    expect(contract).toEqual({ choice: 'none' });
    expect(requestOptions.toolChoice).toBeUndefined();
    expect(requestOptions.explicitToolContract).toEqual({ choice: 'none' });
    expect(requestOptions.onPayload).toBeUndefined();
    expect(capability.buildPiContext(context, contract).tools).toBeUndefined();
  });
});
