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

describe('discoverOpenRouterLogprobSupport', () => {
  it('derives per-endpoint logprob support from OpenRouter endpoint metadata', async () => {
    const mockFetch = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.endsWith('/models')) {
        return createJsonResponse({
          data: [
            {
              id: 'moonshotai/kimi-k2.5',
              name: 'MoonshotAI: Kimi K2.5',
              supported_parameters: ['logprobs', 'top_logprobs'],
            },
          ],
        });
      }
      if (url.endsWith('/models/moonshotai/kimi-k2.5/endpoints')) {
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
      probeMode: 'ambiguous',
      targets: [{ id: 'moonshotai/kimi-k2.5', group: 'key' }],
    });

    const model = result.models['moonshotai/kimi-k2.5'];
    expect(model.supported).toBe(true);
    expect(model.topLogprobsSupported).toBe(true);
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

  it('runs an exact-provider live probe when probe mode requires it', async () => {
    const mockFetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/models')) {
        return createJsonResponse({
          data: [
            {
              id: 'z-ai/glm-5',
              name: 'GLM-5',
              supported_parameters: ['logprobs', 'top_logprobs'],
            },
          ],
        });
      }
      if (url.endsWith('/models/z-ai/glm-5/endpoints')) {
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
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          provider?: { order?: string[] };
        };
        expect(body.provider?.order).toEqual(['inceptron/int4']);
        return createJsonResponse({
          id: 'chatcmpl-test',
          model: 'z-ai/glm-5',
          choices: [
            {
              logprobs: {
                content: [
                  {
                    token: 'ok',
                    logprob: -0.001,
                    top_logprobs: [{ token: 'ok', logprob: -0.001 }],
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
      targets: [{ id: 'z-ai/glm-5', group: 'key' }],
    });

    const provider = result.models['z-ai/glm-5'].providers[0];
    expect(provider.logprobs).toBe(true);
    expect(provider.topLogprobs).toBe(true);
    expect(provider.discoverySource).toBe('endpoint_metadata+live_probe');
    expect(provider.probe).toEqual(expect.objectContaining({
      attempted: true,
      status: 'supported',
      responseId: 'chatcmpl-test',
      responseModel: 'z-ai/glm-5',
    }));
  });
});
