import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import { ApiServer } from '../api/server.js';
import { EventBus } from '../../shared/event-bus.js';
import {
  EXTERNAL_CHANNEL_TEST_COMPANION_ID,
  EXTERNAL_CHANNEL_TEST_LIMITS,
  closeServer,
} from '../../test-support/external-channel-conformance.js';
import { ExternalChannelAdapter } from './adapter.js';
import { ExternalChannelMcpRoute, externalChannelEndpointPath } from './mcp-route.js';
import { ReferenceExternalChannelBridge } from './reference-bridge.js';

function adapter(instanceId: string, token: string): ExternalChannelAdapter {
  const created = new ExternalChannelAdapter({
    config: {
      instanceId, label: instanceId, companionId: EXTERNAL_CHANNEL_TEST_COMPANION_ID,
      limits: EXTERNAL_CHANNEL_TEST_LIMITS,
    },
    token,
    intakeScreening: null,
    log: { warn: () => undefined, error: () => undefined },
    reportRuntimeFailure: () => undefined,
  });
  created.onMessage(async message => ({
    content: 'routed', channelId: message.channelId,
    metadata: { model: 'scripted', inputTokens: 0, outputTokens: 0, durationMs: 0 },
  }));
  return created;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe('external channel MCP route', () => {
  it('refuses credentials reused from other API surfaces and serves only unique ones', async () => {
    const reused = adapter('reused', 'ordinary-api-key');
    const unique = adapter('unique', 'unique-bridge-token');
    const route = new ExternalChannelMcpRoute([reused, unique], ['ordinary-api-key', undefined]);
    await expect(reused.start()).rejects.toThrow('credential must be unique');
    await expect(unique.start()).resolves.toBeUndefined();
    expect(route.matches(externalChannelEndpointPath('unique'))).toBe(true);
    expect(route.matches('/v1/chat/completions')).toBe(false);
    expect(new ExternalChannelMcpRoute([], []).matches(externalChannelEndpointPath('unique'))).toBe(false);
    await unique.stop();
  });

  it('is dispatched by the API server before any other route', async () => {
    const bridgeAdapter = adapter('api', 'api-bridge-token');
    const route = new ExternalChannelMcpRoute([bridgeAdapter], []);
    await bridgeAdapter.start();
    const agent = vi.fn();
    const sso = vi.fn();
    const api = new ApiServer({
      port: 0, modelName: EXTERNAL_CHANNEL_TEST_COMPANION_ID,
      agentLoop: fromPartial({ handleMessage: agent }), eventBus: new EventBus(),
      sessionManager: fromPartial({}), externalChannelMcp: route,
      fleetSsoRouter: fromPartial({ matches: () => true, handle: sso, registerGardenChatHandler: vi.fn() }),
    });
    const server = createServer((req, res) => {
      Reflect.get(api, 'handleRequest').call(api, req, res);
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
    const bridge = new ReferenceExternalChannelBridge({
      endpoint: new URL(`http://127.0.0.1:${address.port}${externalChannelEndpointPath('api')}`),
      token: 'api-bridge-token',
      name: 'api-bridge',
      version: '1.0.0',
      callTimeoutMs: 5_000,
    });
    try {
      await bridge.connect();
      expect(await bridge.deliverInbound({
        id: 'm', conversationId: 'c', conversationKind: 'direct', senderId: 's', senderName: 'S', text: 'hi',
      })).toEqual({ status: 'replied', reply: { conversationId: 'c', text: 'routed' } });
      expect(sso).not.toHaveBeenCalled();
      expect(agent).not.toHaveBeenCalled();
    } finally {
      await bridge.close();
      await bridgeAdapter.stop();
    }
  });

  it('answers 503 while the adapter is not running', async () => {
    const stopped = adapter('stopped', 'stopped-token');
    const route = new ExternalChannelMcpRoute([stopped], []);
    const server = createServer((req, res) => { void route.handle(req, res); });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
    const response = await fetch(`http://127.0.0.1:${address.port}${externalChannelEndpointPath('stopped')}`, {
      method: 'POST', headers: { Authorization: 'Bearer stopped-token' }, body: '{}',
    });
    expect(response.status).toBe(503);
  });
});
