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
import { deriveCompanionAuthToken } from './companion-auth.js';
import { EventBus } from '../../shared/event-bus.js';

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
  places: [
    {
      placeId: 'living_room',
      siteId: 'vhome',
      displayName: 'Living Room',
      kind: 'virtual',
      affordances: [],
    },
    {
      placeId: 'den',
      siteId: 'vhome',
      displayName: 'Den',
      kind: 'virtual',
      privacy: 'private',
      affordances: [],
    },
  ],
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
    eventBus: new EventBus(),
  };
}

function multiCompanion(): GatewayMultiCompanionConfig {
  return {
    enabled: true,
    fleetCompanionIds: ['11111111-1111-4111-8111-aaaaaaaaaaaa', '22222222-2222-4222-8222-bbbbbbbbbbbb', '33333333-3333-4333-8333-333333333333'],
    channelRouting: {},
    discordAccounts: {},
    personalWorkspaceByCompanionId: {
      '11111111-1111-4111-8111-aaaaaaaaaaaa': '/workspace/11111111-1111-4111-8111-aaaaaaaaaaaa',
      '22222222-2222-4222-8222-bbbbbbbbbbbb': '/workspace/22222222-2222-4222-8222-bbbbbbbbbbbb',
      '33333333-3333-4333-8333-333333333333': '/workspace/33333333-3333-4333-8333-333333333333',
    },
  };
}

