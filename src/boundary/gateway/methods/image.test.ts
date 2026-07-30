import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelUsageEventInput } from '../../../shared/telemetry/model-usage.js';
import type { GatewayMethodRuntime } from './types.js';
import { registerImageMethods } from './image.js';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('registerImageMethods model usage accounting', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await Promise.all(tempDirs.splice(0).map(async dir => {
      await rm(dir, { recursive: true, force: true });
    }));
  });

  it('fails pricing admission before invoking a paid image provider', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'psfn-image-accounting-preflight-'));
    tempDirs.push(workspacePath);
    const usageEvents: ModelUsageEventInput[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://api.fal.ai/v1/models/pricing/estimate') {
        return jsonResponse({ detail: 'pricing unavailable' });
      }
      throw new Error(`Paid provider must not run after failed pricing admission: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const methods = new Map<string, (params: unknown) => Promise<unknown>>();
    const runtime = {
      target: {
        addMethod(name: string, handler: (params: unknown) => Promise<unknown>) {
          methods.set(name, handler);
        },
      },
      audited: (_method: string, handler: (params: unknown) => Promise<unknown>) => handler,
      imageConfig: { falApiKey: 'fal-key' },
      workspacePath,
      modelUsageRecorder: {
        async recordUsageEvent(event: ModelUsageEventInput) {
          usageEvents.push(event);
        },
      },
    } as unknown as GatewayMethodRuntime;
    registerImageMethods(runtime);

    const handler = methods.get('image.create');
    if (!handler) throw new Error('image.create was not registered');
    await expect(handler({
      prompt: 'an image that must be priced before generation',
      provider: 'fal',
      model: 'fal-ai/nano-banana-2',
    })).rejects.toThrow('Failed to preflight fal image provider attempt 1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(usageEvents).toEqual([]);
  });

  it('persists one immutable event for every physical image provider attempt', async () => {
    vi.useFakeTimers();
    const workspacePath = await mkdtemp(join(tmpdir(), 'psfn-image-accounting-'));
    tempDirs.push(workspacePath);
    const usageEvents: ModelUsageEventInput[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.fal.ai/v1/models/pricing/estimate') {
        return jsonResponse({
          estimate_type: 'unit_price',
          total_cost: 0.12,
          currency: 'USD',
        });
      }
      if (url === 'https://queue.fal.run/xai/grok-imagine-image') {
        const requestCount = fetchMock.mock.calls.filter(([calledUrl]) => String(calledUrl) === url).length;
        if (requestCount <= 2) throw new TypeError('fetch failed');
        return new Response(JSON.stringify({
          detail: [{
            type: 'content_policy_violation',
            msg: 'The image was flagged by a content checker.',
          }],
        }), {
          status: 422,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === 'https://queue.fal.run/fal-ai/nano-banana-2') {
        return jsonResponse({
          status: 'COMPLETED',
          request_id: 'image-request-1',
          response_url: 'https://queue.fal.run/fal-ai/nano-banana-2/requests/image-request-1',
        });
      }
      if (url === 'https://queue.fal.run/fal-ai/nano-banana-2/requests/image-request-1') {
        return jsonResponse({
          images: [{
            url: 'https://cdn.example.test/image-request-1.png',
            content_type: 'image/png',
            file_name: 'image-request-1.png',
          }],
        });
      }
      if (url === 'https://cdn.example.test/image-request-1.png') {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      if (url === 'https://comfy.example.test/prompt') {
        return jsonResponse({ prompt_id: 'comfy-fallback-1' });
      }
      if (url === 'https://comfy.example.test/history/comfy-fallback-1') {
        return jsonResponse({
          'comfy-fallback-1': {
            status: { status_str: 'success', completed: true },
            outputs: {
              '9': {
                images: [{ filename: 'comfy-fallback.png', subfolder: '', type: 'output' }],
              },
            },
          },
        });
      }
      if (url === 'https://comfy.example.test/view?filename=comfy-fallback.png&subfolder=&type=output') {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const methods = new Map<string, (params: unknown) => Promise<unknown>>();
    const runtime = {
      target: {
        addMethod(name: string, handler: (params: unknown) => Promise<unknown>) {
          methods.set(name, handler);
        },
      },
      audited: (_method: string, handler: (params: unknown) => Promise<unknown>) => handler,
      imageConfig: {
        falApiKey: 'fal-key',
        comfyUiBaseUrl: 'https://comfy.example.test',
        imageWorkflows: {
          comfyUi: {
            create: {
              workflow: {
                '1': {
                  class_type: 'PromptEcho',
                  inputs: { text: '{{prompt}}' },
                },
              },
            },
          },
        },
      },
      workspacePath,
      modelUsageRecorder: {
        async recordUsageEvent(event: ModelUsageEventInput) {
          usageEvents.push(event);
        },
      },
    } as unknown as GatewayMethodRuntime;
    registerImageMethods(runtime);

    const handler = methods.get('image.create');
    if (!handler) throw new Error('image.create was not registered');
    await handler({
      prompt: 'a lighthouse at dusk',
      sourceToolName: 'image_create',
      companionId: 'companion-a',
      sessionId: 'session-1',
      channelId: 'channel-1',
      channelType: 'discord',
      chargeLane: 'interactive',
      chargeSurface: 'paidImageGeneration',
      chargeEventId: 'charge-event-1',
      chargeRunId: 'run-1',
      conversationId: 'conversation-1',
      rootInitiationId: 'root-1',
    });

    const pricingCallIndex = (endpointId: string) => fetchMock.mock.calls.findIndex(
      ([calledUrl, init]) => {
        if (String(calledUrl) !== 'https://api.fal.ai/v1/models/pricing/estimate') return false;
        const body = JSON.parse(String(init?.body)) as { endpoints?: Record<string, unknown> };
        return Object.hasOwn(body.endpoints ?? {}, endpointId);
      },
    );
    const queueCallIndex = (endpointId: string) => fetchMock.mock.calls.findIndex(
      ([calledUrl]) => String(calledUrl) === `https://queue.fal.run/${endpointId}`,
    );
    expect(pricingCallIndex('xai/grok-imagine-image')).toBeLessThan(
      queueCallIndex('xai/grok-imagine-image'),
    );
    expect(pricingCallIndex('fal-ai/nano-banana-2')).toBeLessThan(
      queueCallIndex('fal-ai/nano-banana-2'),
    );

    expect(usageEvents).toHaveLength(3);
    expect(usageEvents.map(event => event.logicalCallId)).toEqual([
      usageEvents[0]?.logicalCallId,
      usageEvents[0]?.logicalCallId,
      usageEvents[0]?.logicalCallId,
    ]);
    expect(usageEvents).toMatchObject([
      {
        attempt: 1,
        status: 'failure',
        settlement: 'unknown',
        attribution: {
          companionId: 'companion-a',
          sessionId: 'session-1',
          channelId: 'channel-1',
          channelType: 'discord',
          toolName: 'image_create',
          chargeLane: 'interactive',
          chargeSurface: 'paidImageGeneration',
          chargeEventId: 'charge-event-1',
          chargeRunId: 'run-1',
          conversationId: 'conversation-1',
          rootInitiationId: 'root-1',
        },
        provider: 'fal',
        model: 'xai/grok-imagine-image',
        requestedProvider: 'auto',
        requestedModel: 'default',
        costSource: 'none',
      },
      {
        attempt: 2,
        status: 'failure',
        settlement: 'unknown',
        provider: 'fal',
        model: 'xai/grok-imagine-image',
        requestedProvider: 'auto',
        requestedModel: 'default',
        costSource: 'none',
      },
      {
        attempt: 3,
        status: 'success',
        settlement: 'complete',
        provider: 'fal',
        model: 'fal-ai/nano-banana-2',
        requestedProvider: 'auto',
        requestedModel: 'default',
        estimatedCostUsd: 0.12,
        effectiveCostUsd: 0.12,
        costSource: 'estimate',
        currency: 'USD',
        metadata: {
          costAvailability: 'fal_unit_price_estimate',
          costEstimateEndpointId: 'fal-ai/nano-banana-2',
          costEstimateUnitQuantity: 1,
          fallbackUsed: true,
          fallbackReason: 'fal_transient_model_fallback',
        },
      },
    ]);

    const comfyFallbackPromise = handler({
      prompt: 'a lighthouse rejected by the content checker',
      sourceToolName: 'image_create',
    });
    await vi.runAllTimersAsync();
    await comfyFallbackPromise;

    const comfyFallbackEvents = usageEvents.slice(-2);
    expect(comfyFallbackEvents.map(event => event.logicalCallId)).toEqual([
      comfyFallbackEvents[0]?.logicalCallId,
      comfyFallbackEvents[0]?.logicalCallId,
    ]);
    expect(comfyFallbackEvents).toMatchObject([
      {
        attempt: 1,
        status: 'failure',
        attribution: { chargeSurface: 'paidImageGeneration' },
        provider: 'fal',
        model: 'xai/grok-imagine-image',
      },
      {
        attempt: 2,
        status: 'success',
        attribution: { chargeSurface: 'localImageGeneration' },
        provider: 'comfyui',
        model: 'configured:create',
        metadata: {
          fallbackUsed: true,
          fallbackReason: 'fal_content_policy_422',
        },
      },
    ]);
  });

  it('records settings-default intent while preserving explicit model precedence', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'psfn-image-accounting-defaults-'));
    tempDirs.push(workspacePath);
    const usageEvents: ModelUsageEventInput[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.fal.ai/v1/models/pricing/estimate') {
        const body = JSON.parse(String(init?.body)) as {
          endpoints: Record<string, { unit_quantity: number }>;
        };
        const unitQuantity = Object.values(body.endpoints)[0]!.unit_quantity;
        return jsonResponse({
          estimate_type: 'unit_price',
          total_cost: unitQuantity * 0.08,
          currency: 'USD',
        });
      }
      const queueMatch = /^https:\/\/queue\.fal\.run\/(.+)$/u.exec(url);
      if (queueMatch && !url.includes('/requests/')) {
        const model = queueMatch[1]!;
        const requestId = model.replaceAll('/', '-');
        return jsonResponse({
          status: 'COMPLETED',
          request_id: requestId,
          response_url: `https://queue.fal.run/${model}/requests/${requestId}`,
        });
      }
      const resultMatch = /^https:\/\/queue\.fal\.run\/(.+)\/requests\/([^/]+)$/u.exec(url);
      if (resultMatch) {
        const requestId = resultMatch[2]!;
        const imageCount = requestId === 'fal-ai-nano-banana-2' ? 4 : 1;
        return jsonResponse({
          images: Array.from({ length: imageCount }, (_, index) => ({
            url: `https://cdn.example.test/${requestId}-${String(index + 1)}.png`,
            content_type: 'image/png',
            file_name: `${requestId}-${String(index + 1)}.png`,
          })),
        });
      }
      if (url.startsWith('https://cdn.example.test/')) {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const methods = new Map<string, (params: unknown) => Promise<unknown>>();
    const runtime = {
      target: {
        addMethod(name: string, handler: (params: unknown) => Promise<unknown>) {
          methods.set(name, handler);
        },
      },
      audited: (_method: string, handler: (params: unknown) => Promise<unknown>) => handler,
      imageConfig: { falApiKey: 'fal-key' },
      workspacePath,
      modelUsageRecorder: {
        async recordUsageEvent(event: ModelUsageEventInput) {
          usageEvents.push(event);
        },
      },
    } as unknown as GatewayMethodRuntime;
    registerImageMethods(runtime);

    const handler = methods.get('image.create');
    if (!handler) throw new Error('image.create was not registered');
    await handler({
      prompt: 'settings-selected image',
      numImages: 4,
      settingsDefaults: {
        provider: 'fal',
        model: 'fal-ai/nano-banana-2',
      },
    });
    await handler({
      prompt: 'explicit model-selected image',
      model: 'xai/grok-imagine-image',
      settingsDefaults: {
        provider: 'comfyui',
        model: 'fal-ai/nano-banana-2',
      },
    });

    expect(usageEvents).toMatchObject([
      {
        provider: 'fal',
        model: 'fal-ai/nano-banana-2',
        requestedProvider: 'fal',
        requestedModel: 'fal-ai/nano-banana-2',
        estimatedCostUsd: 0.32,
        effectiveCostUsd: 0.32,
        costSource: 'estimate',
        metadata: {
          imageCount: 4,
          costEstimateUnitQuantity: 4,
        },
      },
      {
        provider: 'fal',
        model: 'xai/grok-imagine-image',
        requestedProvider: 'fal',
        requestedModel: 'xai/grok-imagine-image',
        estimatedCostUsd: 0.08,
        effectiveCostUsd: 0.08,
        costSource: 'estimate',
        metadata: {
          imageCount: 1,
          costEstimateUnitQuantity: 1,
        },
      },
    ]);
  });

});
