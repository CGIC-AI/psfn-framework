import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { GatewayServer, type GatewayServerOptions } from './server.js';
import { GatewayErrors } from './protocol.js';
import type { GatewayRpcConnection } from './transport.js';
import type { SessionHmacKeyring } from '../../persistence/journals/journal-utils.js';
import type { GatewayAuditStorePort } from './audit-port.js';
import type { GatewayMultiCompanionConfig } from './multi-companion.js';
import {
  resolveGatewayMultiCompanionConfig,
  resolveGatewaySurfaceForChannelType,
} from './multi-companion.js';
import type { RuntimeChannelsConfig } from '../../channels/backplane/config.js';

// Mock the transport module to avoid real socket operations
vi.mock('./transport.js', () => ({
  createSocketServer: vi.fn(),
  createWebSocketRpcServer: vi.fn(),
}));

import { createSocketServer } from './transport.js';

const mockedCreateSocketServer = vi.mocked(createSocketServer);

const TEST_SESSION_HMAC_KEYRING: SessionHmacKeyring = {
  activeVersion: 'v1',
  keys: {
    v1: 'test-session-secret',
  },
};

const TEST_WYOMING_SHARD_ROUTING = {
  enabled: false,
};

type MockConnection = {
  conn: GatewayRpcConnection;
  sent: unknown[];
  _emit(message: unknown): void;
  _emitClose(): void;
};

function createMockConnection(
  onSend?: (message: any, emit: (response: unknown) => void) => void,
): MockConnection {
  const emitter = new EventEmitter();
  const sent: unknown[] = [];
  let destroyed = false;

  const conn = {
    send(data: unknown): boolean {
      sent.push(data);
      onSend?.(data as any, (response) => emitter.emit('message', response));
      return true;
    },
    onMessage(handler: (message: unknown) => void): void {
      emitter.on('message', handler);
    },
    on(event: string, handler: (...args: unknown[]) => void): void {
      emitter.on(event, handler);
    },
    destroy(): void {
      destroyed = true;
      emitter.removeAllListeners();
    },
    get destroyed(): boolean {
      return destroyed;
    },
    _emit(message: unknown): void {
      emitter.emit('message', message);
    },
    _emitClose(): void {
      emitter.emit('close');
    },
  };

  return {
    conn: conn as unknown as GatewayRpcConnection,
    sent,
    _emit: conn._emit,
    _emitClose: conn._emitClose,
  };
}

function createMinimalOptions(): GatewayServerOptions {
  return {
    socketPath: '/tmp/test.sock',
    llmProvider: {
      stream: vi.fn().mockResolvedValue({
        content: 'test',
        toolCalls: [],
        model: 'test',
        inputTokens: 10,
        outputTokens: 5,
        stopReason: 'end',
      }),
      complete: vi.fn(),
    } as any,
    embeddingService: {
      embed: vi.fn(),
      embedBatch: vi.fn(),
      dims: 1024,
    } as any,
    discordAdapter: {
      id: 'discord',
      outbound: {
        textChunkLimit: 2000,
        sendText: vi.fn(),
      },
    } as any,
    policyConfig: {
      workspacePath: '/workspace',
    },
    sessionHmacKeyring: TEST_SESSION_HMAC_KEYRING,
    wyomingShardRouting: TEST_WYOMING_SHARD_ROUTING,
  };
}

function createMockAuditStore(overrides: Partial<GatewayAuditStorePort> = {}): GatewayAuditStorePort {
  return {
    append: vi.fn(async () => 1),
    complete: vi.fn(async () => undefined),
    recordSummary: vi.fn(async () => 1),
    createSummaryHook: vi.fn(() => async () => undefined),
    enforceRotation: vi.fn(async () => undefined),
    getRecent: vi.fn(async () => []),
    getByMethod: vi.fn(async () => []),
    getApprovalEvents: vi.fn(async () => []),
    count: vi.fn(async () => 0),
    ...overrides,
  };
}

