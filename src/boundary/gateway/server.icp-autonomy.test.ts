import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type {
  IcpAutonomyInvalidationFence,
  IcpConversationTransitionInput,
  IcpPermitConsumptionInput,
  IcpPermitConsumptionResult,
  IcpSharedAutonomyStorePort,
} from '../../core/icp/autonomy-store-ports.js';
import {
  IcpAutonomyInvalidationConflictError,
  IcpOutstandingInvitationConflictError,
  IcpPermitRevocationConflictError,
} from '../../core/icp/autonomy-store-ports.js';
import { ContactBlockListStore } from '../../core/cogsec/contact-block-list.js';
import { createContactTool } from '../../core/contacts/tools.js';
import { INTAKE_FIREWALL_OFF_SELF_AUTHORED_MUTATION_RUNTIME } from '../../core/session/intake-sink-gating.js';
import { createTestPostgresContactStore } from '../../test-support/postgres-contact-store.js';
import {
  deriveIcpTransportMessageId,
  MAX_ICP_AVAILABILITY_LEASE_TTL_MS,
  type IcpAutonomyReasonCode,
  type IcpAvailabilityLease,
  type IcpConversationCorrelation,
  type IcpConversationEpisode,
  type IcpInitiationPermit,
} from '../../shared/contracts/icp-autonomy.js';
import { EventBus } from '../../shared/event-bus.js';
import { FLEET_POSTURE_EXPIRY_TIMEOUT_MS } from '../../shared/telemetry/fleet-posture.js';
import type { SessionHmacKeyring } from '../../persistence/journals/journal-utils.js';
import { deriveCompanionAuthToken } from './companion-auth.js';
import { GatewayCompanionChannelLane } from './companion-channels.js';
import type { GatewayMultiCompanionConfig } from './multi-companion.js';
import { GatewayServer, type GatewayServerOptions } from './server.js';
import type { GatewayAuditStorePort } from './audit-port.js';
import type { GatewayRpcConnection } from './transport.js';
import { GatewayClient } from './client.js';
import { SessionStore } from '../../persistence/sessions/store.js';
import { SessionManager } from '../../core/session/manager.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { buildSessionMetadataWithIcpCorrelation } from '../../core/session/icp-correlation-metadata.js';
import type { AgentResponse, SubstrateMessage, TurnID } from '../../shared/contracts/runtime.js';
import { createIcpTargetChannelInitiator } from '../../app/agent/icp-target-channel-initiation.js';

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
  invalidationGenerations = new Map<string, number>();
  invalidationReasons = new Map<string, IcpAutonomyReasonCode>();
  beforeInvalidate?: () => Promise<void>;
  beforeConsume?: () => Promise<void>;

  async publishAvailability(lease: IcpAvailabilityLease): Promise<IcpAvailabilityLease> {
    return this.publishAvailabilityNow(lease);
  }

  private publishAvailabilityNow(lease: IcpAvailabilityLease): IcpAvailabilityLease {
    const current = this.availability.get(lease.companionId);
    if ((current && current.revision + 1 !== lease.revision) || (!current && lease.revision !== 1)) {
      throw new Error('revision conflict');
    }
    this.availability.set(lease.companionId, lease);
    return lease;
  }

  async publishAvailabilityAndInvalidate(
    lease: IcpAvailabilityLease,
    reasonCode: IcpAutonomyReasonCode,
  ): Promise<{ lease: IcpAvailabilityLease; revokedPermits: IcpInitiationPermit[] }> {
    await this.beforeInvalidate?.();
    const published = this.publishAvailabilityNow(lease);
    return {
      lease: published,
      revokedPermits: this.revokeOutstandingPermitsForCompanionNow(
        lease.companionId,
        lease.issuedAtMs,
        reasonCode,
      ),
    };
  }

  async getAvailability(companionId: string): Promise<IcpAvailabilityLease | null> {
    return this.availability.get(companionId) ?? null;
  }

  async clearAvailability(
    companionId: string,
    expectedRevision: number,
    request: { source: IcpAvailabilityLease['source']; nowMs: number },
  ): Promise<boolean> {
    return this.clearAvailabilityNow(companionId, expectedRevision, request);
  }

  private clearAvailabilityNow(
    companionId: string,
    expectedRevision: number,
    request: { source: IcpAvailabilityLease['source']; nowMs: number },
  ): boolean {
    const current = this.availability.get(companionId);
    if (current?.revision !== expectedRevision) return false;
    if (current.source === 'operator'
      && current.expiresAtMs > request.nowMs
      && request.source !== 'operator') return false;
    return this.availability.delete(companionId);
  }

  async clearAvailabilityAndInvalidate(
    companionId: string,
    expectedRevision: number,
    request: { source: IcpAvailabilityLease['source']; nowMs: number },
    reasonCode: IcpAutonomyReasonCode,
  ): Promise<{ cleared: boolean; revokedPermits: IcpInitiationPermit[] }> {
    await this.beforeInvalidate?.();
    const cleared = this.clearAvailabilityNow(companionId, expectedRevision, request);
    return {
      cleared,
      revokedPermits: cleared
        ? this.revokeOutstandingPermitsForCompanionNow(companionId, request.nowMs, reasonCode)
        : [],
    };
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

  async captureInvalidationFence(
    firstCompanionId: string,
    secondCompanionId: string,
  ): Promise<IcpAutonomyInvalidationFence> {
    const pair = [firstCompanionId, secondCompanionId].sort();
    return { companions: [
      { companionId: pair[0]!, generation: this.invalidationGenerations.get(pair[0]!) ?? 0 },
      { companionId: pair[1]!, generation: this.invalidationGenerations.get(pair[1]!) ?? 0 },
    ] };
  }

  assertInvalidationFence(fence: IcpAutonomyInvalidationFence): void {
    for (const entry of fence.companions) {
      if ((this.invalidationGenerations.get(entry.companionId) ?? 0) === entry.generation) continue;
      throw new IcpAutonomyInvalidationConflictError(
        this.invalidationReasons.get(entry.companionId) ?? 'operator_cancelled',
      );
    }
  }

  async issuePermit(input: {
    permit: IcpInitiationPermit;
    expectedInvalidationFence: IcpAutonomyInvalidationFence;
  }): Promise<IcpInitiationPermit> {
    this.assertInvalidationFence(input.expectedInvalidationFence);
    const { permit } = input;
    if (await this.findOutstandingPermitBetween(
      permit.senderCompanionId,
      permit.recipientCompanionId,
      permit.issuedAtMs,
    )) throw new IcpOutstandingInvitationConflictError();
    this.permits.set(permit.permitId, permit);
    return permit;
  }

  async createEpisodeAndIssuePermit(input: {
    episode: IcpConversationEpisode;
    permit: IcpInitiationPermit;
    expectedInvalidationFence: IcpAutonomyInvalidationFence;
  }): Promise<{ episode: IcpConversationEpisode; permit: IcpInitiationPermit }> {
    this.assertInvalidationFence(input.expectedInvalidationFence);
    const episode = await this.createEpisode(input.episode);
    try {
      const permit = await this.issuePermit({
        permit: input.permit,
        expectedInvalidationFence: input.expectedInvalidationFence,
      });
      return { episode, permit };
    } catch (error) {
      this.episodes.delete(episode.conversationId);
      throw error;
    }
  }

  async getPermit(permitId: string): Promise<IcpInitiationPermit | null> {
    return this.permits.get(permitId) ?? null;
  }

  async getPermitByCandidate(candidateId: string): Promise<IcpInitiationPermit | null> {
    return [...this.permits.values()].find(permit => permit.candidateId === candidateId) ?? null;
  }

  async consumePermit(input: IcpPermitConsumptionInput): Promise<IcpPermitConsumptionResult> {
    await this.beforeConsume?.();
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
    this.assertInvalidationFence(input.expectedInvalidationFence);
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
      throw new IcpPermitRevocationConflictError();
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
    await this.beforeInvalidate?.();
    return this.revokeOutstandingPermitsForCompanionNow(companionId, revokedAtMs, reasonCode);
  }

  private revokeOutstandingPermitsForCompanionNow(
    companionId: string,
    revokedAtMs: number,
    reasonCode: IcpAutonomyReasonCode,
  ): IcpInitiationPermit[] {
    this.invalidationGenerations.set(
      companionId,
      (this.invalidationGenerations.get(companionId) ?? 0) + 1,
    );
    this.invalidationReasons.set(companionId, reasonCode);
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
      for (const companionId of [permit.senderCompanionId, permit.recipientCompanionId]) {
        if (known.has(companionId)) continue;
        this.invalidationGenerations.set(
          companionId,
          (this.invalidationGenerations.get(companionId) ?? 0) + 1,
        );
        this.invalidationReasons.set(companionId, 'unknown_participant');
      }
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
    personalWorkspaceByCompanionId: {
      [A]: '/workspace/a',
      [B]: '/workspace/b',
      [C]: '/workspace/c',
    },
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

async function identifyTransport(conn: MockConnection, companionId: string, id: number): Promise<void> {
  const response = await invoke(conn, id, 'gateway.client.identify', {
    role: 'agent',
    companionId,
    authToken: deriveCompanionAuthToken(companionId, 'agent', KEYRING),
  });
  expect(response.result).toMatchObject({ success: true, companionId });
  const ready = await invoke(conn, id + 10_000, 'gateway.client.ready', {});
  expect(ready.result).toEqual({ success: true });
  const nowMs = Date.now();
  const health = await invoke(conn, id + 20_000, 'gateway.client.health', {
    posture: {
      schemaVersion: 1,
      updatedAt: nowMs,
      charge: { state: 'clear', utilizationPercent: 0 },
      fatigue: { state: 'clear', utilizationPercent: 0 },
    },
  });
  expect(health.result).toEqual({ success: true });
}

async function identify(conn: MockConnection, companionId: string, id: number): Promise<void> {
  await identifyTransport(conn, companionId, id);
  const refreshed = await invoke(conn, id + 30_000, 'companion.availability.refresh_runtime', {
    companionId,
    state: 'available',
    expiresAtMs: Date.now() + MAX_ICP_AVAILABILITY_LEASE_TTL_MS - 1,
  });
  expect(refreshed.result).toMatchObject({ eligible: true });
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

function deferred(): { reached: Promise<void>; release: () => void; wait: () => Promise<void> } {
  let markReached!: () => void;
  let release!: () => void;
  const reached = new Promise<void>(resolve => { markReached = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return {
    reached,
    release,
    wait: async () => {
      markReached();
      await released;
    },
  };
}

function createMockAuditStore(): {
  store: GatewayAuditStorePort;
  complete: ReturnType<typeof vi.fn>;
} {
  let nextId = 1;
  const complete = vi.fn(async (_id: number, _durationMs: number, _error?: string) => {});
  const store: GatewayAuditStorePort = {
    append: vi.fn(async () => nextId++),
    complete,
    recordSummary: vi.fn(async () => nextId++),
    createSummaryHook: vi.fn(() => async () => {}),
    enforceRotation: vi.fn(async () => {}),
    getRecent: vi.fn(async () => []),
    getByMethod: vi.fn(async () => []),
    getApprovalEvents: vi.fn(async () => []),
    count: vi.fn(async () => 0),
  };
  return { store, complete };
}

async function setup(
  policy = OPEN_POLICY,
  overrides: Pick<
    GatewayServerOptions,
    'auditStore' | 'capabilityTierProvider' | 'capabilityGrantSnapshotProvider'
  > = {},
) {
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
    intakeScreeningMode: 'off',
    intakeScreeningProvider: () => null,
    visionIntakeProvider: () => null,
    sessionHmacKeyring: KEYRING,
    wyomingShardRouting: { enabled: false },
    multiCompanion: multiCompanion(),
    companionChannels: lane,
    icpAutonomyStore: store,
    icpInitiationPolicyAuthority: {
      resolve: async () => policy,
      authorizeHandoff: async () => ({ eligible: true }),
      runAuthorizedHandoff: async (_input, operation) => ({
        decision: { eligible: true },
        result: await operation(),
      }),
    },
    capabilityTierProvider: () => 'autonomous',
    eventBus,
    ...overrides,
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
  const connectClient = async (companionId: string): Promise<GatewayClient> => {
    const clientEmitter = new EventEmitter();
    const serverEmitter = new EventEmitter();
    let destroyed = false;
    const clientConnection = {
      send(message: unknown): boolean {
        queueMicrotask(() => serverEmitter.emit('message', message));
        return true;
      },
      onMessage(handler: (message: unknown) => void): void {
        clientEmitter.on('message', handler);
      },
      on(event: string, handler: (...args: unknown[]) => void): void {
        clientEmitter.on(event, handler);
      },
      destroy(): void {
        destroyed = true;
        queueMicrotask(() => serverEmitter.emit('close'));
      },
      get destroyed(): boolean {
        return destroyed;
      },
    } as GatewayRpcConnection;
    const serverConnection = {
      send(message: unknown): boolean {
        queueMicrotask(() => clientEmitter.emit('message', message));
        return true;
      },
      onMessage(handler: (message: unknown) => void): void {
        serverEmitter.on('message', handler);
      },
      on(event: string, handler: (...args: unknown[]) => void): void {
        serverEmitter.on(event, handler);
      },
      destroy(): void {
        destroyed = true;
      },
      get destroyed(): boolean {
        return destroyed;
      },
    } as GatewayRpcConnection;
    onConnection!(serverConnection);
    const client = new GatewayClient(clientConnection, 16, {
      companionId,
      companionAuthToken: deriveCompanionAuthToken(companionId, 'agent', KEYRING),
    });
    await client.identifyAsAgent();
    await client.declareRuntimeReady();
    await client.startFleetPostureReporting(() => ({
      schemaVersion: 1,
      updatedAt: Date.now(),
      charge: { state: 'clear', utilizationPercent: 0 },
      fatigue: { state: 'clear', utilizationPercent: 0 },
    }));
    await client.refreshRuntimeAvailability({
      state: 'available',
      expiresAtMs: Date.now() + MAX_ICP_AVAILABILITY_LEASE_TTL_MS - 1,
    });
    return client;
  };
  return { server, connect, connectClient, store, llmProvider, eventBus };
}

describe('GatewayServer ICP autonomy RPC', () => {
  it('fails closed against the current gateway-owned companion capability authority', async () => {
    let capabilityTier: 'autonomous' | 'apprentice' = 'autonomous';
    const { connect } = await setup(OPEN_POLICY, {
      capabilityTierProvider: () => capabilityTier,
    });
    const a = connect();
    await identifyTransport(a, A, 900);

    const available = await invoke(a, 901, 'companion.availability.refresh_runtime', {
      state: 'available',
      expiresAtMs: Date.now() + 120_000,
    });
    expect(available.result).toMatchObject({ eligible: true, control: 'runtime' });

    capabilityTier = 'apprentice';
    const withdrawn = await invoke(a, 902, 'companion.availability.refresh_runtime', {
      state: 'available',
      expiresAtMs: Date.now() + 120_000,
    });
    expect(withdrawn.result).toMatchObject({
      eligible: false,
      reasonCode: 'peer_resting',
      control: 'runtime',
      lease: { state: 'resting', revision: 2 },
    });
  });

  it('binds runtime availability refresh and clear to the authenticated companion source', async () => {
    const { connect, store } = await setup();
    const a = connect();
    await identifyTransport(a, A, 1_000);

    const refreshed = await invoke(a, 1_001, 'companion.availability.refresh_runtime', {
      companionId: A,
      state: 'available',
      expiresAtMs: Date.now() + 120_000,
    });
    expect(refreshed.result).toMatchObject({
      eligible: true,
      control: 'runtime',
      lease: { companionId: A, state: 'available', source: 'runtime', revision: 1 },
    });

    await invoke(a, 1_002, 'companion.availability.publish', {
      companionId: A,
      state: 'busy',
      expiresAtMs: Date.now() + 120_000,
      revision: 2,
    });
    const preserved = await invoke(a, 1_003, 'companion.availability.refresh_runtime', {
      companionId: A,
      state: 'available',
      expiresAtMs: Date.now() + 120_000,
    });
    expect(preserved.result).toMatchObject({
      eligible: false,
      control: 'companion',
      lease: { state: 'busy', source: 'companion', revision: 2 },
    });

    const cleared = await invoke(a, 1_004, 'companion.availability.clear_runtime', {
      companionId: A,
    });
    expect(cleared.result).toMatchObject({ control: 'companion' });
    expect(store.availability.get(A)).toMatchObject({ state: 'busy', source: 'companion' });
  });

  it('rejects restrictive or unbounded runtime availability input', async () => {
    const { connect, store } = await setup();
    const a = connect();
    await identifyTransport(a, A, 1_050);

    const restrictive = await invoke(a, 1_051, 'companion.availability.refresh_runtime', {
      companionId: A,
      state: 'busy',
      expiresAtMs: Date.now() + 120_000,
    });
    expect(restrictive.error?.message).toMatch(/available or resting/i);

    const unbounded = await invoke(a, 1_052, 'companion.availability.refresh_runtime', {
      companionId: A,
      state: 'available',
      expiresAtMs: Date.now()
        + MAX_ICP_AVAILABILITY_LEASE_TTL_MS
        + MAX_ICP_AVAILABILITY_LEASE_TTL_MS,
    });
    expect(unbounded.error?.message).toMatch(/maximum TTL/i);
    expect(store.availability.has(A)).toBe(false);
  });

  it('uses authenticated fleet posture to suppress an available exhausted peer', async () => {
    const { connect, llmProvider } = await setup();
    const a = connect();
    const b = connect();
    await identify(a, A, 1_100);
    await identify(b, B, 1_200);
    await new Promise(resolve => setTimeout(resolve, 2));
    const nowMs = Date.now();
    await invoke(b, 1_201, 'gateway.client.health', {
      posture: {
        schemaVersion: 1,
        updatedAt: nowMs,
        charge: { state: 'clear', utilizationPercent: 0 },
        fatigue: { state: 'exhausted', utilizationPercent: 100 },
      },
    });
    await invoke(b, 1_202, 'companion.availability.refresh_runtime', {
      companionId: B,
      state: 'available',
      expiresAtMs: nowMs + 120_000,
    });

    const peer = await invoke(a, 1_203, 'companion.availability.read_peer', {
      companionId: A,
      peerCompanionId: B,
    });
    expect(peer.result).toMatchObject({
      connectionState: 'online',
      eligible: false,
      reasonCode: 'fatigue_exhausted',
      lease: { state: 'available', source: 'runtime' },
    });
    expect(llmProvider.complete).not.toHaveBeenCalled();
    expect(llmProvider.stream).not.toHaveBeenCalled();
  });

  it('revokes an issued permit when authenticated recipient fatigue becomes exhausted', async () => {
    const { connect, store } = await setup();
    const a = connect();
    const b = connect();
    await identify(a, A, 1_210);
    await identify(b, B, 1_220);
    const issued = await invoke(a, 1_221, 'companion.initiation.permit.issue', {
      companionId: A,
      candidate: candidate('12121212-1212-4212-8212-121212121212'),
      channelId: CHANNEL,
      permitExpiresAtMs: Date.now() + 60_000,
    });
    expect(issued.result.decision).toEqual({ eligible: true });
    const permitId = issued.result.permit.permitId as string;

    await new Promise(resolve => setTimeout(resolve, 2));
    const nowMs = Date.now();
    const health = await invoke(b, 1_222, 'gateway.client.health', {
      posture: {
        schemaVersion: 1,
        updatedAt: nowMs,
        charge: { state: 'clear', utilizationPercent: 0 },
        fatigue: { state: 'exhausted', utilizationPercent: 100 },
      },
    });
    expect(health.result).toEqual({ success: true });
    expect(store.permits.get(permitId)).toMatchObject({
      status: 'revoked',
      reasonCode: 'fatigue_exhausted',
    });
  });

  it('fails closed after an authenticated fleet posture expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const nowMs = Date.parse('2027-02-01T12:00:00.000Z');
      vi.setSystemTime(nowMs);
      const { connect } = await setup();
      const a = connect();
      const b = connect();
      await identify(a, A, 1_300);
      await identify(b, B, 1_400);

      vi.setSystemTime(nowMs + FLEET_POSTURE_EXPIRY_TIMEOUT_MS + 1);
      const peer = await invoke(a, 1_401, 'companion.availability.read_peer', {
        companionId: A,
        peerCompanionId: B,
      });
      expect(peer.result).toMatchObject({
        connectionState: 'online',
        eligible: false,
        reasonCode: 'policy_denied',
        lease: { state: 'available', source: 'runtime' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs initiator → gateway → concrete client → recipient with durable restart truth', async () => {
    const { connectClient, store } = await setup();
    const clientA = await connectClient(A);
    const clientB = await connectClient(B);
    const root = mkdtempSync(join(tmpdir(), 'psfn-icp-production-shape-'));
    const config = (dataDir: string): SubstrateConfig => ({
      dataDir,
      companionDataDir: dataDir,
      sessionMessageLimit: 30,
      memoryRetrievalLimit: 15,
      extractionInterval: 5,
      maintenanceIntervalMs: 300_000,
      defaultContextWindow: 128_000,
      extractionThresholdPct: 30,
      compactionThresholdPct: 70,
    } as SubstrateConfig);
    const senderStorePath = join(root, 'sender', 'sessions');
    const recipientStorePath = join(root, 'recipient', 'sessions');
    const senderManager = new SessionManager(
      new SessionStore(senderStorePath),
      config(join(root, 'sender')),
    );
    const recipientManager = new SessionManager(
      new SessionStore(recipientStorePath),
      config(join(root, 'recipient')),
    );
    const candidateId = '25252525-2525-4525-8525-252525252525';
    let postTurnStarted = 0;
    let receivedMessage: SubstrateMessage | null = null;
    let receivedReply: SubstrateMessage | null = null;
    let receivedReplyCount = 0;

    try {
      clientA.onCompanionMessage(async (message) => {
        receivedReply = message;
        receivedReplyCount += 1;
        const correlation = message.routing?.icpCorrelation;
        if (!correlation) throw new Error('initiator expected reply ICP correlation');
        senderManager.recordUserMessage(
          message.channelId,
          message.content,
          message.authorId,
          message.authorName,
          message.isDirectMessage,
          'sender-contact-b',
          {
            turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7083' as TurnID,
            requestId: message.id,
            sourceMessageId: message.id,
            metadata: buildSessionMetadataWithIcpCorrelation(undefined, correlation),
          },
        );
      });
      clientB.onCompanionMessage(async (message) => {
        receivedMessage = message;
        const correlation = message.routing?.icpCorrelation;
        if (!correlation) throw new Error('recipient expected gateway-stamped ICP correlation');
        recipientManager.recordUserMessage(
          message.channelId,
          message.content,
          message.authorId,
          message.authorName,
          message.isDirectMessage,
          'recipient-contact-a',
          {
            turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7082' as TurnID,
            requestId: message.id,
            sourceMessageId: message.id,
            metadata: buildSessionMetadataWithIcpCorrelation(undefined, correlation),
          },
        );
      });
      await clientB.companionPublishAvailability({
        state: 'open_to_chat',
        expiresAtMs: Date.now() + 120_000,
        revision: 2,
      });
      const issue = await clientA.companionIssueInitiationPermit({
        candidate: candidate(candidateId),
        channelId: CHANNEL,
        permitExpiresAtMs: Date.now() + 60_000,
      });
      if (!issue.permit) throw new Error('test expected issued permit');

      const initiator = createIcpTargetChannelInitiator({
        localCompanionId: A,
        agent: {
          async handleMessage(message, deliveryLifecycle): Promise<AgentResponse> {
            const correlation = message.routing?.icpCorrelation;
            if (!correlation) throw new Error('sender expected ICP correlation');
            const response: AgentResponse = {
              content: 'A production-shape hello from A to B.',
              channelId: message.channelId,
              metadata: {
                model: 'production-shape-test',
                inputTokens: 1,
                outputTokens: 1,
                durationMs: 1,
                turnId: correlation.turnId as TurnID,
                requestId: correlation.requestId,
                icpCorrelation: correlation,
              },
            };
            senderManager.recordAssistantMessage(
              message.channelId,
              'A production-shape hello from A to B.',
              message.authorId,
              message.isDirectMessage,
              correlation.peerContactId,
              {
                turnId: correlation.turnId as TurnID,
                requestId: correlation.requestId,
                sourceMessageId: correlation.messageId,
                metadata: buildSessionMetadataWithIcpCorrelation(
                  undefined,
                  correlation,
                  { deliveryStatus: 'pending', recoveryResponse: response },
                ),
              },
            );
            await deliveryLifecycle.finalizeDelivery(response);
            postTurnStarted += 1;
            return response;
          },
          findRecordedIcpInitiation: (channelId, sourceMessageId) => (
            senderManager.findRecordedIcpInitiation(channelId, sourceMessageId)
          ),
          findIcpDeliveryObservation: (channelId, sourceMessageId) => (
            senderManager.findIcpDeliveryObservation(channelId, sourceMessageId)
          ),
          recordIcpDeliveryObservation: observation => (
            senderManager.recordIcpDeliveryObservation(observation)
          ),
        },
        gateway: {
          sendInitiation: input => clientA.companionSendInitiation(input),
          consumeInitiationPermit: input => clientA.companionConsumeInitiationPermit(input),
        },
        authorName: 'Alpha',
      });

      const result = await initiator.initiate({
        permit: issue.permit,
        rootInitiationId: ROOT,
        peerContactId: 'sender-contact-b',
      });
      expect(result.disposition).toBe('delivered');
      await vi.waitFor(() => {
        expect(receivedMessage).toMatchObject({
          authorId: A,
          content: 'A production-shape hello from A to B.',
        });
      });
      const deliveredInitiation = receivedMessage as SubstrateMessage | null;
      const inboundCorrelation = deliveredInitiation?.routing?.icpCorrelation;
      if (!inboundCorrelation) throw new Error('test expected delivered initiation correlation');
      const replyCorrelation = {
        ...inboundCorrelation,
        localCompanionId: B,
        peerCompanionId: A,
        peerContactId: 'recipient-contact-a',
        turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7082',
        messageId: deliveredInitiation.id,
        requestId: deliveredInitiation.id,
        costOriginStage: 'reply' as const,
      };
      const firstReplyDelivery = await clientB.companionSend(
        CHANNEL,
        'A production-shape reply from B to A.',
        'Beta',
        replyCorrelation,
      );
      await vi.waitFor(() => {
        expect(receivedReply).toMatchObject({
          authorId: B,
          content: 'A production-shape reply from B to A.',
          routing: { icpCorrelation: replyCorrelation },
        });
      });
      const replayedReplyDelivery = await clientB.companionSend(
        CHANNEL,
        'A production-shape reply from B to A.',
        'Beta',
        replyCorrelation,
      );
      expect(replayedReplyDelivery.messageId).toBe(firstReplyDelivery.messageId);
      expect(receivedReplyCount).toBe(1);
      expect(postTurnStarted).toBe(1);
      expect(senderManager.getRecentMessages(CHANNEL, 10)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: 'A production-shape hello from A to B.',
        }),
      ]));
      expect(recipientManager.hasRecordedSourceMessage(
        CHANNEL,
        `companion-initiation-${candidateId}`,
      )).toBe(true);

      const restartedSender = new SessionManager(
        new SessionStore(senderStorePath),
        config(join(root, 'sender')),
      );
      expect(restartedSender.findRecordedIcpInitiation(
        CHANNEL,
        `icp-initiation:${candidateId}`,
      )).toMatchObject({ content: 'A production-shape hello from A to B.' });
      expect(restartedSender.findIcpDeliveryObservation(
        CHANNEL,
        `icp-initiation:${candidateId}`,
      )).toMatchObject({ status: 'delivered', turnCompleted: true });
      expect(restartedSender.getRecentSessionEntries(CHANNEL, 10)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          authorId: B,
          content: 'A production-shape reply from B to A.',
        }),
      ]));

      const consumedPermit = store.permits.get(issue.permit.permitId);
      if (!consumedPermit || consumedPermit.status !== 'consumed') {
        throw new Error('test expected a consumed permit before restart recovery');
      }
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(consumedPermit.expiresAtMs + 1);
      try {
        const preparedRecovery = await clientA.companionPrepareInitiationHandoff({
          permitId: consumedPermit.permitId,
          peerContactId: 'sender-contact-b',
        });
        if (!preparedRecovery.authorized) {
          throw new Error(`test expected expired consumed recovery: ${preparedRecovery.reasonCode}`);
        }
        const recoverySend = vi.fn(input => clientA.companionSendInitiation(input));
        const recoveredInitiator = createIcpTargetChannelInitiator({
          localCompanionId: A,
          agent: {
            handleMessage: vi.fn(async (_message, lifecycle) => {
              if (!lifecycle.recoveredResponse) throw new Error('recovery response is required');
              await lifecycle.finalizeDelivery(lifecycle.recoveredResponse);
              return lifecycle.recoveredResponse;
            }),
            findRecordedIcpInitiation: (channelId, sourceMessageId) => (
              restartedSender.findRecordedIcpInitiation(channelId, sourceMessageId)
            ),
            findIcpDeliveryObservation: (channelId, sourceMessageId) => (
              restartedSender.findIcpDeliveryObservation(channelId, sourceMessageId)
            ),
            recordIcpDeliveryObservation: observation => (
              restartedSender.recordIcpDeliveryObservation(observation)
            ),
          },
          gateway: {
            sendInitiation: recoverySend,
            consumeInitiationPermit: input => clientA.companionConsumeInitiationPermit(input),
          },
          authorName: 'Alpha',
        });
        await expect(recoveredInitiator.initiate({
          permit: preparedRecovery.permit,
          rootInitiationId: preparedRecovery.rootInitiationId,
          peerContactId: 'sender-contact-b',
        })).resolves.toMatchObject({ disposition: 'delivered', recoveredTurn: true });
        expect(recoverySend).not.toHaveBeenCalled();
      } finally {
        nowSpy.mockRestore();
      }
    } finally {
      clientA.destroy();
      clientB.destroy();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('quarantines a concrete-client delivery failure before sender post-turn work', async () => {
    const { connectClient, store } = await setup();
    const clientA = await connectClient(A);
    const clientB = await connectClient(B);
    const candidateId = '26262626-2626-4626-8626-262626262626';
    const observations: Array<{ status: string; error?: string }> = [];
    let postTurnStarted = 0;

    try {
      await clientB.companionPublishAvailability({
        state: 'open_to_chat',
        expiresAtMs: Date.now() + 120_000,
        revision: 2,
      });
      const issue = await clientA.companionIssueInitiationPermit({
        candidate: candidate(candidateId),
        channelId: CHANNEL,
        permitExpiresAtMs: Date.now() + 60_000,
      });
      if (!issue.permit) throw new Error('test expected issued permit');
      clientB.destroy();
      await vi.waitFor(() => {
        expect(store.permits.get(issue.permit!.permitId)?.status).toBe('revoked');
      });

      const initiator = createIcpTargetChannelInitiator({
        localCompanionId: A,
        agent: {
          async handleMessage(message, deliveryLifecycle): Promise<AgentResponse> {
            const correlation = message.routing?.icpCorrelation;
            if (!correlation) throw new Error('test expected ICP correlation');
            const response: AgentResponse = {
              content: 'This failed delivery must stay quarantined.',
              channelId: message.channelId,
              metadata: {
                model: 'production-shape-test',
                inputTokens: 1,
                outputTokens: 1,
                durationMs: 1,
                turnId: correlation.turnId as TurnID,
                requestId: correlation.requestId,
                icpCorrelation: correlation,
              },
            };
            await deliveryLifecycle.finalizeDelivery(response);
            postTurnStarted += 1;
            return response;
          },
          findRecordedIcpInitiation: async () => null,
          findIcpDeliveryObservation: async () => null,
          recordIcpDeliveryObservation: async observation => {
            observations.push({
              status: observation.status,
              ...(observation.error ? { error: observation.error } : {}),
            });
          },
        },
        gateway: {
          sendInitiation: input => clientA.companionSendInitiation(input),
          consumeInitiationPermit: input => clientA.companionConsumeInitiationPermit(input),
        },
      });

      await expect(initiator.initiate({
        permit: issue.permit,
        rootInitiationId: ROOT,
        peerContactId: 'sender-contact-b',
      })).rejects.toThrow();
      expect(postTurnStarted).toBe(0);
      expect(observations).toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'failed' }),
      ]));
    } finally {
      clientA.destroy();
      clientB.destroy();
    }
  });

  it('authenticates coarse availability and closes deterministic gates with zero LLM calls', async () => {
    const { connect, llmProvider, eventBus } = await setup({
      ...OPEN_POLICY,
      socialPressureAllows: false,
    });
    const a = connect();
    const b = connect();
    await identify(a, A, 1);
    await identify(b, B, 2);
    const published = await invoke(b, 3, 'companion.availability.publish', {
      companionId: B,
      state: 'open_to_chat',
      expiresAtMs: Date.now() + 120_000,
      revision: 2,
    });
    expect(published.result).toMatchObject({ companionId: B, state: 'open_to_chat', source: 'companion' });
    const own = await invoke(b, 31, 'companion.availability.read_self', { companionId: B });
    expect(own.result).toMatchObject({
      eligible: true,
      control: 'companion',
      mutableByCompanion: true,
      lease: { companionId: B, state: 'open_to_chat' },
    });
    const malformedOwn = await invoke(b, 32, 'companion.availability.read_self', {
      companionId: B,
      peerCompanionId: A,
    });
    expect(malformedOwn.error?.message).toMatch(/unknown key/i);

    const gates: unknown[] = [];
    eventBus.on('icp.initiation.gate', event => { gates.push(event); });
    const closed = await invoke(a, 4, 'companion.initiation.preflight', {
      companionId: A,
      candidate: candidate('22222222-2222-4222-8222-222222222222'),
      channelId: CHANNEL,
    });
    expect(closed.result).toEqual({
      eligible: false,
      reasonCode: 'charge_pressure',
      reasonClass: 'deferrable',
    });
    expect(llmProvider.stream).not.toHaveBeenCalled();
    expect(llmProvider.complete).not.toHaveBeenCalled();
    expect(gates).toEqual([
      expect.objectContaining({ outcome: 'closed', reasonCode: 'charge_pressure' }),
    ]);
  });

  it('atomically consumes initiation permits on the ordinary message lane and replays without duplicate delivery', async () => {
    const { connect, store } = await setup();
    const a = connect();
    const b = connect();
    await identify(a, A, 200);
    await identify(b, B, 201);
    await invoke(b, 202, 'companion.availability.publish', {
      companionId: B,
      state: 'open_to_chat',
      expiresAtMs: Date.now() + 120_000,
      revision: 2,
    });
    const candidateId = '20202020-2020-4020-8020-202020202020';
    const issue = await invoke(a, 203, 'companion.initiation.permit.issue', {
      companionId: A,
      candidate: candidate(candidateId),
      channelId: CHANNEL,
      permitExpiresAtMs: Date.now() + 60_000,
    });
    const permit = issue.result.permit as IcpInitiationPermit;
    const prepared = await invoke(a, 204, 'companion.initiation.permit.prepare_handoff', {
      companionId: A,
      permitId: permit.permitId,
      peerContactId: 'sender-contact-b',
    });
    expect(prepared.result).toMatchObject({
      authorized: true,
      rootInitiationId: ROOT,
      permit: {
        permitId: permit.permitId,
        recipientCompanionId: B,
        channelId: CHANNEL,
      },
    });
    const wrongSender = await invoke(b, 205, 'companion.initiation.permit.prepare_handoff', {
      companionId: B,
      permitId: permit.permitId,
      peerContactId: 'recipient-contact-a',
    });
    expect(wrongSender.result).toEqual({ authorized: false, reasonCode: 'permit_mismatch' });
    const correlation: IcpConversationCorrelation = {
      conversationId: permit.conversationId,
      rootInitiationId: ROOT,
      initiatedByCompanionId: A,
      localCompanionId: A,
      peerCompanionId: B,
      peerContactId: 'sender-local-contact-b',
      channelId: CHANNEL,
      turnId: '018f22a2-52b8-7a3a-8c16-25b7b14f7081',
      messageId: `icp-initiation:${candidateId}`,
      requestId: `icp-initiation:${candidateId}`,
      chargeLane: 'companion_social',
      surface: 'companion_dm',
      costPurpose: 'conversation_turn',
      costOriginStage: 'initiation',
      fatigueDecision: 'not_evaluated',
    };
    const sendParams = {
      companionId: A,
      channelId: CHANNEL,
      content: 'A normal first companion-channel message',
      messageId: deriveIcpTransportMessageId(correlation),
      initiation: {
        permitId: permit.permitId,
        conversationId: permit.conversationId,
        recipientCompanionId: B,
        correlation,
      },
    };

    const forgedRoot = await invoke(a, 206, 'companion.message.send', {
      ...sendParams,
      initiation: {
        ...sendParams.initiation,
        correlation: {
          ...correlation,
          rootInitiationId: '30303030-3030-4030-8030-303030303030',
        },
      },
    });
    expect(forgedRoot.error?.message).toContain('permit_mismatch');
    expect(store.permits.get(permit.permitId)).toMatchObject({ status: 'issued', revision: 1 });

    const first = await invoke(a, 207, 'companion.message.send', sendParams);
    expect(first.result).toMatchObject({
      channelId: CHANNEL,
      messageId: `companion-initiation-${candidateId}`,
      deliveredTo: [B],
      permitOutcome: 'consumed',
    });
    expect(store.permits.get(permit.permitId)).toMatchObject({ status: 'consumed', revision: 2 });
    const delivered = b.sent.filter(frame => frame.method === 'companion.message');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.params.message).toMatchObject({
      id: `companion-initiation-${candidateId}`,
      channelId: CHANNEL,
      authorId: A,
      content: 'A normal first companion-channel message',
      routing: { source: 'companion', icpCorrelation: correlation },
    });

    const replay = await invoke(a, 208, 'companion.message.send', sendParams);
    expect(replay.result).toMatchObject({
      messageId: `companion-initiation-${candidateId}`,
      permitOutcome: 'replayed',
    });
    expect(b.sent.filter(frame => frame.method === 'companion.message')).toHaveLength(1);
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
      revision: 2,
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
      revision: 2,
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
      revision: 3,
    });
    expect(store.permits.get(firstPermitId)).toMatchObject({
      status: 'revoked',
      reasonCode: 'peer_do_not_disturb',
    });

    await invoke(b, 25, 'companion.availability.publish', {
      companionId: B,
      state: 'open_to_chat',
      expiresAtMs: Date.now() + 120_000,
      revision: 4,
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

  it.each([
    ['sender', A],
    ['recipient', B],
  ] as const)(
    'linearizes the real contact block tool against permit consumption when the %s blocks',
    async (_side, blockerId) => {
      const { connect, store } = await setup();
      const a = connect();
      const b = connect();
      await identify(a, A, 120);
      await identify(b, B, 121);
      await invoke(b, 122, 'companion.availability.publish', {
        companionId: B,
        state: 'open_to_chat',
        expiresAtMs: Date.now() + 120_000,
        revision: 2,
      });
      const issue = await invoke(a, 123, 'companion.initiation.permit.issue', {
        companionId: A,
        candidate: candidate('12121212-1212-4212-8212-121212121212'),
        channelId: CHANNEL,
        permitExpiresAtMs: Date.now() + 60_000,
      });
      expect(issue.result.decision).toEqual({ eligible: true });
      const permit = issue.result.permit as IcpInitiationPermit;

      const consumeGate = deferred();
      store.beforeConsume = consumeGate.wait;
      const consuming = invoke(a, 124, 'companion.initiation.permit.consume', {
        companionId: A,
        permitId: permit.permitId,
        conversationId: permit.conversationId,
        recipientCompanionId: B,
        channelId: CHANNEL,
        rootInitiationId: ROOT,
        peerContactId: 'sender-contact-b',
      });
      await consumeGate.reached;

      const dir = mkdtempSync(join(tmpdir(), 'psfn-icp-block-race-'));
      const blockList = new ContactBlockListStore(join(dir, 'contact-block-list.json'));
      const { store: contactStore } = await createTestPostgresContactStore(blockerId);
      const blockerConnection = blockerId === A ? a : b;
      const peerId = blockerId === A ? B : A;
      let invalidationCall = 0;
      let racedPermitId: string | undefined;
      const tool = createContactTool(contactStore, {
        intake: INTAKE_FIREWALL_OFF_SELF_AUTHORED_MUTATION_RUNTIME,
        blockList,
        permitInvalidation: {
          invalidatePendingInitiationPermitsForBlock: async () => {
            invalidationCall += 1;
            const response = await invoke(
              blockerConnection,
              invalidationCall === 1 ? 125 : 127,
              'companion.initiation.permit.invalidate_for_self',
              { companionId: blockerId, reasonCode: 'peer_blocked' },
            );
            if (response.error) throw new Error(response.error.message);
            if (invalidationCall === 1) {
              const racedIssue = await invoke(a, 126, 'companion.initiation.permit.issue', {
                companionId: A,
                candidate: candidate('14141414-1414-4414-8414-141414141414'),
                channelId: CHANNEL,
                permitExpiresAtMs: Date.now() + 60_000,
              });
              expect(racedIssue.result.decision).toEqual({ eligible: true });
              racedPermitId = racedIssue.result.permit.permitId as string;
            }
            return response.result;
          },
        },
      });

      try {
        const blocked = await tool.execute('block-peer', {
          action: 'block',
          channel: 'companion',
          channelUserId: peerId,
          blockMode: 'hard',
        });
        expect(blocked.details?.isError).not.toBe(true);
        expect(blockList.get('companion', peerId)).toMatchObject({ mode: 'hard' });
        expect(store.permits.get(permit.permitId)).toMatchObject({
          status: 'revoked',
          reasonCode: 'peer_blocked',
        });
        expect(racedPermitId).toBeDefined();
        expect(store.permits.get(racedPermitId!)).toMatchObject({
          status: 'revoked',
          reasonCode: 'peer_blocked',
        });

        consumeGate.release();
        await expect(consuming).resolves.toMatchObject({
          result: { outcome: 'revoked', reasonCode: 'permit_revoked' },
        });
      } finally {
        consumeGate.release();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('keeps permit bearer values out of revocation conflict responses and gateway audit errors', async () => {
    const audit = createMockAuditStore();
    const { connect } = await setup(OPEN_POLICY, { auditStore: audit.store });
    const a = connect();
    const b = connect();
    await identify(a, A, 130);
    await identify(b, B, 131);
    await invoke(b, 132, 'companion.availability.publish', {
      companionId: B,
      state: 'open_to_chat',
      expiresAtMs: Date.now() + 120_000,
      revision: 2,
    });
    const issue = await invoke(a, 133, 'companion.initiation.permit.issue', {
      companionId: A,
      candidate: candidate('13131313-1313-4313-8313-131313131313'),
      channelId: CHANNEL,
      permitExpiresAtMs: Date.now() + 60_000,
    });
    const permitId = issue.result.permit.permitId as string;

    const conflict = await invoke(a, 134, 'companion.initiation.permit.revoke', {
      companionId: A,
      permitId,
      expectedRevision: 2,
    });

    expect(conflict.error).toBeDefined();
    expect(JSON.stringify(conflict.error)).toContain('ICP permit revocation conflict');
    expect(JSON.stringify(conflict.error)).not.toContain(permitId);
    const auditErrors = audit.complete.mock.calls
      .map((call: unknown[]) => call[2])
      .filter((error): error is string => typeof error === 'string');
    expect(auditErrors).toContain('ICP permit revocation conflict');
    expect(auditErrors.join('\n')).not.toContain(permitId);
  });

  it('does not admit a reconnect until durable disconnect invalidation completes', async () => {
    const { connect, store } = await setup();
    const a = connect();
    const b = connect();
    await identify(a, A, 30);
    await identify(b, B, 31);
    await invoke(b, 32, 'companion.availability.publish', {
      companionId: B,
      state: 'open_to_chat',
      expiresAtMs: Date.now() + 120_000,
      revision: 2,
    });
    const issue = await invoke(a, 33, 'companion.initiation.permit.issue', {
      companionId: A,
      candidate: candidate('88888888-8888-4888-8888-888888888888'),
      channelId: CHANNEL,
      permitExpiresAtMs: Date.now() + 60_000,
    });
    const permitId = issue.result.permit.permitId as string;

    const gate = deferred();
    store.beforeInvalidate = gate.wait;
    b.emitClose();
    await gate.reached;

    const replacement = connect();
    let identified = false;
    const identifying = identify(replacement, B, 34).then(() => { identified = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(identified).toBe(false);

    gate.release();
    await identifying;
    expect(store.permits.get(permitId)).toMatchObject({
      status: 'revoked',
      reasonCode: 'peer_offline',
    });
  });

  it('retries a rejected disconnect invalidation before admitting a reconnect', async () => {
    const { connect, store } = await setup();
    const a = connect();
    const b = connect();
    await identify(a, A, 35);
    await identify(b, B, 36);
    await invoke(b, 37, 'companion.availability.publish', {
      companionId: B,
      state: 'open_to_chat',
      expiresAtMs: Date.now() + 120_000,
      revision: 2,
    });
    const issue = await invoke(a, 38, 'companion.initiation.permit.issue', {
      companionId: A,
      candidate: candidate('99999999-9999-4999-8999-999999999999'),
      channelId: CHANNEL,
      permitExpiresAtMs: Date.now() + 60_000,
    });
    const permitId = issue.result.permit.permitId as string;

    const retryGate = deferred();
    let invalidationAttempts = 0;
    store.beforeInvalidate = async () => {
      invalidationAttempts += 1;
      if (invalidationAttempts === 1) throw new Error('database temporarily unavailable');
      await retryGate.wait();
    };
    b.emitClose();
    await vi.waitFor(() => expect(invalidationAttempts).toBe(1));
    await new Promise(resolve => setTimeout(resolve, 0));

    const replacement = connect();
    let identified = false;
    const identifying = identify(replacement, B, 39).then(() => { identified = true; });
    await vi.waitFor(() => expect(invalidationAttempts).toBe(2));
    expect(identified).toBe(false);

    retryGate.release();
    await identifying;
    expect(store.permits.get(permitId)).toMatchObject({
      status: 'revoked',
      reasonCode: 'peer_offline',
    });
  });

  it('rejects reconnect readiness while invalidation retries fail and recovers later', async () => {
    const { connect, store } = await setup();
    const a = connect();
    const b = connect();
    await identify(a, A, 40);
    await identify(b, B, 41);
    await invoke(b, 42, 'companion.availability.publish', {
      companionId: B,
      state: 'open_to_chat',
      expiresAtMs: Date.now() + 120_000,
      revision: 2,
    });
    const issue = await invoke(a, 43, 'companion.initiation.permit.issue', {
      companionId: A,
      candidate: candidate('aaaaaaaa-9999-4999-8999-999999999999'),
      channelId: CHANNEL,
      permitExpiresAtMs: Date.now() + 60_000,
    });
    const permitId = issue.result.permit.permitId as string;

    let invalidationAttempts = 0;
    store.beforeInvalidate = async () => {
      invalidationAttempts += 1;
      if (invalidationAttempts <= 2) throw new Error('database temporarily unavailable');
    };
    b.emitClose();
    await vi.waitFor(() => expect(invalidationAttempts).toBe(1));

    const rejectedReplacement = connect();
    const rejected = await invoke(rejectedReplacement, 44, 'gateway.client.identify', {
      role: 'agent',
      companionId: B,
      authToken: deriveCompanionAuthToken(B, 'agent', KEYRING),
    });
    expect(rejected.error).toBeDefined();
    expect(invalidationAttempts).toBe(2);
    expect(store.permits.get(permitId)?.status).toBe('issued');

    const recoveredReplacement = connect();
    await identify(recoveredReplacement, B, 45);
    expect(invalidationAttempts).toBe(3);
    expect(store.permits.get(permitId)).toMatchObject({
      status: 'revoked',
      reasonCode: 'peer_offline',
    });
  });
});
