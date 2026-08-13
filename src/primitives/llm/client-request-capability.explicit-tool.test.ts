import { describe, expect, it, vi } from 'vitest';
import type { Model } from '@earendil-works/pi-ai';
import type { LLMContext } from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { LLMRequestCapability, type LLMRequestOptions } from './client-request-capability.js';
import type { ProviderRuntime } from './provider-runtime.js';

describe('LLMRequestCapability explicit tool payload', () => {
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
    );

    expect(requestOptions.toolChoice).toBe('required');
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
      tool_choice: 'required',
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
        },
      ] as LLMContext['messages'],
      tools: [{ name: 'notify', description: 'Notify', inputSchema: { type: 'object' } }],
    };

    capability.applyExplicitToolChoice(
      requestOptions,
      context,
      { originStage: 'agent.turn.prompt' },
      { api: 'openai-completions' } as Model<'openai-completions'>,
    );

    expect(requestOptions.toolChoice).toBe('none');
    expect(await requestOptions.onPayload?.(
      { model: 'example', messages: [] },
      { api: 'openai-completions' } as Model<'openai-completions'>,
    )).toEqual({
      model: 'example',
      messages: [],
      tool_choice: 'none',
    });
  });
});