async function setupServer(
  options: GatewayServerOptions,
): Promise<{
  server: GatewayServer;
  connect: (onSend?: (message: any, emit: (response: unknown) => void) => void) => Promise<MockConnection>;
}> {
  const server = new GatewayServer(options);
  let onConnectionCb: ((conn: GatewayRpcConnection) => void) | null = null;
  mockedCreateSocketServer.mockImplementation((_path, cb) => {
    onConnectionCb = cb;
    return { close: vi.fn(), listen: vi.fn() } as any;
  });
  server.start();
  return {
    server,
    connect: async (onSend) => {
      const conn = createMockConnection(onSend);
      onConnectionCb!(conn.conn);
      await new Promise(r => setTimeout(r, 5));
      return conn;
    },
  };
}

async function invokeRpc(
  conn: MockConnection,
  id: number,
  method: string,
  params: unknown,
): Promise<any> {
  conn._emit({
    jsonrpc: '2.0',
    id,
    method,
    params,
  });

  for (let attempt = 0; attempt < 40; attempt++) {
    const response = conn.sent.find(
      (msg: any) => msg.id === id && ('result' in msg || 'error' in msg),
    );
    if (response) {
      return response;
    }
    await new Promise(r => setTimeout(r, 5));
  }

  throw new Error(`No RPC response found for id ${id}`);
}

async function identifyAgent(
  conn: MockConnection,
  companionId: string,
  rpcId = 900,
): Promise<any> {
  return await invokeRpc(conn, rpcId, 'gateway.client.identify', {
    role: 'agent',
    companionId,
  });
}

function multiCompanion(
  channelRouting: GatewayMultiCompanionConfig['channelRouting'],
): GatewayMultiCompanionConfig {
  return { enabled: true, channelRouting };
}

function methodFrames(conn: MockConnection, method: string): any[] {
  return conn.sent.filter((msg: any) => msg.method === method);
}

function makeChannelMessage(channelType: 'discord' | 'telegram' | 'api' | 'terminal') {
  return {
    id: `msg-${channelType}-1`,
    channelId: `${channelType}:test-channel`,
    channelType,
    authorId: 'user-1',
    authorName: 'Test User',
    content: 'hello there',
    timestamp: new Date('2025-01-01T00:00:00.000Z'),
  } as any;
}

function voiceStreamResponder(routed: { messages: any[] }) {
  return (msg: any, emit: (response: unknown) => void) => {
    if (!msg.id || typeof msg.method !== 'string') return;
    if (msg.method === 'voice.stream.start' || msg.method === 'voice.stream.chunk') {
      if (msg.method === 'voice.stream.start') {
        routed.messages.push(msg.params.message);
      }
      emit({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          correlationId: msg.params.correlationId,
          streamId: msg.params.streamId,
          sequence: msg.params.sequence,
          accepted: true,
          queueDepth: 0,
        },
      });
      return;
    }
    if (msg.method === 'voice.stream.end') {
      emit({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          content: 'voice response',
          channelId: msg.params.message?.channelId ?? 'ch',
          model: 'voice-model',
          durationMs: 5,
          correlationId: msg.params.correlationId,
          streamId: msg.params.streamId,
          droppedChunks: 0,
        },
      });
    }
  };
}

describe('resolveGatewayMultiCompanionConfig', () => {
  const baseChannels = (overrides: Partial<RuntimeChannelsConfig> = {}): RuntimeChannelsConfig => ({
    discord: { heartbeatChannelId: '', allowedBotUserIds: [], groupMemory: { channelOverrides: {} } },
    telegram: {
      enabled: false,
      token: '',
      allowedUsers: [],
      mode: 'polling',
      pollIntervalMs: 1000,
      webhook: { url: '', secret: '', host: '0.0.0.0', port: 8080, path: '/telegram/webhook' },
    },
    api: {},
    psfnAmica: { enabled: false },
    contextEnvelope: { channels: {} },
    ...overrides,
  } as RuntimeChannelsConfig);

  it('defaults to disabled with no routing', () => {
    expect(resolveGatewayMultiCompanionConfig({}, baseChannels())).toEqual({
      enabled: false,
      channelRouting: {},
    });
  });

  it('builds the routing table from channels.json companionId fields when enabled', () => {
    const channels = baseChannels();
    channels.discord.companionId = 'comp-a';
    channels.telegram.companionId = 'comp-b';
    channels.api.companionId = 'comp-b';
    expect(resolveGatewayMultiCompanionConfig({ multiCompanion: true }, channels)).toEqual({
      enabled: true,
      channelRouting: { discord: 'comp-a', telegram: 'comp-b', api: 'comp-b' },
    });
  });

  it('fails closed when routing is declared while the flag is off', () => {
    const channels = baseChannels();
    channels.discord.companionId = 'comp-a';
    expect(() => resolveGatewayMultiCompanionConfig({}, channels)).toThrow(
      /PSFN_MULTI_COMPANION is not enabled/,
    );
  });

  it('maps channel types onto routable surfaces fail-closed', () => {
    expect(resolveGatewaySurfaceForChannelType('discord')).toBe('discord');
    expect(resolveGatewaySurfaceForChannelType('telegram')).toBe('telegram');
    expect(resolveGatewaySurfaceForChannelType('api')).toBe('api');
    expect(resolveGatewaySurfaceForChannelType('terminal')).toBeNull();
    expect(resolveGatewaySurfaceForChannelType('psfn-amica')).toBeNull();
  });
});