function makeLane(input: {
  presenceRows?: Record<string, CompanionPresenceReadRow[]>;
  fleet?: string[];
  now?: () => number;
}): GatewayCompanionChannelLane {
  return new GatewayCompanionChannelLane({
    placesRegistry: PLACES,
    presence: {
      listByPlace: async (siteId, placeId) => input.presenceRows?.[`${siteId}/${placeId}`] ?? [],
    },
    fleetCompanionIds: new Set(input.fleet ?? []),
    now: input.now ?? (() => NOW),
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
  return await invokeRpc(conn, rpcId, 'gateway.client.identify', {
    role: 'agent',
    companionId,
    authToken: deriveCompanionAuthToken(companionId, 'agent', TEST_SESSION_HMAC_KEYRING),
  });
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
    await identifyAgent(agent, '11111111-1111-4111-8111-aaaaaaaaaaaa');

    agent._emit({
      jsonrpc: '2.0',
      id: 2,
      method: 'companion.message.send',
      params: {
        channelId: 'companion-room:living_room',
        content: 'spoofed',
        companionId: '22222222-2222-4222-8222-bbbbbbbbbbbb',
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
          { companionId: '11111111-1111-4111-8111-aaaaaaaaaaaa', updatedAt: FRESH }, // the sender
          { companionId: '22222222-2222-4222-8222-bbbbbbbbbbbb', updatedAt: FRESH },
          { companionId: '33333333-3333-4333-8333-333333333333', updatedAt: FRESH }, // present but offline
          { companionId: '44444444-4444-4444-8444-444444444444', updatedAt: STALE }, // stale row: gone
        ],
      },
    });
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion(),
      companionChannels: lane,
      companionChannelNow: () => NOW,
      auditStore,
    });
    const agentA = await connect();
    const agentB = await connect();
    await identifyAgent(agentA, '11111111-1111-4111-8111-aaaaaaaaaaaa');
    await identifyAgent(agentB, '22222222-2222-4222-8222-bbbbbbbbbbbb', 901);

    const response = await invokeRpc(agentA, 10, 'companion.message.send', {
      channelId: 'companion-room:living_room',
      content: 'good morning, room',
      authorName: 'Selene',
      companionId: '11111111-1111-4111-8111-aaaaaaaaaaaa',
    });

    expect(response.result).toMatchObject({
      channelId: 'companion-room:living_room',
      deliveredTo: ['22222222-2222-4222-8222-bbbbbbbbbbbb'],
      skippedOffline: ['33333333-3333-4333-8333-333333333333'],
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
      authorId: '11111111-1111-4111-8111-aaaaaaaaaaaa',
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
      senderCompanionId: '11111111-1111-4111-8111-aaaaaaaaaaaa',
      channelId: 'companion-room:living_room',
    });
  });

  it('stamps private room privacy and place metadata on the authoritative envelope', async () => {
    const lane = makeLane({
      presenceRows: {
        'vhome/den': [
          { companionId: '11111111-1111-4111-8111-aaaaaaaaaaaa', updatedAt: FRESH, since: new Date(NOW - 60_000).toISOString() },
          { companionId: '22222222-2222-4222-8222-bbbbbbbbbbbb', updatedAt: FRESH, since: new Date(NOW - 60_000).toISOString() },
        ],
      },
    });
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion(),
      companionChannels: lane,
      companionChannelNow: () => NOW,
    });
    const agentA = await connect();
    const agentB = await connect();
    await identifyAgent(agentA, '11111111-1111-4111-8111-aaaaaaaaaaaa');
    await identifyAgent(agentB, '22222222-2222-4222-8222-bbbbbbbbbbbb', 901);

    const response = await invokeRpc(agentA, 11, 'companion.message.send', {
      channelId: 'companion-room:den',
      content: 'private room line',
      companionId: '11111111-1111-4111-8111-aaaaaaaaaaaa',
    });

    expect(response.result.deliveredTo).toEqual(['22222222-2222-4222-8222-bbbbbbbbbbbb']);
    expect(methodFrames(agentB, 'companion.message')[0]?.params.message.routing).toMatchObject({
      source: 'companion',
      channelPrivacy: 'private',
      room: { placeId: 'den', privacy: 'private' },
    });
  });

  it('requires sender presence but permits one verified reply after the sender row goes stale', async () => {
    const auditStore = createMockAuditStore();
    let now = NOW;
    const presenceSince = new Date(NOW - 60_000).toISOString();
    const updatedAt = new Date(now).toISOString();
    const presenceRows: Record<string, CompanionPresenceReadRow[]> = {
      'vhome/living_room': [
        { companionId: '11111111-1111-4111-8111-aaaaaaaaaaaa', updatedAt, since: presenceSince },
        { companionId: '22222222-2222-4222-8222-bbbbbbbbbbbb', updatedAt, since: presenceSince },
      ],
    };
    const lane = makeLane({ presenceRows, now: () => now });
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion(),
      companionChannels: lane,
      companionChannelNow: () => now,
      auditStore,
    });
    const agentA = await connect();
    const agentB = await connect();
    await identifyAgent(agentA, '11111111-1111-4111-8111-aaaaaaaaaaaa');
    await identifyAgent(agentB, '22222222-2222-4222-8222-bbbbbbbbbbbb', 901);

    const opening = await invokeRpc(agentA, 13, 'companion.message.send', {
      channelId: 'companion-room:living_room',
      content: 'are you still there?',
      companionId: '11111111-1111-4111-8111-aaaaaaaaaaaa',
    });
    expect(opening.result.deliveredTo).toEqual(['22222222-2222-4222-8222-bbbbbbbbbbbb']);

    now += 5 * 60_000;
    const refreshedAt = new Date(now).toISOString();
    presenceRows['vhome/living_room'] = [
      { companionId: '11111111-1111-4111-8111-aaaaaaaaaaaa', updatedAt: refreshedAt, since: presenceSince },
      { companionId: '22222222-2222-4222-8222-bbbbbbbbbbbb', updatedAt: refreshedAt, since: presenceSince },
    ];
    now += 15 * 60_000 + 1;
    presenceRows['vhome/living_room'] = [
      { companionId: '11111111-1111-4111-8111-aaaaaaaaaaaa', updatedAt: new Date(now).toISOString(), since: presenceSince },
      { companionId: '22222222-2222-4222-8222-bbbbbbbbbbbb', updatedAt: refreshedAt, since: presenceSince },
    ];
    const reply = await invokeRpc(agentB, 14, 'companion.message.send', {
      channelId: 'companion-room:living_room',
      content: 'finishing this exchange',
      companionId: '22222222-2222-4222-8222-bbbbbbbbbbbb',
      replyToMessageId: opening.result.messageId,
    });
    expect(reply.result.deliveredTo).toEqual(['11111111-1111-4111-8111-aaaaaaaaaaaa']);
    expect(methodFrames(agentA, 'companion.message').at(-1)?.params.message).toMatchObject({
      replyToMessageId: opening.result.messageId,
      routing: {
        channelPrivacy: 'public',
        room: { placeId: 'living_room', privacy: 'public' },
      },
    });

    const replay = await invokeRpc(agentB, 15, 'companion.message.send', {
      channelId: 'companion-room:living_room',
      content: 'trying to continue while absent',
      companionId: '22222222-2222-4222-8222-bbbbbbbbbbbb',
      replyToMessageId: opening.result.messageId,
    });
    expect(replay.error?.code).toBe(GatewayErrors.COMPANION_ROUTING_UNAVAILABLE);

    const absentInitiation = await invokeRpc(agentB, 16, 'companion.message.send', {
      channelId: 'companion-room:living_room',
      content: 'new topic while absent',
      companionId: '22222222-2222-4222-8222-bbbbbbbbbbbb',
    });
    expect(absentInitiation.error?.code).toBe(GatewayErrors.COMPANION_ROUTING_UNAVAILABLE);

    now += 1;
    presenceRows['vhome/living_room'] = [
      { companionId: '11111111-1111-4111-8111-aaaaaaaaaaaa', updatedAt: new Date(now).toISOString(), since: presenceSince },
      { companionId: '22222222-2222-4222-8222-bbbbbbbbbbbb', updatedAt: new Date(now).toISOString(), since: presenceSince },
    ];
    const secondOpening = await invokeRpc(agentA, 17, 'companion.message.send', {
      channelId: 'companion-room:living_room',
      content: 'one more question',
      companionId: '11111111-1111-4111-8111-aaaaaaaaaaaa',
    });
    expect(secondOpening.result.deliveredTo).toEqual(['22222222-2222-4222-8222-bbbbbbbbbbbb']);

    now += 15 * 60_000 + 1;
    presenceRows['vhome/living_room'] = [
      { companionId: '11111111-1111-4111-8111-aaaaaaaaaaaa', updatedAt: new Date(now).toISOString(), since: presenceSince },
      { companionId: '33333333-3333-4333-8333-333333333333', updatedAt: new Date(now).toISOString(), since: new Date(now).toISOString() },
    ];
    const afterLeave = await invokeRpc(agentB, 18, 'companion.message.send', {
      channelId: 'companion-room:living_room',
      content: 'must not reach the new occupant',
      companionId: '22222222-2222-4222-8222-bbbbbbbbbbbb',
      replyToMessageId: secondOpening.result.messageId,
    });
    expect(afterLeave.error?.code).toBe(GatewayErrors.COMPANION_ROUTING_UNAVAILABLE);
    expect(methodFrames(agentA, 'companion.message')
      .some(frame => frame.params.message.content === 'must not reach the new occupant')).toBe(false);
    await vi.waitFor(() => {
      expect(auditedEvents(auditStore)).toContain('gateway.companion.companion_room_sender_not_present');
    });
  });

  it('consumes a valid room reply receipt on first use while the sender is still present', async () => {
    let now = NOW;
    const presenceSince = new Date(NOW - 60_000).toISOString();
    const presenceRows: Record<string, CompanionPresenceReadRow[]> = {
      'vhome/living_room': [
        { companionId: '11111111-1111-4111-8111-aaaaaaaaaaaa', updatedAt: new Date(now).toISOString(), since: presenceSince },
        { companionId: '22222222-2222-4222-8222-bbbbbbbbbbbb', updatedAt: new Date(now).toISOString(), since: presenceSince },
      ],
    };
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion(),
      companionChannels: makeLane({ presenceRows, now: () => now }),
      companionChannelNow: () => now,
    });
    const agentA = await connect();
    const agentB = await connect();
    await identifyAgent(agentA, '11111111-1111-4111-8111-aaaaaaaaaaaa');
    await identifyAgent(agentB, '22222222-2222-4222-8222-bbbbbbbbbbbb', 901);

    const opening = await invokeRpc(agentA, 60, 'companion.message.send', {
      channelId: 'companion-room:living_room',
      content: 'opening',
      companionId: '11111111-1111-4111-8111-aaaaaaaaaaaa',
    });
    const firstReply = await invokeRpc(agentB, 61, 'companion.message.send', {
      channelId: 'companion-room:living_room',
      content: 'reply while present',
      companionId: '22222222-2222-4222-8222-bbbbbbbbbbbb',
      replyToMessageId: opening.result.messageId,
    });
    expect(firstReply.result.deliveredTo).toEqual(['11111111-1111-4111-8111-aaaaaaaaaaaa']);

    now += 15 * 60_000 + 1;
    presenceRows['vhome/living_room'] = [
      { companionId: '11111111-1111-4111-8111-aaaaaaaaaaaa', updatedAt: new Date(now).toISOString(), since: presenceSince },
      { companionId: '22222222-2222-4222-8222-bbbbbbbbbbbb', updatedAt: new Date(NOW).toISOString(), since: presenceSince },
    ];
    const replay = await invokeRpc(agentB, 62, 'companion.message.send', {
      channelId: 'companion-room:living_room',
      content: 'must not reuse the reply id',
      companionId: '22222222-2222-4222-8222-bbbbbbbbbbbb',
      replyToMessageId: opening.result.messageId,
    });
    expect(replay.error?.code).toBe(GatewayErrors.COMPANION_ROUTING_UNAVAILABLE);
    expect(methodFrames(agentA, 'companion.message')
      .some(frame => frame.params.message.content === 'must not reuse the reply id')).toBe(false);
  });

  it('rejects arbitrary and expired room reply lineage even while the sender is present', async () => {
    let now = NOW;
    const presenceSince = new Date(NOW - 60_000).toISOString();
    const presenceRows: Record<string, CompanionPresenceReadRow[]> = {
      'vhome/living_room': [
        { companionId: '11111111-1111-4111-8111-aaaaaaaaaaaa', updatedAt: new Date(now).toISOString(), since: presenceSince },
        { companionId: '22222222-2222-4222-8222-bbbbbbbbbbbb', updatedAt: new Date(now).toISOString(), since: presenceSince },
      ],
    };
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion(),
      companionChannels: makeLane({ presenceRows, now: () => now }),
      companionChannelNow: () => now,
    });
    const agentA = await connect();
    const agentB = await connect();
    await identifyAgent(agentA, '11111111-1111-4111-8111-aaaaaaaaaaaa');
    await identifyAgent(agentB, '22222222-2222-4222-8222-bbbbbbbbbbbb', 901);

    const arbitrary = await invokeRpc(agentB, 63, 'companion.message.send', {
      channelId: 'companion-room:living_room',
      content: 'forged lineage',
      companionId: '22222222-2222-4222-8222-bbbbbbbbbbbb',
      replyToMessageId: 'companion-never-delivered',
    });
    expect(arbitrary.error?.code).toBe(GatewayErrors.COMPANION_ROUTING_UNAVAILABLE);

    const opening = await invokeRpc(agentA, 64, 'companion.message.send', {
      channelId: 'companion-room:living_room',
      content: 'expires before reply',
      companionId: '11111111-1111-4111-8111-aaaaaaaaaaaa',
    });
    now += 60 * 60_000 + 1;
    presenceRows['vhome/living_room'] = [
      { companionId: '11111111-1111-4111-8111-aaaaaaaaaaaa', updatedAt: new Date(now).toISOString(), since: presenceSince },
      { companionId: '22222222-2222-4222-8222-bbbbbbbbbbbb', updatedAt: new Date(now).toISOString(), since: presenceSince },
    ];
    const expired = await invokeRpc(agentB, 65, 'companion.message.send', {
      channelId: 'companion-room:living_room',
      content: 'expired lineage',
      companionId: '22222222-2222-4222-8222-bbbbbbbbbbbb',
      replyToMessageId: opening.result.messageId,
    });
    expect(expired.error?.code).toBe(GatewayErrors.COMPANION_ROUTING_UNAVAILABLE);
    expect(methodFrames(agentA, 'companion.message')
      .some(frame => frame.params.message.content === 'forged lineage'
        || frame.params.message.content === 'expired lineage')).toBe(false);
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
    await identifyAgent(agent, '11111111-1111-4111-8111-aaaaaaaaaaaa');

    const response = await invokeRpc(agent, 11, 'companion.message.send', {
      channelId: 'companion-room:no_such_place',
      content: 'anyone here?',
      companionId: '11111111-1111-4111-8111-aaaaaaaaaaaa',
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
    await identifyAgent(agent, '11111111-1111-4111-8111-aaaaaaaaaaaa');

    const response = await invokeRpc(agent, 12, 'companion.message.send', {
      channelId: 'companion-dm:11111111-1111-4111-8111-aaaaaaaaaaaa!:22222222-2222-4222-8222-bbbbbbbbbbbb',
      content: 'malformed companion lane',
      companionId: '11111111-1111-4111-8111-aaaaaaaaaaaa',
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
      companionChannels: makeLane({ fleet: ['11111111-1111-4111-8111-aaaaaaaaaaaa', '22222222-2222-4222-8222-bbbbbbbbbbbb'] }),
    });
    const agentA = await connect();
    const agentB = await connect();
    await identifyAgent(agentA, '11111111-1111-4111-8111-aaaaaaaaaaaa');
    await identifyAgent(agentB, '22222222-2222-4222-8222-bbbbbbbbbbbb', 901);

    const response = await invokeRpc(agentA, 20, 'companion.message.send', {
      channelId: 'companion-dm:11111111-1111-4111-8111-aaaaaaaaaaaa:22222222-2222-4222-8222-bbbbbbbbbbbb',
      content: 'psst, over here',
      companionId: '11111111-1111-4111-8111-aaaaaaaaaaaa',
    });
    expect(response.result).toMatchObject({ deliveredTo: ['22222222-2222-4222-8222-bbbbbbbbbbbb'], skippedOffline: [] });

    const delivered = methodFrames(agentB, 'companion.message');
    expect(delivered).toHaveLength(1);
    expect(delivered[0].params.message).toMatchObject({
      channelId: 'companion-dm:11111111-1111-4111-8111-aaaaaaaaaaaa:22222222-2222-4222-8222-bbbbbbbbbbbb',
      isDirectMessage: true,
      authorId: '11111111-1111-4111-8111-aaaaaaaaaaaa',
    });

    // The peer replies on the SAME channelId (pair ordering is canonical).
    const reply = await invokeRpc(agentB, 21, 'companion.message.send', {
      channelId: 'companion-dm:11111111-1111-4111-8111-aaaaaaaaaaaa:22222222-2222-4222-8222-bbbbbbbbbbbb',
      content: 'heard you',
      companionId: '22222222-2222-4222-8222-bbbbbbbbbbbb',
      replyToMessageId: response.result.messageId,
    });
    expect(reply.result).toMatchObject({ deliveredTo: ['11111111-1111-4111-8111-aaaaaaaaaaaa'] });
    expect(methodFrames(agentA, 'companion.message')[0].params.message).toMatchObject({
      channelId: 'companion-dm:11111111-1111-4111-8111-aaaaaaaaaaaa:22222222-2222-4222-8222-bbbbbbbbbbbb',
      replyToMessageId: response.result.messageId,
    });

    const forged = await invokeRpc(agentB, 22, 'companion.message.send', {
      channelId: 'companion-dm:11111111-1111-4111-8111-aaaaaaaaaaaa:22222222-2222-4222-8222-bbbbbbbbbbbb',
      content: 'forged dm lineage',
      companionId: '22222222-2222-4222-8222-bbbbbbbbbbbb',
      replyToMessageId: 'companion-never-delivered',
    });
    expect(forged.error?.code).toBe(GatewayErrors.COMPANION_ROUTING_UNAVAILABLE);
    expect(methodFrames(agentA, 'companion.message')
      .some(frame => frame.params.message.content === 'forged dm lineage')).toBe(false);
  });

  it('routes a verified delivery failure to the original sender as a structured notification', async () => {
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion(),
      companionChannels: makeLane({ fleet: ['11111111-1111-4111-8111-aaaaaaaaaaaa', '22222222-2222-4222-8222-bbbbbbbbbbbb'] }),
    });
    const agentA = await connect();
    const agentB = await connect();
    await identifyAgent(agentA, '11111111-1111-4111-8111-aaaaaaaaaaaa');
    await identifyAgent(agentB, '22222222-2222-4222-8222-bbbbbbbbbbbb', 901);

    const send = await invokeRpc(agentA, 22, 'companion.message.send', {
      channelId: 'companion-dm:11111111-1111-4111-8111-aaaaaaaaaaaa:22222222-2222-4222-8222-bbbbbbbbbbbb',
      content: 'message that fails remotely',
      companionId: '11111111-1111-4111-8111-aaaaaaaaaaaa',
    });
    const report = await invokeRpc(agentB, 23, 'companion.message.report_failure', {
      channelId: 'companion-dm:11111111-1111-4111-8111-aaaaaaaaaaaa:22222222-2222-4222-8222-bbbbbbbbbbbb',
      messageId: send.result.messageId,
      reason: 'processing_failed',
      companionId: '22222222-2222-4222-8222-bbbbbbbbbbbb',
    });

    expect(report.result).toEqual({ reportedTo: '11111111-1111-4111-8111-aaaaaaaaaaaa' });
    const failures = methodFrames(agentA, 'companion.message.delivery_failure');
    expect(failures).toHaveLength(1);
    expect(failures[0].params).toMatchObject({
      channelId: 'companion-dm:11111111-1111-4111-8111-aaaaaaaaaaaa:22222222-2222-4222-8222-bbbbbbbbbbbb',
      messageId: send.result.messageId,
      reportingCompanionId: '22222222-2222-4222-8222-bbbbbbbbbbbb',
      reason: 'processing_failed',
      reportedAt: expect.any(String),
    });
    expect(methodFrames(agentB, 'companion.message.delivery_failure')).toHaveLength(0);
  });

  it('rejects a failure report without a matching delivery receipt', async () => {
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion(),
      companionChannels: makeLane({ fleet: ['11111111-1111-4111-8111-aaaaaaaaaaaa', '22222222-2222-4222-8222-bbbbbbbbbbbb'] }),
    });
    const agentB = await connect();
    await identifyAgent(agentB, '22222222-2222-4222-8222-bbbbbbbbbbbb');

    const report = await invokeRpc(agentB, 24, 'companion.message.report_failure', {
      channelId: 'companion-dm:11111111-1111-4111-8111-aaaaaaaaaaaa:22222222-2222-4222-8222-bbbbbbbbbbbb',
      messageId: 'companion-not-delivered-here',
      reason: 'processing_failed',
      companionId: '22222222-2222-4222-8222-bbbbbbbbbbbb',
    });

    expect(report.error?.code).toBe(GatewayErrors.COMPANION_ROUTING_UNAVAILABLE);
  });

  it('fails a DM closed when the sender is not a participant of the pair', async () => {
    const auditStore = createMockAuditStore();
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion(),
      companionChannels: makeLane({ fleet: ['11111111-1111-4111-8111-aaaaaaaaaaaa', '22222222-2222-4222-8222-bbbbbbbbbbbb', '33333333-3333-4333-8333-333333333333'] }),
      auditStore,
    });
    const agent = await connect();
    await identifyAgent(agent, '11111111-1111-4111-8111-aaaaaaaaaaaa');

    const response = await invokeRpc(agent, 30, 'companion.message.send', {
      channelId: 'companion-dm:22222222-2222-4222-8222-bbbbbbbbbbbb:33333333-3333-4333-8333-333333333333',
      content: 'let me in',
      companionId: '11111111-1111-4111-8111-aaaaaaaaaaaa',
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
      companionChannels: makeLane({ fleet: ['11111111-1111-4111-8111-aaaaaaaaaaaa'] }),
      auditStore,
    });
    const agent = await connect();
    await identifyAgent(agent, '11111111-1111-4111-8111-aaaaaaaaaaaa');

    const response = await invokeRpc(agent, 31, 'companion.message.send', {
      channelId: 'companion-dm:11111111-1111-4111-8111-aaaaaaaaaaaa:55555555-5555-4555-8555-555555555555',
      content: 'hello stranger',
      companionId: '11111111-1111-4111-8111-aaaaaaaaaaaa',
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
      companionChannels: makeLane({ fleet: ['11111111-1111-4111-8111-aaaaaaaaaaaa', '22222222-2222-4222-8222-bbbbbbbbbbbb'] }),
      auditStore,
    });
    const agent = await connect();
    await identifyAgent(agent, '11111111-1111-4111-8111-aaaaaaaaaaaa');

    const response = await invokeRpc(agent, 32, 'companion.message.send', {
      channelId: 'companion-dm:11111111-1111-4111-8111-aaaaaaaaaaaa:22222222-2222-4222-8222-bbbbbbbbbbbb',
      content: 'are you there?',
      companionId: '11111111-1111-4111-8111-aaaaaaaaaaaa',
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
    await identifyAgent(agent, '11111111-1111-4111-8111-aaaaaaaaaaaa');

    const noContent = await invokeRpc(agent, 40, 'companion.message.send', {
      channelId: 'companion-room:living_room',
      content: '   ',
      companionId: '11111111-1111-4111-8111-aaaaaaaaaaaa',
    });
    expect(noContent.error).toBeDefined();

    const noChannel = await invokeRpc(agent, 41, 'companion.message.send', {
      content: 'floating message',
      companionId: '11111111-1111-4111-8111-aaaaaaaaaaaa',
    });
    expect(noChannel.error).toBeDefined();
  });
});
