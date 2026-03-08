import type { WebFetchBinaryResult } from '../gateway/protocol.js';

const DEFAULT_DISCOVERY_FETCH_MAX_BYTES = 2 * 1024 * 1024;

export interface DiscoveryGatewayClient {
  webFetchBinary(
    url: string,
    options?: {
      lane?: 'default' | 'local_crawler';
      maxBytes?: number;
      headers?: Record<string, string>;
    },
  ): Promise<WebFetchBinaryResult>;
}

function normalizeHeaders(headers: Headers): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, rawValue] of headers.entries()) {
    const name = key.trim();
    const value = rawValue.trim();
    if (!name || !value) continue;
    if (name === 'host' || name === 'content-length') continue;
    normalized[name] = value;
  }
  return normalized;
}

export function createGatewayBackedDiscoveryFetch(
  gateway: DiscoveryGatewayClient,
  options: { maxBytes?: number } = {},
): typeof fetch {
  const maxBytes = typeof options.maxBytes === 'number' && Number.isFinite(options.maxBytes)
    ? Math.max(1, Math.floor(options.maxBytes))
    : DEFAULT_DISCOVERY_FETCH_MAX_BYTES;

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (request.method.toUpperCase() !== 'GET') {
      throw new Error('Gateway-backed discovery fetch only supports GET requests.');
    }
    if (request.body !== null) {
      throw new Error('Gateway-backed discovery fetch does not support request bodies.');
    }

    const headers = normalizeHeaders(request.headers);
    const result = await gateway.webFetchBinary(request.url, {
      lane: 'default',
      maxBytes,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });

    const body = Buffer.from(result.dataBase64, 'base64');
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': result.mimeType || 'application/octet-stream',
        'Content-Length': String(result.sizeBytes),
      },
    });
  };
}