describe('GatewayServer single-companion parity (flag off)', () => {
  it('accepts identify with a companionId and does not reject duplicates', async () => {
    const { connect } = await setupServer(createMinimalOptions());
    const connA = await connect();
    const connB = await connect();

    const first = await identifyAgent(connA, 'comp-a', 901);
    const second = await identifyAgent(connB, 'comp-a', 902);
    expect(first.result).toEqual({ success: true, role: 'agent', companionId: 'comp-a' });
    expect(second.result).toEqual({ success: true, role: 'agent', companionId: 'comp-a' });
  });

  it('broadcasts inbound channel messages to every ready agent (characterizes existing behavior)', async () => {
    const { server, connect } = await setupServer(createMinimalOptions());
    const connA = await connect();
    const connB = await connect();

    server.notifyChannelMessage('discord', 'discord.message', {
      message: { id: 'm1', channelId: 'ch1' },
    });

    expect(methodFrames(connA, 'discord.message')).toHaveLength(1);
    expect(methodFrames(connB, 'discord.message')).toHaveLength(1);
  });

  it('broadcasts llm.chunk stream deltas to every agent (characterizes existing behavior)', async () => {
    const options = createMinimalOptions();
    options.llmProvider.stream = vi.fn(async (_context: any, callbacks: any) => {
      callbacks?.onText?.('delta-text');
      return {
        content: 'done',
        toolCalls: [],
        model: 'test',
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'end',
      };
    }) as any;
    const { connect } = await setupServer(options);
    const connA = await connect();
    const connB = await connect();

    const response = await invokeRpc(connA, 10, 'llm.chat', {
      model: 'test',
      provider: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: '',
      stream: true,
      requestId: 'req-parity-1',
    });
    expect(response.error).toBeUndefined();

    expect(methodFrames(connA, 'llm.chunk')).toHaveLength(1);
    expect(methodFrames(connB, 'llm.chunk')).toHaveLength(1);
  });

  it('routes requestAgent to the first ready agent (characterizes existing behavior)', async () => {
    const { server, connect } = await setupServer(createMinimalOptions());
    const connA = await connect();
    const connB = await connect();

    const requestPromise = server.requestAgent('api.health', {});
    await new Promise(r => setTimeout(r, 10));

    const requestFrame = methodFrames(connA, 'api.health')[0];
    expect(requestFrame).toBeDefined();
    expect(methodFrames(connB, 'api.health')).toHaveLength(0);
    connA._emit({ jsonrpc: '2.0', id: requestFrame.id, result: { ok: true } });
    await expect(requestPromise).resolves.toEqual({ ok: true });
  });
});

