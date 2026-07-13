import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import type {
  IcpConversationTransitionInput,
  IcpPermitConsumptionInput,
  IcpPermitConsumptionResult,
  IcpSharedAutonomyStorePort,
} from '../../core/icp/autonomy-store-ports.js';
import type {
  IcpAutonomyReasonCode,
  IcpAvailabilityLease,
  IcpConversationEpisode,
  IcpInitiationPermit,
} from '../../shared/contracts/icp-autonomy.js';
import { EventBus } from '../../shared/event-bus.js';
import type { SessionHmacKeyring } from '../../persistence/journals/journal-utils.js';
import { deriveCompanionAuthToken } from './companion-auth.js';
import { GatewayCompanionChannelLane } from './companion-channels.js';
import type { GatewayMultiCompanionConfig } from './multi-companion.js';
import { GatewayServer, type GatewayServerOptions } from './server.js';
import type { GatewayRpcConnection } from './transport.js';

vi.mock('./transport.js', () => ({
  createSocketServer: vi.fn(),
  createWebSocketRpcServer: vi.fn(),
}));

import { createSocketServer } from './transport.js';

const mockedCreateSocketServer = vi.mocked(createSocketServer);
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ROOT = '11111111-1111-4111-8111-111111111111';
const CHANNEL = `companion-dm:${A}:${B}`;
const KEYRING: SessionHmacKeyring = { activeVersion: 'v1', keys: { v1: 'test-secret' } };

const OPEN_POLICY = {
  canonicalPeerContact: true,
  trustAllows: true,
  senderBlocksPeer: false,
  peerBlocksSender: false,
  quietHours: false,
  provenanceFresh: true,
  recursiveMiOnlyRoot: false,
  socialPressureAllows: true,
  chargeAllows: true,
  fatigueAllows: true,
  costAllows: true,
};

class RpcMemoryStore implements IcpSharedAutonomyStorePort {
  availability = new Map<string, IcpAvailabilityLease>();
  episodes = new Map<string, IcpConversationEpisode>();
  permits = new Map<string, IcpInitiationPermit>();

  async publishAvailability(lease: IcpAvailabilityLease): Promise<IcpAvailabilityLease> {
    const current = this.availability.get(lease.companionId);
    if ((current && current.revision + 1 !== lease.revision) || (!current && lease.revision !== 1)) {
      throw new Error('revision conflict');
    }
    this.availability.set(lease.companionId, lease);
    return lease;
  }

  async getAvailability(companionId: string): Promise<IcpAvailabilityLease | null> {
    return this.availability.get(companionId) ?? null;
  }

  async clearAvailability(
    companionId: string,
    expectedRevision: number,
    request: { source: IcpAvailabilityLease['source']; nowMs: number },
  ): Promise<boolean> {
    const current = this.availability.get(companionId);
    if (current?.revision !== expectedRevision) return false;
    if (current.source === 'operator'
      && current.expiresAtMs > request.nowMs
      && request.source !== 'operator') return false;
    return this.availability.delete(companionId);
  }

  async createEpisode(episode: IcpConversationEpisode): Promise<IcpConversationEpisode> {
    this.episodes.set(episode.conversationId, episode);
    return episode;
  }

  async getEpisode(conversationId: string): Promise<IcpConversationEpisode | null> {
    return this.episodes.get(conversationId) ?? null;
  }

  async transitionEpisode(input: IcpConversationTransitionInput): Promise<IcpConversationEpisode> {
    const current = this.episodes.get(input.conversationId);
    if (!current) throw new Error('missing episode');
    const next: IcpConversationEpisode = {
      ...current,
      status: input.status,
      lastActivityAtMs: input.lastActivityAtMs,
      ...(input.closeReasonCode ? { closeReasonCode: input.closeReasonCode } : {}),
      revision: current.revision + 1,
    };
    this.episodes.set(input.conversationId, next);
    return next;
  }

  async issuePermit(permit: IcpInitiationPermit): Promise<IcpInitiationPermit> {
    if (await this.findOutstandingPermitBetween(
      permit.senderCompanionId,
      permit.recipientCompanionId,
      permit.issuedAtMs,
    )) throw new Error('outstanding invitation');
    this.permits.set(permit.permitId, permit);
    return permit;
  }

