import { describe, expect, it } from 'vitest';
import { fromAny } from '@total-typescript/shoehorn';
import type { AssistantMessage, Model, SimpleStreamOptions } from '@earendil-works/pi-ai';
import type { ProviderRuntime } from '../../../primitives/llm/provider-runtime.js';
import { LLMRequestCapability } from '../../../primitives/llm/client-request-capability.js';
import {
  callValidatedToolLessJsonScreener,
  classifyScreenerProviderFailure,
  screenerProviderRejection,
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


// ── Sampling-constraint and provider-rejection contract (psfn-framework-mlhn3) ──

function errorAssistant(provider: string, id: string, errorMessage: string): AssistantMessage {
  return fromAny({
    role: 'assistant',
    provider,
    model: id,
    api: 'openai-completions',
    content: [],
    stopReason: 'error',
    errorMessage,
  });
}

describe('screener sampling constraints from the model card', () => {
  async function capture(candidate: Record<string, unknown>): Promise<SimpleStreamOptions> {
    const selected = model('shared-router', 'card/model');
    let capturedOptions: SimpleStreamOptions | undefined;
    const runtime = fromAny<ProviderRuntime>({
      getModels: (provider: string) => provider === 'shared-router' ? [selected] : [],
      resolveProviderApiKey: () => 'vault-key',
      complete: async (
        _model: Model<'openai-completions'>,
        _context: unknown,
        options?: SimpleStreamOptions,
      ) => {
        capturedOptions = options;
        return assistant('shared-router', selected.id, '{}');
      },
    });
    await callValidatedToolLessJsonScreener({
      backend: {
        runtime,
        requestCapability: new LLMRequestCapability(fromAny({}), runtime),
      },
      model: fromAny({ provider: 'shared-router', model: selected.id, maxTokens: 500, ...candidate }),
      timeoutMs: 5_000,
      systemPrompt: 'classifier',
      userMessage: 'untrusted input',
      screenerName: 'test screener',
      makeError: (message: string) => new Error(message),
      validateContent: (content: string) => JSON.parse(content) as object,
      isValidationError: () => false,
    });
    if (!capturedOptions) throw new Error('screener did not dispatch');
    return capturedOptions;
  }

  it('pins temperature 0 for a card that declares no sampling constraint', async () => {
    expect(await capture({})).toMatchObject({ temperature: 0 });
  });

  it('OMITS temperature entirely for a card whose provider fixes it', async () => {
    const options = await capture({ rejectsTemperature: true });
    // Not "temperature: 1" — omission is the only portable way to accept the
    // provider's fixed value, and the rejecting provider 4xxs on the key itself.
    expect(options).not.toHaveProperty('temperature');
  });

  it('does not let a rejecting card\'s own tuning temperature leak back in', async () => {
    const options = await capture({ rejectsTemperature: true, temperature: 0.7 });
    expect(options).not.toHaveProperty('temperature');
  });

  it('keeps pinning 0 when the card explicitly declares it accepts temperature', async () => {
    expect(await capture({ rejectsTemperature: false, temperature: 0.7 }))
      .toMatchObject({ temperature: 0 });
  });
});

describe('screener provider failure classification', () => {
  it('classifies a leading 4xx parameter rejection as a configuration problem', () => {
    expect(classifyScreenerProviderFailure(
      '400: {"message":"invalid temperature: only 1 is allowed for this model"}',
    )).toEqual({ httpStatus: 400 });
    expect(classifyScreenerProviderFailure('422 Unprocessable Entity'))
      .toEqual({ httpStatus: 422 });
    expect(classifyScreenerProviderFailure('401: {"message":"bad key"}'))
      .toEqual({ httpStatus: 401 });
  });

  it('treats timeouts, rate limits, and provider faults as transient', () => {
    expect(classifyScreenerProviderFailure('408: request timeout')).toBeUndefined();
    expect(classifyScreenerProviderFailure('429: rate limited')).toBeUndefined();
    expect(classifyScreenerProviderFailure('503: upstream unavailable')).toBeUndefined();
  });

  it('does not read a status out of the middle of a provider body', () => {
    expect(classifyScreenerProviderFailure('connection reset (400 tokens seen)')).toBeUndefined();
    expect(classifyScreenerProviderFailure('socket hang up')).toBeUndefined();
    expect(classifyScreenerProviderFailure('')).toBeUndefined();
  });
});

describe('screener provider rejection marking', () => {
  async function failWith(errorMessage: string): Promise<unknown> {
    const selected = model('shared-router', 'card/model');
    const runtime = fromAny<ProviderRuntime>({
      getModels: (provider: string) => provider === 'shared-router' ? [selected] : [],
      resolveProviderApiKey: () => 'vault-key',
      complete: async () => errorAssistant('shared-router', selected.id, errorMessage),
    });
    try {
      await callValidatedToolLessJsonScreener({
        backend: {
          runtime,
          requestCapability: new LLMRequestCapability(fromAny({}), runtime),
        },
        model: fromAny({ provider: 'shared-router', model: selected.id, maxTokens: 500 }),
        timeoutMs: 5_000,
        systemPrompt: 'classifier',
        userMessage: 'untrusted input',
        screenerName: 'L2 screener',
        makeError: (message: string) => new Error(message),
        validateContent: (content: string) => JSON.parse(content) as object,
        isValidationError: () => false,
      });
    } catch (error) {
      return error;
    }
    throw new Error('screener call unexpectedly succeeded');
  }

  it('marks a 4xx parameter rejection on the error the caller receives', async () => {
    const error = await failWith(
      '400: {"message":"invalid temperature: only 1 is allowed for this model"}',
    );
    expect(screenerProviderRejection(error)).toEqual({ httpStatus: 400 });
  });

  it('leaves a provider fault unmarked so weather never raises a condition', async () => {
    expect(screenerProviderRejection(await failWith('503: upstream unavailable'))).toBeUndefined();
  });

  it('marks a transport-layer 4xx thrown out of the provider call', async () => {
    const selected = model('shared-router', 'card/model');
    const runtime = fromAny<ProviderRuntime>({
      getModels: (provider: string) => provider === 'shared-router' ? [selected] : [],
      resolveProviderApiKey: () => 'vault-key',
      complete: async () => {
        throw new Error('400 invalid temperature: only 1 is allowed for this model');
      },
    });
    let caught: unknown;
    try {
      await callValidatedToolLessJsonScreener({
        backend: {
          runtime,
          requestCapability: new LLMRequestCapability(fromAny({}), runtime),
        },
        model: fromAny({ provider: 'shared-router', model: selected.id, maxTokens: 500 }),
        timeoutMs: 5_000,
        systemPrompt: 'classifier',
        userMessage: 'untrusted input',
        screenerName: 'L2 screener',
        makeError: (message: string) => new Error(message),
        validateContent: (content: string) => JSON.parse(content) as object,
        isValidationError: () => false,
      });
    } catch (error) {
      caught = error;
    }
    expect(screenerProviderRejection(caught)).toEqual({ httpStatus: 400 });
  });
});