describe('GatewayServer multi-companion identify (flag on)', () => {
  it('rejects agent identify without a companionId', async () => {
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({}),
    });
    const conn = await connect();

    const response = await invokeRpc(conn, 1, 'gateway.client.identify', { role: 'agent' });
    expect(response.error).toBeDefined();
    expect(response.error.message).toContain('requires a companionId');
  });

  it('rejects a duplicate companionId identify without evicting the first connection', async () => {
    const auditAppend = vi.fn(async () => 7);
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      auditStore: createMockAuditStore({ append: auditAppend }),
      multiCompanion: multiCompanion({ discord: 'comp-a' }),
    });
    const connA = await connect();
    const connB = await connect();

    const first = await identifyAgent(connA, 'comp-a', 1);
    expect(first.result).toMatchObject({ success: true, companionId: 'comp-a' });

    const second = await identifyAgent(connB, 'comp-a', 2);
    expect(second.error).toBeDefined();
    expect(second.error.message).toContain('duplicate identify rejected');

    // The first connection still owns the routing.
    server.notifyChannelMessage('discord', 'discord.message', { message: { id: 'm1' } });
    expect(methodFrames(connA, 'discord.message')).toHaveLength(1);
    expect(methodFrames(connB, 'discord.message')).toHaveLength(0);

    await new Promise(r => setTimeout(r, 10));
    expect(auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      method: 'gateway.companion.duplicate_identify',
      decision: 'DENY',
    }));
  });

  it('rejects re-identifying an already-bound connection as a different companion', async () => {
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({}),
    });
    const conn = await connect();

    await identifyAgent(conn, 'comp-a', 1);
    const rebind = await identifyAgent(conn, 'comp-b', 2);
    expect(rebind.error).toBeDefined();
    expect(rebind.error.message).toContain('cannot rebind');
  });

  it('rejects non-identify RPCs from agent connections that have not identified', async () => {
    const auditAppend = vi.fn(async () => 8);
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      auditStore: createMockAuditStore({ append: auditAppend }),
      multiCompanion: multiCompanion({}),
    });
    const conn = await connect();

    const response = await invokeRpc(conn, 5, 'llm.embed', { texts: ['x'] });
    expect(response.error).toBeDefined();
    expect(response.error.code).toBe(GatewayErrors.COMPANION_IDENTIFY_REQUIRED);
    await new Promise(r => setTimeout(r, 10));
    expect(auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      method: 'gateway.companion.identify_required',
      decision: 'DENY',
    }));
  });

  it('disconnects a connection whose request claims another companion identity', async () => {
    const auditAppend = vi.fn(async () => 9);
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      auditStore: createMockAuditStore({ append: auditAppend }),
      multiCompanion: multiCompanion({}),
    });
    const conn = await connect();
    await identifyAgent(conn, 'comp-a', 1);

    conn._emit({
      jsonrpc: '2.0',
      id: 6,
      method: 'llm.complete',
      params: { companionId: 'comp-b' },
    });
    await new Promise(r => setTimeout(r, 20));

    expect(conn.conn.destroyed).toBe(true);
    expect(auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      method: 'gateway.companion.identity_mismatch',
      decision: 'DENY',
      params: expect.objectContaining({
        boundCompanionId: 'comp-a',
        claimedCompanionId: 'comp-b',
      }),
    }));
    await expect(server.requestAgent('test', {})).rejects.toThrow();
  });
});

