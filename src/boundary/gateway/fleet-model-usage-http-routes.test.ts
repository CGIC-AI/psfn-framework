import { createServer, request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FleetModelUsageProjection } from './fleet-model-usage-projection.js';
import {
  FLEET_MODEL_USAGE_API_PATH,
  GatewayFleetModelUsageHttpRoutes,
} from './fleet-model-usage-http-routes.js';
import { FleetAuthorizationDeniedError } from './fleet-authorization-context.js';

const SESSION_TOKEN = 'S'.repeat(43);
const COMPANION_A = '11111111-1111-4111-8111-111111111111';

function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');
    return address.port;
  });
}

function request(port: number, path: string, method = 'GET'): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      hostname: '127.0.0.1',
      port,
      method,
      path,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
}

describe('authenticated fleet model-usage HTTP route', () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => {
      server.close(() => resolve());
    })));
  });

  it('returns the combined and per-companion token projection for a bounded range', async () => {
    const value: FleetModelUsageProjection = {
      schemaVersion: 1,
      generatedAt: '2026-07-18T12:00:00.000Z',
      resolvedRange: {
        range: 'week',
        timezone: 'America/New_York',
        sinceMs: 1_752_811_200_000,
        untilMs: 1_753_416_000_000,
        bucket: 'day',
        boundary: '[sinceMs, untilMs)',
        calendarWeekStartsOn: 'monday',
      },
      combined: {
        calls: 3,
        inputTokens: 100,
        outputTokens: 25,
        cacheReadTokens: 40,
        cacheWriteTokens: 5,
        totalTokens: 170,
      },
      companions: [{
        companionId: COMPANION_A,
        usage: {
          calls: 3,
          inputTokens: 100,
          outputTokens: 25,
          cacheReadTokens: 40,
          cacheWriteTokens: 5,
          totalTokens: 170,
        },
      }],
    };
    const resolve = vi.fn(async () => value);
    const routes = new GatewayFleetModelUsageHttpRoutes({
      projection: { resolve },
    });
    const server = createServer((incoming, response) => {
      const target = new URL(incoming.url ?? '/', 'http://fleet.test');
      void routes.handle({
        request: incoming,
        response,
        sessionToken: SESSION_TOKEN,
        rawPath: target.pathname,
        rawQuery: target.search.slice(1),
      });
    });
    servers.push(server);
    const port = await listen(server);

    const result = await request(
      port,
      `${FLEET_MODEL_USAGE_API_PATH}?range=week&timezone=America%2FNew_York`,
    );

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual(value);
    expect(result.headers).toMatchObject({
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'cross-origin-resource-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
      vary: 'Cookie',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    });
    expect(resolve).toHaveBeenCalledWith({
      sessionToken: SESSION_TOKEN,
      query: {
        range: 'week',
        timezone: 'America/New_York',
      },
    });
  });

  it('collapses authorization denials while distinguishing reauthentication and outages', async () => {
    let reason: ConstructorParameters<typeof FleetAuthorizationDeniedError>[0] = 'role_action_denied';
    const routes = new GatewayFleetModelUsageHttpRoutes({
      projection: {
        resolve: async () => {
          throw new FleetAuthorizationDeniedError(reason);
        },
      },
    });
    const server = createServer((incoming, response) => {
      const target = new URL(incoming.url ?? '/', 'http://fleet.test');
      void routes.handle({
        request: incoming,
        response,
        sessionToken: SESSION_TOKEN,
        rawPath: target.pathname,
        rawQuery: target.search.slice(1),
      });
    });
    servers.push(server);
    const port = await listen(server);

    const roleDenied = await request(port, FLEET_MODEL_USAGE_API_PATH);
    reason = 'session_expired';
    const sessionExpired = await request(port, FLEET_MODEL_USAGE_API_PATH);
    reason = 'authorization_store_error';
    const storeUnavailable = await request(port, FLEET_MODEL_USAGE_API_PATH);

    expect(roleDenied).toMatchObject({
      status: 403,
      body: '{"error":{"type":"fleet_model_usage_denied"}}',
    });
    expect(sessionExpired).toMatchObject({
      status: 401,
      body: '{"error":{"type":"fleet_model_usage_denied"}}',
    });
    expect(storeUnavailable).toMatchObject({
      status: 503,
      body: '{"error":{"type":"fleet_model_usage_unavailable"}}',
    });
    for (const result of [roleDenied, sessionExpired, storeUnavailable]) {
      expect(result.body).not.toMatch(/role|session|authorization_store/u);
    }
  });

  it('rejects aliases, mutations, duplicate fields, unsupported fields, and incomplete custom ranges', async () => {
    const resolve = vi.fn();
    const routes = new GatewayFleetModelUsageHttpRoutes({
      projection: { resolve },
    });
    const server = createServer((incoming, response) => {
      const target = new URL(incoming.url ?? '/', 'http://fleet.test');
      void routes.handle({
        request: incoming,
        response,
        sessionToken: SESSION_TOKEN,
        rawPath: target.pathname,
        rawQuery: target.search.slice(1),
      });
    });
    servers.push(server);
    const port = await listen(server);

    for (const [path, method, expectedStatus] of [
      [`${FLEET_MODEL_USAGE_API_PATH}/`, 'GET', 404],
      [FLEET_MODEL_USAGE_API_PATH, 'POST', 404],
      [`${FLEET_MODEL_USAGE_API_PATH}?range=today&range=week`, 'GET', 400],
      [`${FLEET_MODEL_USAGE_API_PATH}?companionId=${COMPANION_A}`, 'GET', 400],
      [`${FLEET_MODEL_USAGE_API_PATH}?range=custom&sinceMs=1`, 'GET', 400],
    ] as const) {
      expect((await request(port, path, method)).status).toBe(expectedStatus);
    }
    expect(resolve).not.toHaveBeenCalled();
  });
});
