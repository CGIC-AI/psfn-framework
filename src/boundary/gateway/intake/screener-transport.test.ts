import { describe, expect, it } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import type { AssistantMessage, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';
import type { ProviderRuntime } from '../../../primitives/llm/provider-runtime.js';
import { LLMRequestCapability } from '../../../primitives/llm/client-request-capability.js';
import {
  callValidatedToolLessJsonScreener,
  type ScreenerBackend,
} from './screener-transport.js';

function model(provider: string, id: string): Model<'openai-completions'> {
  return fromAny({ provider, id, api: 'openai-completions' });
}

function assistant(provider: string, id: string, text: string): AssistantMessage {
  return fromAny({
    role: 'assistant',
    provider,
    model: id,
    api: 'openai-completions',
    content: [{ type: 'text', text }],
    stopReason: 'stop',
  });
}

describe('pi-ai intake screener transport', () => {
  it('dispatches a tool-less multimodal JSON call through the selected pi-ai provider', async () => {
    const selected = model('shared-router', 'vision/model');
    let capturedPayload: Record<string, unknown> | undefined;
    let capturedOptions: SimpleStreamOptions | undefined;
    let capturedContext: unknown;
    const runtime = fromAny<ProviderRuntime>({
      getModels: (provider: string) => provider === 'shared-router' ? [selected] : [],
      resolveProviderApiKey: (provider: string) => provider === 'shared-router' ? 'vault-key' : undefined,
      complete: async (
        _model: Model<'openai-completions'>,
        context: { tools?: unknown },
        options?: SimpleStreamOptions,
      ) => {
        expect(context.tools).toBeUndefined();
        capturedContext = context;
        capturedOptions = options;
        capturedPayload = fromAny(await options?.onPayload?.({
          model: selected.id,
          messages: [
            { role: 'system', content: 'classifier' },
            { role: 'user', content: 'placeholder' },
          ],
        }, selected));
        return assistant('shared-router', selected.id, '{"safe":true}');
      },
    });
    const backend: ScreenerBackend = {
      runtime,
      requestCapability: new LLMRequestCapability(fromAny({}), runtime),
    };
    const selectedRoute = fromAny({
      provider: 'shared-router',
      model: selected.id,
      maxTokens: 500,
    });

    const result = await callValidatedToolLessJsonScreener({
      backend,
      model: selectedRoute,
      timeoutMs: 5_000,
      maxOutputTokens: 200,
      systemPrompt: 'classifier',
      userMessage: [
        { type: 'text', text: 'inspect image' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
      ],
      screenerName: 'test screener',
      makeError: message => new Error(message),
      validateContent: content => JSON.parse(content) as { safe: boolean },
      isValidationError: () => false,
    });

    expect(result).toEqual({ safe: true });
    expect(capturedOptions).toMatchObject({
      apiKey: 'vault-key',
      maxRetries: 0,
      maxTokens: 200,
      temperature: 0,
    });
    expect(capturedPayload).toMatchObject({
      response_format: { type: 'json_object' },
    });
    expect(capturedContext).toMatchObject({
      systemPrompt: 'classifier',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'inspect image' },
          { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
        ],
      }],
    });
    expect(capturedPayload).not.toHaveProperty('tools');
    expect(capturedPayload).not.toHaveProperty('tool_choice');
    expect(capturedPayload).not.toHaveProperty('functions');
  });

  it('resolves each wire model through its own provider and fails closed without vault auth', async () => {
    const models = [model('router-a', 'model/a'), model('router-b', 'model/b')];
    const calledProviders: string[] = [];
    const runtime = fromAny<ProviderRuntime>({
      getModels: (provider: string) => models.filter(candidate => candidate.provider === provider),
      resolveProviderApiKey: (provider: string) => provider === 'router-a' ? 'key-a' : undefined,
      complete: async (selected: Model<'openai-completions'>) => {
        calledProviders.push(selected.provider);
        return assistant(selected.provider, selected.id, '{}');
      },
    });
    const backend: ScreenerBackend = {
      runtime,
      requestCapability: new LLMRequestCapability(fromAny({}), runtime),
    };
    const input = (provider: string, wireModel: string) => ({
      backend,
      model: fromAny({ provider, model: wireModel, maxTokens: 500 }),
      timeoutMs: 5_000,
      systemPrompt: 'classifier',
      userMessage: 'untrusted input',
      screenerName: 'test screener',
      makeError: (message: string) => new Error(message),
      validateContent: (content: string) => JSON.parse(content) as object,
      isValidationError: () => false,
    });

    await expect(callValidatedToolLessJsonScreener(input('router-a', 'model/a'))).resolves.toEqual({});
    await expect(callValidatedToolLessJsonScreener(input('router-b', 'model/b')))
      .rejects.toThrow(/router-b.*no gateway-resolved credential/i);
    expect(calledProviders).toEqual(['router-a']);
  });
});