describe('GatewayServer multi-companion routing (flag on)', () => {
  it('delivers inbound channel messages to exactly the routed companion', async () => {
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({ discord: 'comp-a' }),
    });
    const connA = await connect();
    const connB = await connect();
    await identifyAgent(connA, 'comp-a', 1);
    await identifyAgent(connB, 'comp-b', 2);

    server.notifyChannelMessage('discord', 'discord.message', { message: { id: 'm1' } });

    expect(methodFrames(connA, 'discord.message')).toHaveLength(1);
    expect(methodFrames(connB, 'discord.message')).toHaveLength(0);
  });

  it('fails closed for unrouted channel surfaces and audits the violation', async () => {
    const auditAppend = vi.fn(async () => 11);
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      auditStore: createMockAuditStore({ append: auditAppend }),
      multiCompanion: multiCompanion({ discord: 'comp-a' }),
    });
    const connA = await connect();
    await identifyAgent(connA, 'comp-a', 1);

    expect(() => server.notifyChannelMessage('telegram', 'telegram.message', {}))
      .toThrow('Multi-companion routing has no companion for channel surface "telegram"');
    await expect(server.requestAgentVoiceStream(makeChannelMessage('telegram')))
      .rejects.toThrow('no companion for channel surface "telegram"');
    expect(methodFrames(connA, 'telegram.message')).toHaveLength(0);

    await new Promise(r => setTimeout(r, 10));
    expect(auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      method: 'gateway.companion.unrouted_channel',
      decision: 'DENY',
    }));
  });

  it('fails closed for channel types without a routing surface', async () => {
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({ discord: 'comp-a' }),
    });
    const connA = await connect();
    await identifyAgent(connA, 'comp-a', 1);

    await expect(server.requestAgentVoiceStream(makeChannelMessage('terminal')))
      .rejects.toThrow('cannot map channelType "terminal"');
  });

  it('routes requestAgent (api surface) to the api companion, not the first ready agent', async () => {
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({ api: 'comp-b' }),
    });
    const connA = await connect();
    const connB = await connect();
    await identifyAgent(connA, 'comp-a', 1);
    await identifyAgent(connB, 'comp-b', 2);

    const requestPromise = server.requestAgent('api.health', {});
    await new Promise(r => setTimeout(r, 10));

    expect(methodFrames(connA, 'api.health')).toHaveLength(0);
    const requestFrame = methodFrames(connB, 'api.health')[0];
    expect(requestFrame).toBeDefined();
    connB._emit({ jsonrpc: '2.0', id: requestFrame.id, result: { ok: true } });
    await expect(requestPromise).resolves.toEqual({ ok: true });
  });

  it('routes voice/channel streams by message channelType to exactly the routed companion', async () => {
    const routed = { messages: [] as any[] };
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({ telegram: 'comp-b' }),
    });
    const connA = await connect();
    const connB = await connect(voiceStreamResponder(routed));
    await identifyAgent(connA, 'comp-a', 1);
    await identifyAgent(connB, 'comp-b', 2);

    const result = await server.requestAgentVoiceStream(makeChannelMessage('telegram'));
    expect(result.content).toBe('voice response');
    expect(methodFrames(connA, 'voice.stream.start')).toHaveLength(0);
    expect(methodFrames(connB, 'voice.stream.start')).toHaveLength(1);
  });

  it('stamps the routed companionId on wyoming-tagged api voice streams', async () => {
    const routed = { messages: [] as any[] };
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({ api: 'comp-b' }),
    });
    const connA = await connect();
    const connB = await connect(voiceStreamResponder(routed));
    await identifyAgent(connA, 'comp-a', 1);
    await identifyAgent(connB, 'comp-b', 2);

    const message = {
      id: 'wyoming-msg-conn-hallway-1',
      channelId: 'api:wyoming:ha-main:voice-pe-hallway',
      channelType: 'api' as const,
      authorId: 'wyoming-user:owner',
      authorName: 'Wyoming Voice User',
      content: 'hello from hallway',
      timestamp: new Date('2025-01-01T00:00:00.000Z'),
      isDirectMessage: true,
      routing: { source: 'wyoming' as const },
    };
    await server.requestAgentVoiceStream(message as any);

    expect(methodFrames(connA, 'voice.stream.start')).toHaveLength(0);
    expect(routed.messages[0]?.routing?.gateway).toEqual({
      schemaVersion: 1,
      companionId: 'comp-b',
    });
  });

  it('fails closed when the routed companion connection is gone', async () => {
    const auditAppend = vi.fn(async () => 12);
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      auditStore: createMockAuditStore({ append: auditAppend }),
      multiCompanion: multiCompanion({ discord: 'comp-a' }),
    });
    const connA = await connect();
    const connB = await connect();
    await identifyAgent(connA, 'comp-a', 1);
    await identifyAgent(connB, 'comp-b', 2);

    connA._emitClose();
    await new Promise(r => setTimeout(r, 5));

    expect(() => server.notifyChannelMessage('discord', 'discord.message', { message: { id: 'm1' } }))
      .toThrow('No agent connection for companion "comp-a"');
    expect(methodFrames(connB, 'discord.message')).toHaveLength(0);

    await new Promise(r => setTimeout(r, 10));
    expect(auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      method: 'gateway.companion.companion_not_connected',
      decision: 'DENY',
    }));
  });

  it('drops api.stream.delta frames from connections that are not the routed api companion', async () => {
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({ api: 'comp-a' }),
    });
    const connA = await connect();
    const connB = await connect();
    await identifyAgent(connA, 'comp-a', 1);
    await identifyAgent(connB, 'comp-b', 2);

    const received: string[] = [];
    server.subscribeApiStream('req-1', (text) => received.push(text));

    connB._emit({
      jsonrpc: '2.0',
      method: 'api.stream.delta',
      params: { requestId: 'req-1', text: 'stolen', companionId: 'comp-b' },
    });
    await new Promise(r => setTimeout(r, 10));
    expect(received).toEqual([]);

    connA._emit({
      jsonrpc: '2.0',
      method: 'api.stream.delta',
      params: { requestId: 'req-1', text: 'legit', companionId: 'comp-a' },
    });
    await new Promise(r => setTimeout(r, 10));
    expect(received).toEqual(['legit']);
  });
});

