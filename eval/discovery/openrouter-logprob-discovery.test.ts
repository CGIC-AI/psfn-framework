import { describe, expect, it, vi } from 'vitest';
import {
  discoverOpenRouterLogprobSupport,
  type ProbeMode,
} from './openrouter-logprob-discovery.js';

function createJsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function createSseResponse(chunks: unknown[]): Response {
  const body = chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join('')
    + 'data: [DONE]\n\n';
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
    },
  });
}

describe('discoverOpenRouterLogprobSupport', () => {
  it('keeps endpoint metadata when live probes are disabled', async () => {
    const mockFetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/models')) {
        return createJsonResponse({
          data: [
            {
              id: 'moonshotai/kimi-k2.6',
              name: 'MoonshotAI: Kimi K2.6',
              supported_parameters: ['logprobs', 'top_logprobs'],
            },
          ],
        });
      }
      if (url.endsWith('/models/moonshotai/kimi-k2.6/endpoints')) {
        return createJsonResponse({
          data: {
            endpoints: [
              {
                tag: 'deepinfra',
                provider_name: 'DeepInfra',
                status: 0,
                supported_parameters: ['logprobs', 'top_logprobs', 'max_tokens'],
              },
              {
                tag: 'chutes/int4',
                provider_name: 'Chutes',
                status: 0,
                supported_parameters: ['max_tokens', 'temperature'],
              },
            ],
          },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    const result = await discoverOpenRouterLogprobSupport({
      fetchFn: mockFetch,
      probeMode: 'none',
      targets: [{ id: 'moonshotai/kimi-k2.6', group: 'key' }],
    });

    const model = result.models['moonshotai/kimi-k2.6'];
    expect(result.schemaVersion).toBe(2);
    expect(model.supported).toBe(true);
    expect(model.topLogprobsSupported).toBe(true);
    expect(model.routerObservations).toEqual([]);
    expect(model.providers).toEqual([
      expect.objectContaining({
        id: 'chutes/int4',
        logprobs: false,
        topLogprobs: false,
        topLogprobsMax: 0,
      }),
      expect.objectContaining({
        id: 'deepinfra',
        logprobs: true,
        topLogprobs: true,
        topLogprobsMax: 20,
      }),
    ]);
  });

  it('runs canonical route layers and provider-pinned live probes', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const mockFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/models')) {
        return createJsonResponse({
          data: [
            {
              id: 'z-ai/glm-5.1',
              name: 'GLM 5.1',
              supported_parameters: ['logprobs', 'top_logprobs'],
            },
          ],
        });
      }
      if (url.endsWith('/models/z-ai/glm-5.1/endpoints')) {
        return createJsonResponse({
          data: {
            endpoints: [
              {
                tag: 'inceptron/int4',
                provider_name: 'Inceptron',
                status: 0,
                supported_parameters: ['logprobs', 'top_logprobs'],
              },
            ],
          },
        });
      }
      if (url.endsWith('/chat/completions')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        requestBodies.push(body);
        if (body.stream === true) {
          return createSseResponse([
            {
              id: 'chatcmpl-stream',
              model: 'z-ai/glm-5.1',
              choices: [
                {
                  logprobs: {
                    content: [
                      {
                        token: 'blue',
                        logprob: -0.001,
                        bytes: [98, 108, 117, 101],
                        top_logprobs: [
                          { token: 'blue', logprob: -0.001 },
                          { token: 'red', logprob: -6 },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
          ]);
        }
        return createJsonResponse({
          id: 'chatcmpl-test',
          model: 'z-ai/glm-5.1',
          provider: 'inceptron/int4',
          choices: [
            {
              logprobs: {
                content: [
                  {
                    token: 'blue',
                    logprob: -0.001,
                    bytes: [98, 108, 117, 101],
                    top_logprobs: [
                      { token: 'blue', logprob: -0.001 },
                      { token: 'red', logprob: -6 },
                    ],
                  },
                ],
              },
            },
          ],
        });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    const result = await discoverOpenRouterLogprobSupport({
      fetchFn: mockFetch,
      apiKey: 'test-key',
      probeMode: 'supported' satisfies ProbeMode,
      targets: [{ id: 'z-ai/glm-5.1', group: 'key' }],
    });

    const model = result.models['z-ai/glm-5.1'];
    const provider = model.providers[0];
    expect(model.routerObservations).toHaveLength(14);
    expect(provider.observations).toHaveLength(7);
    expect(provider.logprobs).toBe(true);
    expect(provider.topLogprobs).toBe(true);
    expect(provider.streamingLogprobs).toBe(true);
    expect(provider.bytesOrTokenTextIncluded).toBe(true);
    expect(provider.generatedLogprobs).toBe('yes');
    expect(provider.observedStatus).toBe('Top-k works');
    expect(provider.discoverySource).toBe('live_probe');
    expect(provider.probe).toEqual(expect.objectContaining({
      attempted: true,
      status: 'supported',
      responseModel: 'z-ai/glm-5.1',
    }));
    expect(result.engineerView.length).toBeGreaterThan(0);
    expect(result.useCaseView).toEqual(expect.arrayContaining([
      expect.objectContaining({ useCase: 'Cheap label confidence' }),
    ]));

    expect(requestBodies.some((body) => body.provider === undefined)).toBe(true);
    expect(requestBodies.some((body) => {
      const providerBody = body.provider as { allow_fallbacks?: boolean; require_parameters?: boolean } | undefined;
      return providerBody?.allow_fallbacks === false && providerBody.require_parameters === true;
    })).toBe(true);
    expect(requestBodies.some((body) => {
      const providerBody = body.provider as { order?: string[]; only?: string[]; allow_fallbacks?: boolean } | undefined;
      return providerBody?.order?.[0] === 'inceptron/int4'
        && providerBody.only?.[0] === 'inceptron/int4'
        && providerBody.allow_fallbacks === false;
    })).toBe(true);
  });
});
