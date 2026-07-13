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
    vi.unstubAllGlobals();
    await Promise.all(tempDirs.splice(0).map(async dir => {
      await rm(dir, { recursive: true, force: true });
    }));
  });

  it('persists one immutable event for every physical image provider attempt', async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), 'psfn-image-accounting-'));
    tempDirs.push(workspacePath);
    const usageEvents: ModelUsageEventInput[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://queue.fal.run/xai/grok-imagine-image') {
        const priorRequests = fetchMock.mock.calls.filter(([calledUrl]) => String(calledUrl) === url);
        if (priorRequests.length === 1) throw new TypeError('fetch failed');
        return jsonResponse({
          status: 'COMPLETED',
          request_id: 'image-request-1',
          response_url: 'https://queue.fal.run/xai/grok-imagine-image/requests/image-request-1',
        });
      }
      if (url === 'https://queue.fal.run/xai/grok-imagine-image/requests/image-request-1') {
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
    await handler({ prompt: 'a lighthouse at dusk', sourceToolName: 'image_create' });

    expect(usageEvents).toHaveLength(2);
    expect(usageEvents.map(event => event.logicalCallId)).toEqual([
      usageEvents[0]?.logicalCallId,
      usageEvents[0]?.logicalCallId,
    ]);
    expect(usageEvents).toMatchObject([
      {
        attempt: 1,
        status: 'failure',
        settlement: 'unknown',
        provider: 'fal',
        model: 'xai/grok-imagine-image',
        requestedProvider: 'auto',
        requestedModel: 'default',
        costSource: 'none',
      },
      {
        attempt: 2,
        status: 'success',
        settlement: 'unknown',
        provider: 'fal',
        model: 'xai/grok-imagine-image',
        requestedProvider: 'auto',
        requestedModel: 'default',
        costSource: 'none',
        metadata: {
          costAvailability: 'unknown_provider_not_exposed',
        },
      },
    ]);
  });
});