describe('GatewayServer multi-companion crossover under concurrent load (flag on)', () => {
  it('returns every interleaved response and stream chunk to exactly the originating companion', async () => {
    const options = createMinimalOptions();
    options.llmProvider.stream = vi.fn(async (context: any, callbacks: any) => {
      const marker = context.messages[0].content as string;
      callbacks?.onText?.(`chunk:${marker}`);
      // Interleave completions: pseudo-random latency per request.
      await new Promise(r => setTimeout(r, (marker.charCodeAt(0) + marker.length * 7) % 23));
      callbacks?.onText?.(`chunk2:${marker}`);
      return {
        content: `resp:${marker}`,
        toolCalls: [],
        model: 'test',
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'end',
      };
    }) as any;

    const { connect } = await setupServer({
      ...options,
      multiCompanion: multiCompanion({ discord: 'comp-a', api: 'comp-b' }),
    });
    const connA = await connect();
    const connB = await connect();
    await identifyAgent(connA, 'comp-a', 500);
    await identifyAgent(connB, 'comp-b', 500);

    const perAgentRequests = 10;
    // Deliberately reuse the SAME JSON-RPC ids on both connections: correlation
    // must be per-connection, never global.
    for (let i = 1; i <= perAgentRequests; i++) {
      connA._emit({
        jsonrpc: '2.0',
        id: i,
        method: 'llm.chat',
        params: {
          model: 'test',
          provider: 'test',
          companionId: 'comp-a',
          messages: [{ role: 'user', content: `a-${i}` }],
          systemPrompt: '',
          stream: true,
          requestId: `req-a-${i}`,
        },
      });
      connB._emit({
        jsonrpc: '2.0',
        id: i,
        method: 'llm.chat',
        params: {
          model: 'test',
          provider: 'test',
          companionId: 'comp-b',
          messages: [{ role: 'user', content: `b-${i}` }],
          systemPrompt: '',
          stream: true,
          requestId: `req-b-${i}`,
        },
      });
    }

    const responsesOf = (conn: MockConnection) =>
      conn.sent.filter((msg: any) =>
        typeof msg.id === 'number'
        && msg.id >= 1
        && msg.id <= perAgentRequests
        && 'result' in msg);
    for (let attempt = 0; attempt < 200; attempt++) {
      if (responsesOf(connA).length >= perAgentRequests && responsesOf(connB).length >= perAgentRequests) {
        break;
      }
      await new Promise(r => setTimeout(r, 5));
    }

    const aResponses = responsesOf(connA) as any[];
    const bResponses = responsesOf(connB) as any[];
    expect(aResponses).toHaveLength(perAgentRequests);
    expect(bResponses).toHaveLength(perAgentRequests);
    for (let i = 1; i <= perAgentRequests; i++) {
      const aResponse = aResponses.find((msg) => msg.id === i);
      const bResponse = bResponses.find((msg) => msg.id === i);
      expect(aResponse?.result?.content).toBe(`resp:a-${i}`);
      expect(bResponse?.result?.content).toBe(`resp:b-${i}`);
    }

    const chunkMarkers = (conn: MockConnection) =>
      methodFrames(conn, 'llm.chunk').map((frame: any) => frame.params.text as string);
    const aChunks = chunkMarkers(connA);
    const bChunks = chunkMarkers(connB);
    expect(aChunks).toHaveLength(perAgentRequests * 2);
    expect(bChunks).toHaveLength(perAgentRequests * 2);
    expect(aChunks.every(text => /^chunk2?:a-\d+$/.test(text))).toBe(true);
    expect(bChunks.every(text => /^chunk2?:b-\d+$/.test(text))).toBe(true);
  });
});
