import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { GatewayServer, type GatewayServerOptions } from './server.js';
import { GatewayErrors } from './protocol.js';
import type { GatewayRpcConnection } from './transport.js';
import type { SessionHmacKeyring } from '../../persistence/journals/journal-utils.js';
import type { GatewayAuditStorePort } from './audit-port.js';
import type { GatewayMultiCompanionConfig } from './multi-companion.js';
import {
  GatewayCompanionChannelLane,
  type CompanionPresenceReadRow,
} from './companion-channels.js';
import type { PlacesRegistryConfig } from '../../shared/contracts/places-registry.js';

// ── W6 inter-companion channel lane: gateway routing tests ──
// The lane is the ONLY path between companions: sends resolve fail-closed
// (unbound sender, unknown place, non-participant/unknown/offline DM peer all
// alarm + reject), room recipients come from shared-schema presence excluding
// the sender, and every delivery is an ordinary inbound channel notification.

vi.mock('./transport.js', () => ({
  createSocketServer: vi.fn(),
  createWebSocketRpcServer: vi.fn(),
}));

import { createSocketServer } from './transport.js';

const mockedCreateSocketServer = vi.mocked(createSocketServer);

const TEST_SESSION_HMAC_KEYRING: SessionHmacKeyring = {
  activeVersion: 'v1',
  keys: { v1: 'test-session-secret' },
};

const TEST_WYOMING_SHARD_ROUTING = { enabled: false };

const NOW = Date.parse('2026-07-08T12:00:00Z');
const FRESH = new Date(NOW - 1_000).toISOString();
const STALE = new Date(NOW - 60 * 60_000).toISOString();

const PLACES: PlacesRegistryConfig = {
  schemaVersion: 1,
  sites: [{ siteId: 'vhome', displayName: 'Virtual Home', kind: 'virtual' }],
  places: [{
    placeId: 'living_room',
    siteId: 'vhome',
    displayName: 'Living Room',
    kind: 'virtual',
    affordances: [],
  }],
};

type MockConnection = {
  conn: GatewayRpcConnection;
  sent: unknown[];
  _emit(message: unknown): void;
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
  };

  return {
    conn: conn as unknown as GatewayRpcConnection,
    sent,
    _emit: conn._emit,
  };
}

function createMockAuditStore(): GatewayAuditStorePort {
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
  };
}

function createMinimalOptions(): GatewayServerOptions {
  return {
    socketPath: '/tmp/test.sock',
    llmProvider: { stream: vi.fn(), complete: vi.fn() } as any,
    embeddingService: { embed: vi.fn(), embedBatch: vi.fn(), dims: 1024 } as any,
    discordAdapter: {
      id: 'discord',
      outbound: { textChunkLimit: 2000, sendText: vi.fn() },
    } as any,
    policyConfig: { workspacePath: '/workspace' },
    sessionHmacKeyring: TEST_SESSION_HMAC_KEYRING,
    wyomingShardRouting: TEST_WYOMING_SHARD_ROUTING,
  };
}

function multiCompanion(): GatewayMultiCompanionConfig {
  return { enabled: true, channelRouting: {}, discordAccounts: {} };
}

function makeLane(input: {
  presenceRows?: Record<string, CompanionPresenceReadRow[]>;
  fleet?: string[];
}): GatewayCompanionChannelLane {
  return new GatewayCompanionChannelLane({
    placesRegistry: PLACES,
    presence: {
      listByPlace: async (siteId, placeId) => input.presenceRows?.[`${siteId}/${placeId}`] ?? [],
    },
    fleetCompanionIds: new Set(input.fleet ?? []),
    now: () => NOW,
  });
}