  async createEpisodeAndIssuePermit(input: {
    episode: IcpConversationEpisode;
    permit: IcpInitiationPermit;
  }): Promise<{ episode: IcpConversationEpisode; permit: IcpInitiationPermit }> {
    const episode = await this.createEpisode(input.episode);
    try {
      const permit = await this.issuePermit(input.permit);
      return { episode, permit };
    } catch (error) {
      this.episodes.delete(episode.conversationId);
      throw error;
    }
  }

  async getPermit(permitId: string): Promise<IcpInitiationPermit | null> {
    return this.permits.get(permitId) ?? null;
  }

  async consumePermit(input: IcpPermitConsumptionInput): Promise<IcpPermitConsumptionResult> {
    const current = this.permits.get(input.permitId);
    if (!current) return { outcome: 'not_found', permit: null };
    if (current.conversationId !== input.conversationId
      || current.senderCompanionId !== input.senderCompanionId
      || current.recipientCompanionId !== input.recipientCompanionId
      || current.channelId !== input.channelId) {
      return { outcome: 'mismatch', permit: current, reasonCode: 'permit_mismatch' };
    }
    if (current.status === 'consumed') {
      return { outcome: 'replayed', permit: current, reasonCode: 'permit_replayed' };
    }
    if (current.status === 'revoked') {
      return { outcome: 'revoked', permit: current, reasonCode: 'permit_revoked' };
    }
    const consumed: IcpInitiationPermit = {
      ...current,
      status: 'consumed',
      consumedAtMs: input.consumedAtMs,
      revision: current.revision + 1,
    };
    this.permits.set(current.permitId, consumed);
    return { outcome: 'consumed', permit: consumed };
  }

  async revokePermit(
    permitId: string,
    expectedRevision: number,
    revokedAtMs: number,
    reasonCode: IcpAutonomyReasonCode,
  ): Promise<IcpInitiationPermit> {
    const current = this.permits.get(permitId);
    if (!current || current.status !== 'issued' || current.revision !== expectedRevision) {
      throw new Error('revocation conflict');
    }
    const revoked: IcpInitiationPermit = {
      ...current,
      status: 'revoked',
      revokedAtMs,
      reasonCode,
      revision: current.revision + 1,
    };
    this.permits.set(permitId, revoked);
    return revoked;
  }

  async findOutstandingPermitBetween(
    firstCompanionId: string,
    secondCompanionId: string,
    nowMs: number,
  ): Promise<IcpInitiationPermit | null> {
    const expected = [firstCompanionId, secondCompanionId].sort().join(':');
    return [...this.permits.values()].find(permit =>
      permit.status === 'issued'
      && permit.expiresAtMs > nowMs
      && [permit.senderCompanionId, permit.recipientCompanionId].sort().join(':') === expected
    ) ?? null;
  }

  async revokeOutstandingPermitsForCompanion(
    companionId: string,
    revokedAtMs: number,
    reasonCode: IcpAutonomyReasonCode,
  ): Promise<IcpInitiationPermit[]> {
    const rows: IcpInitiationPermit[] = [];
    for (const permit of this.permits.values()) {
      if (permit.status !== 'issued'
        || (permit.senderCompanionId !== companionId && permit.recipientCompanionId !== companionId)) continue;
      const revoked: IcpInitiationPermit = {
        ...permit,
        status: 'revoked',
        revokedAtMs,
        reasonCode,
        revision: permit.revision + 1,
      };
      this.permits.set(permit.permitId, revoked);
      rows.push(revoked);
    }
    return rows;
  }

  async revokeOutstandingPermitsOutsideFleet(
    knownCompanionIds: readonly string[],
    revokedAtMs: number,
  ): Promise<IcpInitiationPermit[]> {
    const known = new Set(knownCompanionIds);
    const rows: IcpInitiationPermit[] = [];
    for (const permit of this.permits.values()) {
      if (permit.status !== 'issued'
        || (known.has(permit.senderCompanionId) && known.has(permit.recipientCompanionId))) continue;
      const revoked: IcpInitiationPermit = {
        ...permit,
        status: 'revoked',
        revokedAtMs,
        reasonCode: 'unknown_participant',
        revision: permit.revision + 1,
      };
      this.permits.set(permit.permitId, revoked);
      rows.push(revoked);
    }
    return rows;
  }

  async close(): Promise<void> {}
}

type MockConnection = {
  conn: GatewayRpcConnection;
  sent: any[];
  destroyed: boolean;
  emitMessage(message: unknown): void;
  emitClose(): void;
};

