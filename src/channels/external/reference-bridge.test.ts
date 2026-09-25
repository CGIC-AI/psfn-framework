import { describe, expect, it } from 'vitest';
import {
  describeExternalChannelBridgeConformance,
  EXTERNAL_CHANNEL_TEST_COMPANION_ID,
  EXTERNAL_CHANNEL_TEST_LIMITS,
  closeServer,
  listenExternalChannelRoute,
} from '../../test-support/external-channel-conformance.js';
import { ExternalChannelAdapter } from './adapter.js';
import { ExternalChannelMcpRoute, externalChannelEndpointPath } from './mcp-route.js';
import { LoopbackPlatform, ReferenceExternalChannelBridge } from './reference-bridge.js';

describeExternalChannelBridgeConformance('reference bridge', endpoint => new ReferenceExternalChannelBridge({
  endpoint: endpoint.url,
  token: endpoint.token,
  name: 'reference-bridge',
  version: '1.0.0',
  callTimeoutMs: endpoint.callTimeoutMs,
}));

describe('loopback platform round trip', () => {
  it('relays a user message to the companion and a companion send back to the platform', async () => {
    const adapter = new ExternalChannelAdapter({
      observer: { authorId: 'external-companion:test', displayName: 'Test Companion' },
      config: {
        instanceId: 'loopback',
        label: 'Loopback',
        companionId: EXTERNAL_CHANNEL_TEST_COMPANION_ID,
        limits: EXTERNAL_CHANNEL_TEST_LIMITS,
      },
      token: 'loopback-token',
      intakeScreening: null,
      log: { warn: () => undefined, error: () => undefined },
      reportRuntimeFailure: () => undefined,
    });
    adapter.onMessage(async message => ({
      content: `hi ${message.authorName}`,
      channelId: message.channelId,
      metadata: { model: 'scripted', inputTokens: 0, outputTokens: 0, durationMs: 0 },
    }));
    const route = new ExternalChannelMcpRoute([adapter], []);
    await adapter.init();
    await adapter.start();
    const { baseUrl, server } = await listenExternalChannelRoute(route);
    const bridge = new ReferenceExternalChannelBridge({
      endpoint: new URL(`${baseUrl}${externalChannelEndpointPath('loopback')}`),
      token: 'loopback-token',
      name: 'loopback',
      version: '1.0.0',
      callTimeoutMs: 5_000,
    });
    try {
      await bridge.connect();
      const platform = new LoopbackPlatform(bridge);
      await platform.userSays({
        conversationId: 'dm-juno', conversationKind: 'direct', senderId: 'juno', senderName: 'Juno', text: 'hello',
      });
      expect(platform.replies).toEqual([{ conversationId: 'dm-juno', text: 'hi Juno' }]);
      await adapter.outbound.sendText({ channelId: 'external:loopback:dm-juno' }, 'thinking of you');
      expect(await platform.pumpOutbound()).toBe(1);
      expect(platform.delivered[0]).toMatchObject({ conversationId: 'dm-juno', text: 'thinking of you' });
    } finally {
      await bridge.close();
      await adapter.stop();
      await closeServer(server);
    }
  });
});