async function setupServer(options: GatewayServerOptions): Promise<{
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
  conn._emit({ jsonrpc: '2.0', id, method, params });
  for (let attempt = 0; attempt < 60; attempt++) {
    const response = conn.sent.find(
      (msg: any) => msg.id === id && ('result' in msg || 'error' in msg),
    );
    if (response) return response;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error(`No RPC response found for id ${id}`);
}

async function identifyAgent(conn: MockConnection, companionId: string, rpcId = 900): Promise<any> {
  return await invokeRpc(conn, rpcId, 'gateway.client.identify', { role: 'agent', companionId });
}

function methodFrames(conn: MockConnection, method: string): any[] {
  return conn.sent.filter((msg: any) => msg.method === method);
}

function auditedEvents(auditStore: GatewayAuditStorePort): string[] {
  return vi.mocked(auditStore.append).mock.calls.map(([entry]: any[]) => entry.method as string);
}

describe('companion.message.send routing (W6)', () => {
  it('fails closed when multi-companion is off: the lane does not exist', async () => {
    const { connect } = await setupServer(createMinimalOptions());
    const agent = await connect();
    const response = await invokeRpc(agent, 1, 'companion.message.send', {
      channelId: 'companion-room:living_room',
      content: 'hello?',
    });
    expect(response.error).toBeDefined();
    expect(String(response.error.message)).toMatch(/single-companion topology/i);
  });

  it('rejects a companionChannels lane at construction when the flag is off', () => {
    expect(() => new GatewayServer({
      ...createMinimalOptions(),
      companionChannels: makeLane({}),
    })).toThrow(/multi-companion is disabled/i);
  });

  it('rejects sends from unidentified agent connections fail-closed', async () => {
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion(),
      companionChannels: makeLane({}),
    });
    const agent = await connect();
    const response = await invokeRpc(agent, 1, 'companion.message.send', {
      channelId: 'companion-room:living_room',
      content: 'hello?',
    });
    expect(response.error?.code).toBe(GatewayErrors.COMPANION_IDENTIFY_REQUIRED);
  });

  it('disconnects a sender that spoofs a different companionId in params', async () => {
    const auditStore = createMockAuditStore();
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion(),
      companionChannels: makeLane({}),
      auditStore,
    });
    const agent = await connect();
    await identifyAgent(agent, 'comp-a');

    agent._emit({
      jsonrpc: '2.0',
      id: 2,
      method: 'companion.message.send',
      params: {
        channelId: 'companion-room:living_room',
        content: 'spoofed',
        companionId: 'comp-b',
      },
    });
    await vi.waitFor(() => {
      expect(agent.conn.destroyed).toBe(true);
    });
    await vi.waitFor(() => {
      expect(auditedEvents(auditStore)).toContain('gateway.companion.identity_mismatch');
    });
  });

  it('delivers a room message to present companions, excluding the sender and skipping offline members', async () => {
    const auditStore = createMockAuditStore();
    const lane = makeLane({
      presenceRows: {
        'vhome/living_room': [
          { companionId: 'comp-a', updatedAt: FRESH }, // the sender
          { companionId: 'comp-b', updatedAt: FRESH },
          { companionId: 'comp-c', updatedAt: FRESH }, // present but offline
          { companionId: 'comp-d', updatedAt: STALE }, // stale row: gone
        ],
      },
    });
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion(),
      companionChannels: lane,
      auditStore,
    });
    const agentA = await connect();
    const agentB = await connect();
    await identifyAgent(agentA, 'comp-a');
    await identifyAgent(agentB, 'comp-b', 901);

    const response = await invokeRpc(agentA, 10, 'companion.message.send', {
      channelId: 'companion-room:living_room',
      content: 'good morning, room',
      authorName: 'Selene',
      companionId: 'comp-a',
    });

    expect(response.result).toMatchObject({
      channelId: 'companion-room:living_room',
      deliveredTo: ['comp-b'],
      skippedOffline: ['comp-c'],
    });
    expect(typeof response.result.messageId).toBe('string');

    // The recipient got an ordinary inbound channel message with a
    // gateway-authoritative envelope (MI marker, sender identity, channel type).
    const delivered = methodFrames(agentB, 'companion.message');
    expect(delivered).toHaveLength(1);
    const message = delivered[0].params.message;
    expect(message).toMatchObject({
      channelId: 'companion-room:living_room',
      channelType: 'companion',
      authorId: 'comp-a',
      authorName: 'Selene',
      content: 'good morning, room',
      isDirectMessage: false,
      routing: {
        source: 'companion',
        authorIsMachineIntelligence: true,
      },
    });
    expect(message.id).toBe(response.result.messageId);

    // The sender NEVER receives its own message back.
    expect(methodFrames(agentA, 'companion.message')).toHaveLength(0);

    // Provenance rides the existing gateway audit path.
    const sendAudit = vi.mocked(auditStore.append).mock.calls
      .map(([entry]: any[]) => entry)
      .find((entry: any) => entry.method === 'companion.message.send');
    expect(sendAudit?.params).toMatchObject({
      senderCompanionId: 'comp-a',
      channelId: 'companion-room:living_room',
    });
  });

  it('fails closed on a room addressed at an unknown place', async () => {
    const auditStore = createMockAuditStore();
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion(),
      companionChannels: makeLane({}),
      auditStore,
    });
    const agent = await connect();
    await identifyAgent(agent, 'comp-a');

    const response = await invokeRpc(agent, 11, 'companion.message.send', {
      channelId: 'companion-room:no_such_place',
      content: 'anyone here?',
      companionId: 'comp-a',
    });
    expect(response.error?.code).toBe(GatewayErrors.COMPANION_ROUTING_UNAVAILABLE);
    await vi.waitFor(() => {
      expect(auditedEvents(auditStore)).toContain('gateway.companion.companion_unknown_place');
    });
  });

  it('fails closed on an unparseable companion channelId', async () => {
    const auditStore = createMockAuditStore();
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion(),
      companionChannels: makeLane({}),
      auditStore,
    });
    const agent = await connect();
    await identifyAgent(agent, 'comp-a');

    const response = await invokeRpc(agent, 12, 'companion.message.send', {
      channelId: 'discord:general',
      content: 'wrong lane',
      companionId: 'comp-a',
    });
    expect(response.error?.code).toBe(GatewayErrors.COMPANION_ROUTING_UNAVAILABLE);
    await vi.waitFor(() => {
      expect(auditedEvents(auditStore)).toContain('gateway.companion.companion_channel_unparseable');
    });
  });

  it('delivers a DM to the addressed peer under the canonical shared channelId', async () => {
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion(),
      companionChannels: makeLane({ fleet: ['comp-a', 'comp-b'] }),
    });
    const agentA = await connect();
    const agentB = await connect();
    await identifyAgent(agentA, 'comp-a');
    await identifyAgent(agentB, 'comp-b', 901);

    const response = await invokeRpc(agentA, 20, 'companion.message.send', {
      channelId: 'companion-dm:comp-a:comp-b',
      content: 'psst, over here',
      companionId: 'comp-a',
    });
    expect(response.result).toMatchObject({ deliveredTo: ['comp-b'], skippedOffline: [] });

    const delivered = methodFrames(agentB, 'companion.message');
    expect(delivered).toHaveLength(1);
    expect(delivered[0].params.message).toMatchObject({
      channelId: 'companion-dm:comp-a:comp-b',
      isDirectMessage: true,
      authorId: 'comp-a',
    });

    // The peer replies on the SAME channelId (pair ordering is canonical).
    const reply = await invokeRpc(agentB, 21, 'companion.message.send', {
      channelId: 'companion-dm:comp-a:comp-b',
      content: 'heard you',
      companionId: 'comp-b',
    });
    expect(reply.result).toMatchObject({ deliveredTo: ['comp-a'] });
    expect(methodFrames(agentA, 'companion.message')[0].params.message.channelId)
      .toBe('companion-dm:comp-a:comp-b');
  });

  it('fails a DM closed when the sender is not a participant of the pair', async () => {
    const auditStore = createMockAuditStore();
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion(),
      companionChannels: makeLane({ fleet: ['comp-a', 'comp-b', 'comp-c'] }),
      auditStore,
    });
    const agent = await connect();
    await identifyAgent(agent, 'comp-a');

    const response = await invokeRpc(agent, 30, 'companion.message.send', {
      channelId: 'companion-dm:comp-b:comp-c',
      content: 'let me in',
      companionId: 'comp-a',
    });
    expect(response.error?.code).toBe(GatewayErrors.COMPANION_ROUTING_UNAVAILABLE);
    await vi.waitFor(() => {
      expect(auditedEvents(auditStore)).toContain('gateway.companion.companion_dm_sender_not_participant');
    });
  });

  it('fails a DM closed when the peer is not a fleet member', async () => {
    const auditStore = createMockAuditStore();
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion(),
      companionChannels: makeLane({ fleet: ['comp-a'] }),
      auditStore,
    });
    const agent = await connect();
    await identifyAgent(agent, 'comp-a');

    const response = await invokeRpc(agent, 31, 'companion.message.send', {
      channelId: 'companion-dm:comp-a:comp-x',
      content: 'hello stranger',
      companionId: 'comp-a',
    });
    expect(response.error?.code).toBe(GatewayErrors.COMPANION_ROUTING_UNAVAILABLE);
    await vi.waitFor(() => {
      expect(auditedEvents(auditStore)).toContain('gateway.companion.companion_dm_unknown_peer');
    });
  });

  it('fails a DM closed when the peer has no live connection', async () => {
    const auditStore = createMockAuditStore();
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion(),
      companionChannels: makeLane({ fleet: ['comp-a', 'comp-b'] }),
      auditStore,
    });
    const agent = await connect();
    await identifyAgent(agent, 'comp-a');

    const response = await invokeRpc(agent, 32, 'companion.message.send', {
      channelId: 'companion-dm:comp-a:comp-b',
      content: 'are you there?',
      companionId: 'comp-a',
    });
    expect(response.error?.code).toBe(GatewayErrors.COMPANION_ROUTING_UNAVAILABLE);
    expect(String(response.error.message)).toMatch(/not connected/i);
    await vi.waitFor(() => {
      expect(auditedEvents(auditStore)).toContain('gateway.companion.companion_dm_peer_unavailable');
    });
  });

  it('rejects malformed params fail-closed', async () => {
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion(),
      companionChannels: makeLane({}),
    });
    const agent = await connect();
    await identifyAgent(agent, 'comp-a');

    const noContent = await invokeRpc(agent, 40, 'companion.message.send', {
      channelId: 'companion-room:living_room',
      content: '   ',
      companionId: 'comp-a',
    });
    expect(noContent.error).toBeDefined();

    const noChannel = await invokeRpc(agent, 41, 'companion.message.send', {
      content: 'floating message',
      companionId: 'comp-a',
    });
    expect(noChannel.error).toBeDefined();
  });
});
