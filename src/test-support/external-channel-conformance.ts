// Conformance suite every external channel bridge must pass (psfn-framework-pus8m).
//
// A bridge written in TypeScript plugs in directly; a bridge in another
// language plugs in through a thin driver that forwards these five calls to
// it. The suite runs the real gateway-side adapter and MCP route over HTTP on
// an ephemeral loopback port, with a scripted companion behind the adapter.

import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentResponse, SubstrateMessage } from '../shared/contracts/runtime.js';
import type { MessageHandlerOptions } from '../channels/backplane/types.js';
import { ExternalChannelAdapter } from '../channels/external/adapter.js';
import type { ExternalChannelLimits } from '../channels/external/config.js';
import { ExternalChannelMcpRoute, externalChannelEndpointPath } from '../channels/external/mcp-route.js';
import type {
  ExternalChannelHelloResult,
  ExternalChannelInboundMessage,
  ExternalChannelInboundResult,
  ExternalChannelOutboundMessage,
  ExternalChannelStatus,
} from '../channels/external/protocol.js';
import { createCompanionId } from '../shared/routing/companion-id.js';
import testLimits from './fixtures/external-channel-limits.json' with { type: 'json' };

/** Small, fast owner-file bounds for tests (fixture data, not runtime tuning). */
export const EXTERNAL_CHANNEL_TEST_LIMITS: ExternalChannelLimits = testLimits;

export const EXTERNAL_CHANNEL_TEST_COMPANION_ID = createCompanionId('11111111-1111-4111-8111-111111111111');

interface ExternalChannelBridgeUnderTest {
  connect(): Promise<ExternalChannelHelloResult>;
  deliverInbound(message: ExternalChannelInboundMessage): Promise<ExternalChannelInboundResult>;
  pullOutbound(maxItems?: number): Promise<ExternalChannelOutboundMessage[]>;
  reportHealth(status: 'ok' | 'degraded', detail?: string): Promise<ExternalChannelStatus>;
  close(): Promise<void>;
}

interface BridgeEndpoint {
  url: URL;
  token: string;
  callTimeoutMs: number;
}

export type CreateBridgeUnderTest = (endpoint: BridgeEndpoint) => ExternalChannelBridgeUnderTest;

type ScriptedCompanion = (
  message: SubstrateMessage,
  options?: MessageHandlerOptions,
) => Promise<AgentResponse>;

function companionReply(message: SubstrateMessage, content: string): AgentResponse {
  return {
    content,
    channelId: message.channelId,
    metadata: { model: 'scripted', inputTokens: 0, outputTokens: 0, durationMs: 0 },
  };
}

