/**
 * Composite production-composition certification for the shard approval-grant
 * chain (psfn-framework-2h6q.3; discharges the approval/grant core of
 * psfn-framework-2h6q.1).
 *
 * Assembled from the PRODUCTION pieces with no doubles on the certified chain:
 *
 *   real ShardManager launch/release state
 *     -> authenticated agent→gateway workload lifecycle RPC
 *     -> gateway-owned real ShardWorkloadRegistry (production handles)
 *     -> real GatewayServer construction path (options -> approval boundary ->
 *        confirmation queue -> ShardApprovalGrantAuthority)
 *     -> real gated method registration (home_assistant.call_service)
 *     -> real GatewayWorldOps request-context lineage stamping
 *     -> real Satellite-Hub HTTP egress (local stub server counts side effects)
 *
 * Doubles: the shard's LLM turn (SubstrateAgent.handleMessage barrier), the
 * RPC socket transport (in-memory connection, as in server.test.ts), and the
 * Satellite Hub HTTP endpoint. LLM/provider/transport doubles are explicitly
 * allowed by the bead contract.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GatewayServer, type GatewayServerOptions } from './server.js';
import { GatewayErrors } from './protocol.js';
import type { GatewayRpcConnection } from './transport.js';
import type { HomeAssistantCallServiceParams } from './protocol.js';
import { GatewayWorldOps } from '../integrations/world/gateway-ops.js';
import { createWorldTool } from '../integrations/world/tools.js';
import {
  getRequestContext,
  runWithRequestContext,
} from '../../primitives/llm/request-context.js';
import { EventBus } from '../../shared/event-bus.js';
import { SessionStore } from '../../persistence/sessions/store.js';
import { SubstrateAgent } from '../../core/agent/substrate-agent.js';
import { ShardManager } from '../../faculties/shards/manager.js';
import { ShardWorkloadRegistry } from '../../faculties/shards/workload-registry.js';
import { CAPABILITY_TOKENS } from '../../system/capabilities/tokens.js';
import { deriveShardCapabilityGrant } from '../../system/capabilities/shard-derivation.js';
import { gateToolWithCapabilities } from '../../system/capabilities/gate.js';
import { allowShardRequestScopedCapabilityTransport } from '../../faculties/shards/request-scoped-capability-transport.js';
import type { ShardApprovalGrantAuditEvent } from '../../system/capabilities/shard-approval-grants.js';
import type {
  AuthenticatedShardWorkloadHandle,
  ShardWorkloadLifecyclePort,
  ShardWorkloadRegistrationInput,
} from '../../system/capabilities/shard-approval-grant-contracts.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { SessionHmacKeyring } from '../../persistence/journals/journal-utils.js';
import type { ChannelOutboundDock } from '../../channels/backplane/types.js';
import type { LLMProviderPort } from '../../core/agent/contracts.js';

vi.mock('./transport.js', () => ({
  createSocketServer: vi.fn(),
  createWebSocketRpcServer: vi.fn(),
}));

import { createSocketServer } from './transport.js';

const mockedCreateSocketServer = vi.mocked(createSocketServer);

const PARENT = '22222222-2222-4222-8222-222222222221';
const HUB_TOKEN_ENV = 'SATELLITE_HUB_CONTROL_TOKEN';

const TEST_SESSION_HMAC_KEYRING: SessionHmacKeyring = {
  activeVersion: 'v1',
  keys: { v1: 'composite-test-secret' },
};

const noopDock: ChannelOutboundDock = {
  id: 'test-dock',
  outbound: {
    textChunkLimit: 2000,
    sendText: async () => {},
  },
};

const SHARD_TURN_RESPONSE = {
  content: 'bounded response',
  attachments: [],
  metadata: {
    model: 'test-model',
    inputTokens: 3,
    outputTokens: 4,
    durationMs: 5,
  },
};

function buildConfig(dataDir: string): SubstrateConfig {
  return {
    primaryModel: 'test-model',
    primaryProvider: 'test',
    extractionModel: 'test-model',
    extractionProvider: 'test',
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir,
    databasePath: ':memory:',
    sessionMessageLimit: 30,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    primaryMaxTokens: 16_384,
    extractionMaxTokens: 8_192,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    companionId: PARENT,
    characterName: 'Composite Companion',
    capabilityTier: 'autonomous',
    modelRoster: {
      chat: {
        model: 'test-model',
        provider: 'test',
        maxTokens: 16_384,
        contextWindow: 128_000,
      },
    },
  };
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function createMockConnection() {
  const emitter = new EventEmitter();
  const sent: unknown[] = [];
  let destroyed = false;
  const conn = {
    send(data: unknown): boolean {
      sent.push(data);
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
  return { conn: conn as unknown as GatewayRpcConnection, sent, _emit: conn._emit };
}

type MockConnection = ReturnType<typeof createMockConnection>;

let rpcIdCounter = 0;

async function invokeRpc(
  conn: MockConnection,
  method: string,
  params: unknown,
): Promise<any> {
  const id = ++rpcIdCounter;
  conn._emit({ jsonrpc: '2.0', id, method, params });
  for (let attempt = 0; attempt < 400; attempt++) {
    const response = conn.sent.find(
      (msg: any) => msg?.id === id && ('result' in (msg as object) || 'error' in (msg as object)),
    ) as { result?: unknown; error?: { code: number; message: string } } | undefined;
    if (response) return response;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`No RPC response found for ${method}`);
}

/** Production client-facing shim: raw JSON-RPC over the mocked transport. */
function homeAssistantOpsFor(conn: MockConnection) {
  const request = async (method: string, params: unknown): Promise<unknown> => {
    const response = await invokeRpc(conn, method, params);
    if (response.error) {
      throw Object.assign(new Error(response.error.message), { code: response.error.code });
    }
    return response.result;
  };
  return {
    getStates: (params: unknown) => request('home_assistant.get_states', params ?? {}) as any,
    callService: (params: HomeAssistantCallServiceParams) =>
      request('home_assistant.call_service', params) as any,
  };
}