function mockConnection(): MockConnection {
  const emitter = new EventEmitter();
  const sent: any[] = [];
  let destroyed = false;
  const raw = {
    send(message: unknown): boolean {
      sent.push(message);
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
    },
    get destroyed(): boolean {
      return destroyed;
    },
  };
  return {
    conn: raw as unknown as GatewayRpcConnection,
    sent,
    get destroyed() { return destroyed; },
    emitMessage: message => emitter.emit('message', message),
    emitClose: () => emitter.emit('close'),
  };
}

function multiCompanion(): GatewayMultiCompanionConfig {
  return {
    enabled: true,
    fleetCompanionIds: [A, B, C],
    channelRouting: {},
    discordAccounts: {},
  };
}

async function invoke(conn: MockConnection, id: number, method: string, params: unknown): Promise<any> {
  conn.emitMessage({ jsonrpc: '2.0', id, method, params });
  for (let attempt = 0; attempt < 80; attempt++) {
    const response = conn.sent.find(message => message.id === id && ('result' in message || 'error' in message));
    if (response) return response;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error(`No response for ${method}`);
}

async function identify(conn: MockConnection, companionId: string, id: number): Promise<void> {
  const response = await invoke(conn, id, 'gateway.client.identify', {
    role: 'agent',
    companionId,
    authToken: deriveCompanionAuthToken(companionId, 'agent', KEYRING),
  });
  expect(response.result).toMatchObject({ success: true, companionId });
}

function candidate(candidateId: string, localCompanionId = A, peerCompanionId = B) {
  const now = Date.now();
  return {
    candidateId,
    rootInitiationId: ROOT,
    localCompanionId,
    peerCompanionId,
    preferredChannel: 'dm' as const,
    source: 'free_time' as const,
    provenanceRef: `icp-prov:${candidateId}`,
    createdAtMs: now - 1_000,
    expiresAtMs: now + 120_000,
    status: 'pending' as const,
    revision: 1,
  };
}

async function setup(policy = OPEN_POLICY) {
  const eventBus = new EventBus();
  const store = new RpcMemoryStore();
  const llmProvider = { stream: vi.fn(), complete: vi.fn() };
  const lane = new GatewayCompanionChannelLane({
    placesRegistry: { places: [] },
    presence: { listByPlace: vi.fn(async () => []) },
    fleetCompanionIds: new Set([A, B, C]),
  });
  const options: GatewayServerOptions = {
    socketPath: '/tmp/icp-autonomy-test.sock',
    llmProvider: llmProvider as any,
    embeddingService: { embed: vi.fn(), embedBatch: vi.fn(), dims: 16 } as any,
    discordAdapter: { id: 'discord', outbound: { textChunkLimit: 2_000, sendText: vi.fn() } } as any,
    policyConfig: { workspacePath: '/workspace' },
    sessionHmacKeyring: KEYRING,
    wyomingShardRouting: { enabled: false },
    multiCompanion: multiCompanion(),
    companionChannels: lane,
    icpAutonomyStore: store,
    icpInitiationPolicyAuthority: { resolve: async () => policy },
    eventBus,
  };
  let onConnection: ((conn: GatewayRpcConnection) => void) | undefined;
  mockedCreateSocketServer.mockImplementation((_path, callback) => {
    onConnection = callback;
    return { close: vi.fn(), listen: vi.fn() } as any;
  });
  const server = new GatewayServer(options);
  server.start();
  const connect = (): MockConnection => {
    const conn = mockConnection();
    onConnection!(conn.conn);
    return conn;
  };
  return { server, connect, store, llmProvider, eventBus };
}

describe('GatewayServer ICP autonomy RPC', () => {
  it('authenticates coarse availability and closes deterministic gates with zero LLM calls', async () => {
    const { connect, llmProvider, eventBus } = await setup({ ...OPEN_POLICY, quietHours: true });
    const a = connect();
    const b = connect();
    await identify(a, A, 1);
    await identify(b, B, 2);
    const published = await invoke(b, 3, 'companion.availability.publish', {
      companionId: B,
      state: 'open_to_chat',
      expiresAtMs: Date.now() + 120_000,
      revision: 1,
    });
    expect(published.result).toMatchObject({ companionId: B, state: 'open_to_chat', source: 'companion' });

    const gates: unknown[] = [];
    eventBus.on('icp.initiation.gate', event => { gates.push(event); });
    const closed = await invoke(a, 4, 'companion.initiation.preflight', {
      companionId: A,
      candidate: candidate('22222222-2222-4222-8222-222222222222'),
      channelId: CHANNEL,
    });
    expect(closed.result).toEqual({
      eligible: false,
      reasonCode: 'quiet_hours',
      reasonClass: 'deferrable',
    });
    expect(llmProvider.stream).not.toHaveBeenCalled();
    expect(llmProvider.complete).not.toHaveBeenCalled();
    expect(gates).toEqual([
      expect.objectContaining({ outcome: 'closed', reasonCode: 'quiet_hours' }),
    ]);
  });

  it('disconnects identity spoofing and alarms exact channel/peer substitution', async () => {
    const { connect, store } = await setup();
    const a = connect();
    const b = connect();
    await identify(a, A, 10);
    await identify(b, B, 11);
    await invoke(b, 12, 'companion.availability.publish', {
      companionId: B,
      state: 'open_to_chat',
      expiresAtMs: Date.now() + 120_000,
      revision: 1,
    });

    const substituted = await invoke(a, 13, 'companion.initiation.preflight', {
      companionId: A,
      candidate: candidate('33333333-3333-4333-8333-333333333333'),
      channelId: `companion-dm:${A}:${C}`,
    });
    expect(substituted.result).toEqual({
      eligible: false,
      reasonCode: 'channel_mismatch',
      reasonClass: 'terminal',
    });

    a.emitMessage({
      jsonrpc: '2.0',
      id: 14,
      method: 'companion.availability.read_peer',
      params: { companionId: B, peerCompanionId: C },
    });
    await vi.waitFor(() => expect(a.destroyed).toBe(true));
    expect(store.availability.get(B)?.state).toBe('open_to_chat');
  });

  it('revokes issued permits on DND, block notification, and authenticated peer disconnect', async () => {
    const { connect, store } = await setup();
    const a = connect();
    const b = connect();
    await identify(a, A, 20);
    await identify(b, B, 21);
    await invoke(b, 22, 'companion.availability.publish', {
      companionId: B,
      state: 'open_to_chat',
      expiresAtMs: Date.now() + 120_000,
      revision: 1,
    });
    const issue = await invoke(a, 23, 'companion.initiation.permit.issue', {
      companionId: A,
      candidate: candidate('55555555-5555-4555-8555-555555555555'),
      channelId: CHANNEL,
      permitExpiresAtMs: Date.now() + 60_000,
    });
    expect(issue.result.decision).toEqual({ eligible: true });
    const firstPermitId = issue.result.permit.permitId as string;

    await invoke(b, 24, 'companion.availability.publish', {
      companionId: B,
      state: 'do_not_disturb',
      expiresAtMs: Date.now() + 120_000,
      revision: 2,
    });
    expect(store.permits.get(firstPermitId)).toMatchObject({
      status: 'revoked',
      reasonCode: 'peer_do_not_disturb',
    });

    await invoke(b, 25, 'companion.availability.publish', {
      companionId: B,
      state: 'open_to_chat',
      expiresAtMs: Date.now() + 120_000,
      revision: 3,
    });
    const second = await invoke(a, 26, 'companion.initiation.permit.issue', {
      companionId: A,
      candidate: candidate('66666666-6666-4666-8666-666666666666'),
      channelId: CHANNEL,
      permitExpiresAtMs: Date.now() + 60_000,
    });
    expect(second.result.decision).toEqual({ eligible: true });
    const secondPermitId = second.result.permit.permitId as string;
    const invalidated = await invoke(b, 27, 'companion.initiation.permit.invalidate_for_self', {
      companionId: B,
      reasonCode: 'peer_blocked',
    });
    expect(invalidated.result).toEqual({ revokedCount: 1 });
    expect(store.permits.get(secondPermitId)).toMatchObject({
      status: 'revoked',
      reasonCode: 'peer_blocked',
    });

    const third = await invoke(a, 28, 'companion.initiation.permit.issue', {
      companionId: A,
      candidate: candidate('77777777-7777-4777-8777-777777777777'),
      channelId: CHANNEL,
      permitExpiresAtMs: Date.now() + 60_000,
    });
    expect(third.result.decision).toEqual({ eligible: true });
    const thirdPermitId = third.result.permit.permitId as string;
    b.emitClose();
    await vi.waitFor(() => expect(store.permits.get(thirdPermitId)).toMatchObject({
      status: 'revoked',
      reasonCode: 'peer_offline',
    }));
  });
});