/** Starts an HTTP server on an ephemeral loopback port serving `route`. */
export async function listenExternalChannelRoute(
  route: ExternalChannelMcpRoute,
): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer((req, res) => {
    if (route.matches(req.url ?? '/')) void route.handle(req, res);
    else res.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

export async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

interface ConformanceHarness {
  adapter: ExternalChannelAdapter;
  endpoint: BridgeEndpoint;
  received: SubstrateMessage[];
  failures: unknown[];
  setCompanion(companion: ScriptedCompanion): void;
  server: Server;
}

async function startHarness(): Promise<ConformanceHarness> {
  const received: SubstrateMessage[] = [];
  const failures: unknown[] = [];
  let companion: ScriptedCompanion = async message => companionReply(message, `echo: ${message.content}`);
  const token = 'conformance-bridge-token';
  const adapter = new ExternalChannelAdapter({
    config: {
      instanceId: 'conformance',
      label: 'Conformance bridge',
      companionId: EXTERNAL_CHANNEL_TEST_COMPANION_ID,
      limits: EXTERNAL_CHANNEL_TEST_LIMITS,
    },
    token,
    intakeScreening: null,
    log: { warn: () => undefined, error: () => undefined },
    reportRuntimeFailure: error => failures.push(error),
  });
  adapter.onMessage(async (message, options) => {
    received.push(message);
    return await companion(message, options);
  });
  const route = new ExternalChannelMcpRoute([adapter], []);
  await adapter.init();
  await adapter.start();
  const { baseUrl, server } = await listenExternalChannelRoute(route);
  return {
    adapter,
    endpoint: {
      url: new URL(`${baseUrl}${externalChannelEndpointPath('conformance')}`),
      token,
      callTimeoutMs: EXTERNAL_CHANNEL_TEST_LIMITS.turnTimeoutMs * 20,
    },
    received,
    failures,
    setCompanion: (next) => { companion = next; },
    server,
  };
}

function inbound(overrides: Partial<ExternalChannelInboundMessage> = {}): ExternalChannelInboundMessage {
  return {
    id: 'm-1',
    conversationId: 'conv-1',
    conversationKind: 'direct',
    senderId: 'user-1',
    senderName: 'Robin',
    text: 'hello companion',
    ...overrides,
  };
}

/** Registers the conformance scenarios for one bridge implementation. */
export function describeExternalChannelBridgeConformance(
  name: string,
  createBridge: CreateBridgeUnderTest,
): void {
  describe(`external channel bridge conformance: ${name}`, () => {
    let harness: ConformanceHarness;
    let bridge: ExternalChannelBridgeUnderTest;

    beforeEach(async () => {
      harness = await startHarness();
      bridge = createBridge(harness.endpoint);
    });

    afterEach(async () => {
      await bridge.close();
      await harness.adapter.stop();
      await closeServer(harness.server);
    });

    it('negotiates protocol version 1 and learns its identity and limits', async () => {
      const hello = await bridge.connect();
      expect(hello.protocolVersion).toBe(1);
      expect(hello.instanceId).toBe('conformance');
      expect(hello.limits.maxTextChars).toBe(EXTERNAL_CHANNEL_TEST_LIMITS.maxTextChars);
      expect(harness.adapter.status().state).toBe('connected');
    });

    it('delivers a direct message and receives the companion reply inline', async () => {
      await bridge.connect();
      const result = await bridge.deliverInbound(inbound());
      expect(result).toEqual({ status: 'replied', reply: { conversationId: 'conv-1', text: 'echo: hello companion' } });
      const [message] = harness.received;
      expect(message).toMatchObject({
        id: 'external:conformance:m-1',
        channelId: 'external:conformance:conv-1',
        channelType: 'external',
        authorId: 'external:conformance:user-1',
        authorName: 'Robin',
        isDirectMessage: true,
        routing: { source: 'external', responseMode: 'respond' },
      });
    });

    it('marks group conversations as non-direct', async () => {
      await bridge.connect();
      await bridge.deliverInbound(inbound({ conversationKind: 'group', conversationId: 'room-1' }));
      expect(harness.received[0]?.isDirectMessage).toBe(false);
    });

    it('hands ambient group chatter to the participation gate as observation only', async () => {
      await bridge.connect();
      harness.setCompanion(async message => companionReply(
        message,
        message.routing?.responseMode === 'observe' ? '' : `echo: ${message.content}`,
      ));
      const ambient = await bridge.deliverInbound(inbound({
        conversationKind: 'group',
        conversationId: 'room-1',
        text: 'anyone watching the game tonight?',
      }));
      expect(harness.received[0]?.routing).toMatchObject({ responseMode: 'observe' });
      expect(ambient).toEqual({ status: 'no_reply' });

      const addressed = await bridge.deliverInbound(inbound({
        id: 'm-2',
        conversationKind: 'group',
        conversationId: 'room-1',
        text: 'quick question for you',
        addressedToCompanion: true,
      }));
      expect(harness.received[1]?.routing).toMatchObject({ responseMode: 'respond' });
      expect(addressed).toEqual({
        status: 'replied',
        reply: { conversationId: 'room-1', text: 'echo: quick question for you' },
      });
    });

    it('reports no_reply when the companion stays silent', async () => {
      await bridge.connect();
      harness.setCompanion(async message => companionReply(message, ''));
      expect(await bridge.deliverInbound(inbound())).toEqual({ status: 'no_reply' });
    });

    it('receives companion-initiated sends by pulling, bounded per pull', async () => {
      await bridge.connect();
      for (const text of ['one', 'two', 'three']) {
        await harness.adapter.outbound.sendText({ channelId: 'external:conformance:conv-9' }, text);
      }
      const first = await bridge.pullOutbound();
      expect(first.map(message => message.text)).toEqual(['one', 'two']);
      expect(first[0]?.conversationId).toBe('conv-9');
      expect((await bridge.pullOutbound()).map(message => message.text)).toEqual(['three']);
      expect(await bridge.pullOutbound()).toEqual([]);
    });

    it('reports health and reads the adapter status', async () => {
      await bridge.connect();
      const status = await bridge.reportHealth('ok');
      expect(status).toMatchObject({ state: 'connected', bridgeReportedStatus: 'ok', inFlightTurns: 0 });
    });

    it('receives a structured refusal for an over-limit message', async () => {
      await bridge.connect();
      const result = await bridge.deliverInbound(inbound({
        text: 'x'.repeat(EXTERNAL_CHANNEL_TEST_LIMITS.maxTextChars + 1),
      }));
      expect(result).toMatchObject({ status: 'rejected', reason: 'invalid' });
      expect(harness.received).toHaveLength(0);
    });

    it('receives turn_timeout when the companion does not answer in time', async () => {
      await bridge.connect();
      harness.setCompanion(() => new Promise<AgentResponse>(() => undefined));
      expect(await bridge.deliverInbound(inbound())).toMatchObject({ status: 'rejected', reason: 'turn_timeout' });
      expect(harness.adapter.status().inFlightTurns).toBe(0);
    });

    it('cannot connect with a wrong credential', async () => {
      const impostor = createBridge({ ...harness.endpoint, token: 'not-the-bridge-token' });
      await expect(impostor.connect()).rejects.toThrow();
      await impostor.close();
    });
  });
}