/** Agent-process side of the authenticated workload lifecycle RPC. */
function workloadLifecycleFor(conn: MockConnection): ShardWorkloadLifecyclePort {
  const leases = new WeakMap<AuthenticatedShardWorkloadHandle, string>();
  return {
    registerWorkload: async (
      input: ShardWorkloadRegistrationInput,
    ): Promise<AuthenticatedShardWorkloadHandle> => {
      const registrationId = randomUUID();
      const response = await invokeRpc(conn, 'shard.workload.register', {
        registrationId,
        shardId: input.shardId,
        ...(input.shardLabel ? { shardLabel: input.shardLabel } : {}),
        channelIds: [...input.channelIds],
        ownerVersion: input.capabilityGrant.ownerVersion,
        grantDigest: input.capabilityGrant.grantDigest,
      });
      if (response.error) {
        throw Object.assign(new Error(response.error.message), { code: response.error.code });
      }
      const handle = Object.freeze({
        kind: 'authenticated-shard-workload' as const,
      }) as AuthenticatedShardWorkloadHandle;
      leases.set(handle, registrationId);
      return handle;
    },
    endWorkload: async (handle: AuthenticatedShardWorkloadHandle): Promise<void> => {
      const registrationId = leases.get(handle);
      if (!registrationId) throw new Error('Unknown test workload handle');
      const response = await invokeRpc(conn, 'shard.workload.end', { registrationId });
      if (response.error) {
        throw Object.assign(new Error(response.error.message), { code: response.error.code });
      }
      leases.delete(handle);
    },
  };
}

async function startServer(options: GatewayServerOptions): Promise<{
  server: GatewayServer;
  conn: MockConnection;
}> {
  const server = new GatewayServer(options);
  let onConnectionCb: ((conn: GatewayRpcConnection) => void) | null = null;
  mockedCreateSocketServer.mockImplementation((_path, cb) => {
    onConnectionCb = cb;
    return {
      close: vi.fn((onClosed?: () => void) => onClosed?.()),
      listen: vi.fn(),
    } as any;
  });
  server.start();
  const conn = createMockConnection();
  onConnectionCb!(conn.conn);
  await new Promise((r) => setTimeout(r, 5));
  const identify = await invokeRpc(conn, 'gateway.client.identify', {
    role: 'agent',
    companionId: PARENT,
  });
  expect(identify.error).toBeUndefined();
  const ready = await invokeRpc(conn, 'gateway.client.ready', {});
  expect(ready.error).toBeUndefined();
  return { server, conn };
}

