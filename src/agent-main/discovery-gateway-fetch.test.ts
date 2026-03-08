import { describe, expect, it, vi } from 'vitest';
import { createGatewayBackedDiscoveryFetch } from './discovery-gateway-fetch.js';

describe('createGatewayBackedDiscoveryFetch', () => {
  it('routes discovery fetch requests through gateway web.fetch_binary', async () => {
    const gateway = {
      webFetchBinary: vi.fn(async () => ({
        dataBase64: Buffer.from(JSON.stringify({ data: [{ id: 'openai/gpt-4.1-mini' }] })).toString('base64'),
        mimeType: 'application/json',
        sizeBytes: 44,
      })),
    };

    const fetchFn = createGatewayBackedDiscoveryFetch(gateway);
    const response = await fetchFn('https://proxy.example/v1/models', {
      headers: {
        Authorization: 'Bearer litellm-key',
      },
    });

    expect(gateway.webFetchBinary).toHaveBeenCalledWith(
      'https://proxy.example/v1/models',
      expect.objectContaining({
        lane: 'default',
        maxBytes: 2 * 1024 * 1024,
        headers: expect.objectContaining({
          authorization: 'Bearer litellm-key',
        }),
      }),
    );
    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toEqual({ data: [{ id: 'openai/gpt-4.1-mini' }] });
  });

  it('rejects non-GET requests', async () => {
    const gateway = {
      webFetchBinary: vi.fn(),
    };
    const fetchFn = createGatewayBackedDiscoveryFetch(gateway);

    await expect(fetchFn('https://proxy.example/v1/models', { method: 'POST' }))
      .rejects
      .toThrow('Gateway-backed discovery fetch only supports GET requests.');
    expect(gateway.webFetchBinary).not.toHaveBeenCalled();
  });

  it('filters restricted header overrides before gateway call', async () => {
    const gateway = {
      webFetchBinary: vi.fn(async () => ({
        dataBase64: '',
        mimeType: 'application/json',
        sizeBytes: 0,
      })),
    };
    const fetchFn = createGatewayBackedDiscoveryFetch(gateway);

    await fetchFn('https://proxy.example/v1/models', {
      headers: {
        Host: 'evil.test',
        'Content-Length': '999',
        'X-Test-Header': 'ok',
      },
    });

    expect(gateway.webFetchBinary).toHaveBeenCalledWith(
      'https://proxy.example/v1/models',
      expect.objectContaining({
        headers: {
          'x-test-header': 'ok',
        },
      }),
    );
  });
});