function callServiceParams(): HomeAssistantCallServiceParams {
  return {
    domain: 'light',
    service: 'turn_on',
    placeId: 'den',
    affordanceId: 'den-lamp',
    entityId: 'light.den_lamp',
    reason: 'Task needs the den lamp on',
    intent: 'direct',
  };
}

describe('shard approval-grant production composition (2h6q.3 / 2h6q.1)', () => {
  let dataDir: string;
  let hubServer: Server;
  let hubCalls: Array<{ path: string; body: string }> = [];
  let hubBaseUrl = '';

  // Per-channel barriers keeping real shard turns (and therefore real
  // registered workload generations) alive while approvals are in flight.
  const turnGates = new Map<string, Deferred>();
  let releaseAllShardTurns = false;
  const gateFor = (channelId: string): Deferred => {
    let gate = turnGates.get(channelId);
    if (!gate) {
      gate = deferred();
      if (releaseAllShardTurns) gate.resolve();
      turnGates.set(channelId, gate);
    }
    return gate;
  };
  let handleMessageSpy: ReturnType<typeof vi.spyOn>;

  const registry = new ShardWorkloadRegistry();
  const auditEvents: ShardApprovalGrantAuditEvent[] = [];
  const requestedEvents: Array<{ companionId: string; shardId?: string }> = [];
  const resolvedEvents: Array<{ companionId: string; shardId?: string }> = [];

  let shardManager: ShardManager;
  let mainServer: GatewayServer;
  let mainConn: MockConnection;
  let expiryServer: GatewayServer;
  let expiryConn: MockConnection;
  let bareServer: GatewayServer;
  let bareConn: MockConnection;

  const spawnedPromises: Array<Promise<unknown>> = [];

  function serverOptions(overrides: Partial<GatewayServerOptions> = {}): GatewayServerOptions {
    const eventBus = new EventBus();
    return {
      socketPath: '/tmp/composite-test.sock',
      llmProvider: { stream: vi.fn(), complete: vi.fn() } as unknown as GatewayServerOptions['llmProvider'],
      embeddingService: { embed: vi.fn(), embedBatch: vi.fn(), dims: 8 } as unknown as GatewayServerOptions['embeddingService'],
      discordAdapter: noopDock,
      policyConfig: {
        workspacePath: '/workspace',
        homeAssistant: {
          enabled: true,
          hubBaseUrl,
          tokenConfigured: true,
          placesRegistry: {
            places: [{
              placeId: 'den',
              siteId: 'home',
              displayName: 'The Den',
              kind: 'physical',
              affordances: [{
                affordanceId: 'den-lamp',
                role: 'effector',
                kind: 'light',
                backend: 'ha',
                entityId: 'light.den_lamp',
                control: ['on', 'off', 'toggle'],
              }],
            }],
          },
        },
      },
      sessionHmacKeyring: TEST_SESSION_HMAC_KEYRING,
      wyomingShardRouting: { enabled: false },
      eventBus,
      approvalParentLabelProvider: () => 'Composite Companion',
      capabilityTierProvider: () => 'autonomous',
      capabilityGrantSnapshotProvider: () => ({
        tier: 'custom',
        customTokens: [...CAPABILITY_TOKENS],
        grantedTokens: [...CAPABILITY_TOKENS],
      }),
      confirmation: { expiryMs: 60_000 },
      ...overrides,
    };
  }

  async function spawnLiveShard(name: string): Promise<{ shardId: string; channelId: string }> {
    const before = new Set(shardManager.getActiveShards().map((shard) => shard.id));
    const pending = shardManager.spawn({ name, task: `Composite task for ${name}` });
    spawnedPromises.push(pending);
    let shardId: string | undefined;
    await vi.waitFor(() => {
      shardId = shardManager.getActiveShards().find((shard) => !before.has(shard.id))?.id;
      expect(shardId).toBeDefined();
    }, { timeout: 5_000 });
    return { shardId: shardId!, channelId: `shard:${shardId!}` };
  }

  beforeAll(async () => {
    process.env[HUB_TOKEN_ENV] = 'composite-hub-token';
    dataDir = mkdtempSync(join(tmpdir(), 'shard-grant-composite-'));

    hubCalls = [];
    hubServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        hubCalls.push({ path: request.url ?? '', body: Buffer.concat(chunks).toString('utf8') });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => {
      hubServer.listen(0, '127.0.0.1', () => resolve());
    });
    const address = hubServer.address();
    if (!address || typeof address === 'string') throw new Error('hub stub did not bind');
    hubBaseUrl = `http://127.0.0.1:${address.port}`;

    // Real shard turns run through SubstrateAgent; the LLM turn itself is the
    // allowed double, held open per channel so the registered workload
    // generation stays live while approvals resolve.
    handleMessageSpy = vi.spyOn(SubstrateAgent.prototype, 'handleMessage')
      .mockImplementation(async function (this: SubstrateAgent, message: any) {
        await gateFor(message.channelId).promise;
        return { ...SHARD_TURN_RESPONSE, channelId: message.channelId } as never;
      });

    const mainOptions = serverOptions({
      shardApprovalWorkloads: registry,
      shardApprovalGrantAudit: (event) => auditEvents.push(event),
    });
    mainOptions.eventBus.on('companion.approval.requested', (event: any) => {
      requestedEvents.push({
        companionId: event.companionId,
        ...(event.shardId !== undefined ? { shardId: event.shardId } : {}),
      });
    });
    mainOptions.eventBus.on('companion.approval.resolved', (event: any) => {
      resolvedEvents.push({
        companionId: event.companionId,
        ...(event.shardId !== undefined ? { shardId: event.shardId } : {}),
      });
    });
    ({ server: mainServer, conn: mainConn } = await startServer(mainOptions));

    const config = buildConfig(dataDir);
    shardManager = new ShardManager({
      eventBus: new EventBus(),
      llmProvider: { stream: vi.fn(), complete: vi.fn() } as unknown as LLMProviderPort,
      sessionStore: new SessionStore(dataDir),
      embeddingService: null,
      memoryProvider: null,
      config,
      parentSystemPrompt: 'composite parent prompt',
      snapshotParentCapabilityGrant: () => ({
        tier: 'custom',
        customTokens: [...CAPABILITY_TOKENS],
        grantedTokens: [...CAPABILITY_TOKENS],
      }),
      // Split topology: the manager owns no registry reference. It registers
      // through the authenticated agent→gateway RPC on mainConn.
      workloadRegistry: workloadLifecycleFor(mainConn),
    });

    ({ server: expiryServer, conn: expiryConn } = await startServer(serverOptions({
      shardApprovalWorkloads: registry,
      confirmation: { expiryMs: 120 },
    })));

    // No workload registry at all: the shard fence must still hold.
    ({ server: bareServer, conn: bareConn } = await startServer(serverOptions()));
  }, 30_000);

  afterAll(async () => {
    releaseAllShardTurns = true;
    for (const gate of turnGates.values()) gate.resolve();
    await Promise.allSettled(spawnedPromises);
    handleMessageSpy.mockRestore();
    await mainServer.stop();
    await expiryServer.stop();
    await bareServer.stop();
    await new Promise<void>((resolve) => hubServer.close(() => resolve()));
    delete process.env[HUB_TOKEN_ENV];
    rmSync(dataDir, { recursive: true, force: true });
  }, 30_000);

  it('carries a live shard request through human approval to exactly one execution, then denies replay', async () => {
    const { shardId, channelId } = await spawnLiveShard('World Shard');
    // Production feed: ShardManager launch registered the workload.
    const workloadHandle = registry.resolveWorkloadForChannel(PARENT, channelId);
    const workload = workloadHandle
      ? registry.resolveAuthenticatedWorkload(workloadHandle)
      : undefined;
    expect(workload).toBeDefined();

    const worldOps = new GatewayWorldOps(homeAssistantOpsFor(mainConn));
    const placesRegistry = serverOptions().policyConfig.homeAssistant?.placesRegistry;
    if (!placesRegistry || !workload) throw new Error('Composite world registry/workload missing');
    const worldTool = gateToolWithCapabilities(
      createWorldTool(worldOps, {
        placesRegistry,
        controlEnabled: true,
        resolveRequesterTrust: () => getRequestContext()?.viewerTrustLevel,
        resolveRequesterProvenance: () => getRequestContext()?.requesterProvenance,
        allowRequestScopedApprovalTransport: () =>
          getRequestContext()?.channelId?.startsWith('shard:') === true,
      }),
      () => workload.capabilityGrant.access,
      undefined,
      allowShardRequestScopedCapabilityTransport,
    );
    // Exercise both real agent-side fences before the RPC: the derived shard
    // grant lacks world.control, and the shard requester has regular trust.
    expect(workload.capabilityGrant.access.has('world.control')).toBe(false);
    const requestResult = await runWithRequestContext({
      channelId,
      viewerTrustLevel: 'regular',
      requesterProvenance: 'system',
    }, async () => await worldTool.execute('composite-world-control', {
      action: 'control',
      affordanceId: 'den-lamp',
      command: 'on',
      intent: 'attention',
      reason: 'Ask the operator to approve the shard lighting request',
    }));
    expect(requestResult.details?.isError).toBe(true);
    expect(requestResult.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringMatching(/confirmation|approval/ui) }),
    ]));
    expect(hubCalls).toHaveLength(0);

    const pending = mainServer.listOperatorConfirmations().pending;
    expect(pending).toHaveLength(1);
    const entry = pending[0];
    expect(entry.method).toBe('home_assistant.call_service');
    expect(entry.resolutionAuthority).toBe('operator');
    expect(entry.attribution).toMatchObject({
      parentId: PARENT,
      parentLabel: 'Composite Companion',
      shardId,
      shardLabel: 'World Shard',
    });
    expect(mainServer.approvalOwnerOfConfirmation(entry.id)).toEqual({
      companionId: PARENT,
      shardId,
    });
    await vi.waitFor(() => {
      expect(requestedEvents).toContainEqual({ companionId: PARENT, shardId });
    });
    expect(auditEvents.map((event) => event.outcome)).toEqual(['prepared']);

    // A leaked approval id is resolved against its stored owner before the
    // queue entry is exposed to a foreign companion.
    await expect(mainServer.resolveCompanionApproval({
      id: entry.id,
      decision: 'approve',
      companionId: '33333333-3333-4333-8333-333333333331',
    })).resolves.toMatchObject({ status: 'not_found', executed: false });
    expect(hubCalls).toHaveLength(0);

    // A companion resolver cannot clear an operator-only shard approval.
    await expect(mainServer.resolveCompanionApproval({
      id: entry.id,
      decision: 'approve',
      companionId: PARENT,
    })).resolves.toMatchObject({ status: 'failed', executed: false });
    expect(hubCalls).toHaveLength(0);

    // Operator approval: exactly one execution, one hub side effect.
    await expect(mainServer.resolveOperatorApproval({
      id: entry.id,
      decision: 'approve',
    })).resolves.toMatchObject({ status: 'approved', executed: true });
    expect(hubCalls).toHaveLength(1);
    expect(hubCalls[0]?.path).toBe('/internal/v1/home-assistant/call-service');
    expect(auditEvents.map((event) => event.outcome))
      .toEqual(['prepared', 'issued', 'consumed', 'executed']);
    const issued = auditEvents.find((event) => event.outcome === 'issued');
    expect(issued).toMatchObject({
      parentCompanionId: PARENT,
      shardId,
      token: 'world.control',
      method: 'home_assistant.call_service',
      action: 'home_assistant.control',
      resolverKind: 'operator',
    });
    await vi.waitFor(() => {
      expect(resolvedEvents).toContainEqual({ companionId: PARENT, shardId });
    });

    // Replay of the resolved approval id executes nothing.
    await expect(mainServer.resolveOperatorApproval({
      id: entry.id,
      decision: 'approve',
    })).resolves.toMatchObject({ status: 'not_found', executed: false });
    expect(hubCalls).toHaveLength(1);
    expect(auditEvents.map((event) => event.outcome))
      .toEqual(['prepared', 'issued', 'consumed', 'executed']);
  }, 20_000);

  it('preserves the parent companion autonomous auto-clear on the same method', async () => {
    const worldOps = new GatewayWorldOps(homeAssistantOpsFor(mainConn));
    const hubCallsBefore = hubCalls.length;
    // No request context: this is the parent's own dispatch.
    const result = await worldOps.callService(callServiceParams());
    expect(result).toMatchObject({ domain: 'light', service: 'turn_on' });
    expect(hubCalls).toHaveLength(hubCallsBefore + 1);
    expect(mainServer.listOperatorConfirmations().pending).toHaveLength(0);
  }, 20_000);

  it('denies a shard-recognizable dispatch with no live workload (fail closed)', async () => {
    const worldOps = new GatewayWorldOps(homeAssistantOpsFor(mainConn));
    const hubCallsBefore = hubCalls.length;
    await expect(
      runWithRequestContext({ channelId: 'shard:never-registered' }, async () =>
        worldOps.callService(callServiceParams())),
    ).rejects.toMatchObject({ code: GatewayErrors.POLICY_DENIED });
    expect(hubCalls).toHaveLength(hubCallsBefore);
  }, 20_000);

  it('denies a pending approval after a replacement workload generation supersedes the requester', async () => {
    const { shardId, channelId } = await spawnLiveShard('Replaced Shard');
    const worldOps = new GatewayWorldOps(homeAssistantOpsFor(mainConn));
    await expect(
      runWithRequestContext({ channelId }, async () => worldOps.callService(callServiceParams())),
    ).rejects.toMatchObject({ code: GatewayErrors.NEEDS_APPROVAL });
    const entry = mainServer.listOperatorConfirmations().pending
      .find((candidate) => candidate.attribution?.shardId === shardId);
    expect(entry).toBeDefined();

    // Production supersede semantics: a replacement generation for the same
    // (parent, shard) invalidates the requester's workload handle.
    const registration = registry.resolveAuthenticatedWorkload(
      registry.resolveWorkloadForChannel(PARENT, channelId)!,
    )!;
    registry.registerWorkload({
      parentCompanionId: registration.parentCompanionId,
      shardId: registration.shardId,
      shardLabel: registration.shardLabel ?? 'Replaced Shard',
      channelIds: [channelId, `${channelId}:human`],
      capabilityGrant: registration.capabilityGrant,
    });

    const hubCallsBefore = hubCalls.length;
    await expect(mainServer.resolveOperatorApproval({
      id: entry!.id,
      decision: 'approve',
    })).resolves.toMatchObject({ status: 'failed', executed: false });
    expect(hubCalls).toHaveLength(hubCallsBefore);
    expect(auditEvents.some((event) => event.outcome === 'executed' && event.shardId === shardId))
      .toBe(false);
  }, 20_000);

  it('denies a pending approval from an ended shard even while a live sibling remains', async () => {
    const sibling = await spawnLiveShard('Sibling Shard');
    const ending = await spawnLiveShard('Ending Shard');
    const worldOps = new GatewayWorldOps(homeAssistantOpsFor(mainConn));
    await expect(
      runWithRequestContext({ channelId: ending.channelId }, async () =>
        worldOps.callService(callServiceParams())),
    ).rejects.toMatchObject({ code: GatewayErrors.NEEDS_APPROVAL });
    const entry = mainServer.listOperatorConfirmations().pending
      .find((candidate) => candidate.attribution?.shardId === ending.shardId);
    expect(entry).toBeDefined();

    // Complete the requesting shard: ShardManager release ends its workload.
    gateFor(ending.channelId).resolve();
    await spawnedPromises[spawnedPromises.length - 1];
    await vi.waitFor(() => {
      expect(registry.resolveWorkloadForChannel(PARENT, ending.channelId)).toBeUndefined();
    });
    // The sibling stays live but cannot satisfy the ended requester's grant.
    expect(registry.resolveWorkloadForChannel(PARENT, sibling.channelId)).toBeDefined();

    const hubCallsBefore = hubCalls.length;
    await expect(mainServer.resolveOperatorApproval({
      id: entry!.id,
      decision: 'approve',
    })).resolves.toMatchObject({ status: 'failed', executed: false });
    expect(hubCalls).toHaveLength(hubCallsBefore);
  }, 20_000);

  it('expires an unresolved shard approval and audits the terminal expiry', async () => {
    const { channelId, shardId } = await spawnLiveShard('Expiry Shard');
    const worldOps = new GatewayWorldOps(homeAssistantOpsFor(expiryConn));
    await expect(
      runWithRequestContext({ channelId }, async () => worldOps.callService(callServiceParams())),
    ).rejects.toMatchObject({ code: GatewayErrors.NEEDS_APPROVAL });
    const entry = expiryServer.listOperatorConfirmations().pending
      .find((candidate) => candidate.attribution?.shardId === shardId);
    expect(entry).toBeDefined();

    await new Promise((r) => setTimeout(r, 200));
    const hubCallsBefore = hubCalls.length;
    await expect(expiryServer.resolveOperatorApproval({
      id: entry!.id,
      decision: 'approve',
    })).resolves.toMatchObject({ status: 'expired', executed: false });
    expect(hubCalls).toHaveLength(hubCallsBefore);
  }, 20_000);

  it('denies an ended satellite-scheme shard channel instead of auto-clearing (registry-backed recognition)', async () => {
    // Satellite/Wyoming delegations register arbitrary channel schemes (no
    // `shard:` prefix). Recognition must come from registry state, so an
    // ended workload's channel can never fall through to the autonomous
    // parent's auto-clear.
    const wyomingChannel = 'api:wyoming:home:voice-sat-1';
    const handle = registry.registerWorkload({
      parentCompanionId: PARENT,
      shardId: 'wyoming-shard-composite-1',
      shardLabel: 'Satellite Shard',
      channelIds: [wyomingChannel],
      capabilityGrant: deriveShardCapabilityGrant({
        companionId: PARENT,
        tier: 'custom',
        customTokens: [...CAPABILITY_TOKENS],
      }),
    });
    const worldOps = new GatewayWorldOps(homeAssistantOpsFor(mainConn));

    // While live, the satellite channel resolves its workload: the dispatch
    // takes the exact-once grant path (never the parent's autonomy).
    await expect(
      runWithRequestContext({ channelId: wyomingChannel }, async () =>
        worldOps.callService(callServiceParams())),
    ).rejects.toMatchObject({ code: GatewayErrors.NEEDS_APPROVAL });

    // Ended workload: the same channel is still recognizably shard-originated
    // and must deny fail-closed under the autonomous parent tier.
    registry.endWorkload(handle);
    const hubCallsBefore = hubCalls.length;
    await expect(
      runWithRequestContext({ channelId: wyomingChannel }, async () =>
        worldOps.callService(callServiceParams())),
    ).rejects.toMatchObject({ code: GatewayErrors.POLICY_DENIED });
    expect(hubCalls).toHaveLength(hubCallsBefore);

    // A channel that never hosted a shard keeps the ordinary parent path.
    const parentResult = await runWithRequestContext(
      { channelId: 'discord:general-777' },
      async () => worldOps.callService(callServiceParams()),
    );
    expect(parentResult).toMatchObject({ domain: 'light', service: 'turn_on' });
    expect(hubCalls).toHaveLength(hubCallsBefore + 1);
  }, 20_000);

  it('fails closed for shard-recognizable dispatches when no workload registry is configured', async () => {
    const shard = shardManager.getActiveShards()
      .find((candidate) => candidate.name === 'Sibling Shard');
    expect(shard).toBeDefined();
    const worldOps = new GatewayWorldOps(homeAssistantOpsFor(bareConn));
    const hubCallsBefore = hubCalls.length;
    // Autonomous parent tier + shard channel + NO registry: still denied.
    await expect(
      runWithRequestContext({ channelId: `shard:${shard!.id}` }, async () =>
        worldOps.callService(callServiceParams())),
    ).rejects.toMatchObject({ code: GatewayErrors.POLICY_DENIED });
    expect(hubCalls).toHaveLength(hubCallsBefore);
    // The parent path on the same bare server keeps its autonomy.
    await expect(worldOps.callService(callServiceParams()))
      .resolves.toMatchObject({ domain: 'light' });
    expect(hubCalls).toHaveLength(hubCallsBefore + 1);
  }, 20_000);
});
