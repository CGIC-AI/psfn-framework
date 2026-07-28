import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
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
import type { SatelliteRegistryConfig } from '../../shared/contracts/satellite-registry.js';
import type { SubstrateMessage } from '../../shared/contracts/runtime.js';
import { deriveCompanionAuthToken } from './companion-auth.js';
import { EventBus } from '../../shared/event-bus.js';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CapabilityRuntime } from '../../system/capabilities/runtime.js';
import { GatewayCapabilityTierResolver } from './capability-tier-resolver.js';
import type { ResolvedCompanionsFleetConfig } from '../../system/config/companions-config.js';
import { deriveShardCapabilityGrant } from '../../system/capabilities/shard-derivation.js';
import { GatewayApiRuntime } from '../../channels/api/gateway-runtime.js';

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

const EMPTY_SATELLITE_REGISTRY: SatelliteRegistryConfig = {
  schemaVersion: 1,
  enabled: false,
  satellites: [],
};

type MockConnection = {
  conn: GatewayRpcConnection;
  sent: unknown[];
  _emit(message: unknown): void;
  _emitClose(): void;
  _emitHeartbeat(): void;
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
    _emitHeartbeat(): void {
      emitter.emit('heartbeat');
    },
  };

  return {
    conn: conn as unknown as GatewayRpcConnection,
    sent,
    _emit: conn._emit,
    _emitClose: conn._emitClose,
    _emitHeartbeat: conn._emitHeartbeat,
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
    eventBus: new EventBus(),
    approvalParentLabelProvider: (companionId) => `Test ${companionId}`,
  };
}

function withSharedSatelliteEligibility(
  options: GatewayServerOptions,
): GatewayServerOptions {
  return {
    ...options,
    icpAutonomyStore: {
      getAvailability: vi.fn(async (companionId: string) => ({
        companionId,
        state: 'available',
        issuedAtMs: Date.now() - 1_000,
        expiresAtMs: Date.now() + 60_000,
        source: 'companion',
        revision: 1,
      })),
    } as any,
    icpInitiationPolicyAuthority: {
      resolve: vi.fn(),
      authorizeHandoff: vi.fn(),
      runAuthorizedHandoff: vi.fn(),
    } as any,
    sharedSatelliteQuietHoursAllows: () => true,
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
    return {
      close: vi.fn((done?: () => void) => done?.()),
      listen: vi.fn(),
    } as any;
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
    authToken: deriveCompanionAuthToken(companionId, 'agent', TEST_SESSION_HMAC_KEYRING),
  });
}

async function identifySessionIntegrityWorker(
  conn: MockConnection,
  companionId: string,
  rpcId = 950,
): Promise<any> {
  return await invokeRpc(conn, rpcId, 'gateway.client.identify', {
    role: 'internal_session_integrity',
    companionId,
    authToken: deriveCompanionAuthToken(
      companionId,
      'internal_session_integrity',
      TEST_SESSION_HMAC_KEYRING,
    ),
  });
}

function multiCompanion(
  channelRouting: GatewayMultiCompanionConfig['channelRouting'],
  discordAccounts: GatewayMultiCompanionConfig['discordAccounts'] = {},
): GatewayMultiCompanionConfig {
  return {
    enabled: true,
    fleetCompanionIds: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'],
    channelRouting,
    discordAccounts,
    personalWorkspaceByCompanionId: {
      '11111111-1111-4111-8111-111111111111': '/workspace/11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222': '/workspace/22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333': '/workspace/33333333-3333-4333-8333-333333333333',
    },
  };
}

function resolvedFleet(companionIds: readonly string[]) {
  return {
    persistenceRoot: '/runtime',
    workspacesRoot: '/runtime/workspaces',
    sharedWorkspacePath: '/runtime/workspaces/shared',
    companions: companionIds.map((companionId, index) => ({
      companionId,
      companionDataDir: `/runtime/companions/${index}`,
      characterCardPath: `/runtime/companions/${index}/companion.json`,
      postgresSchema: `companion_${index}`,
      personalWorkspacePath: `/runtime/workspaces/personal/${companionId}`,
    })),
  };
}

function methodFrames(conn: MockConnection, method: string): any[] {
  return conn.sent.filter((msg: any) => msg.method === method);
}

function fleetPosture(updatedAt: number, utilizationPercent: number) {
  return {
    schemaVersion: 1,
    updatedAt,
    charge: {
      state: utilizationPercent >= 100 ? 'exhausted' : 'pressured',
      utilizationPercent,
    },
    fatigue: {
      state: utilizationPercent >= 100 ? 'exhausted' : 'clear',
      utilizationPercent,
    },
  };
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

function makeSatelliteVoiceMessage(satelliteId: string, primaryCompanionId?: string) {
  const message = makeChannelMessage('api');
  message.routing = {
    source: 'satellite',
    canonicalContactId: 'contact-partner',
    satellite: {
      schemaVersion: 1,
      satelliteId,
      satelliteDisplayName: 'Satellite App',
      endpointId: 'voice',
      endpointDisplayName: 'Voice',
      claimType: 'voice',
      sessionId: `session-${satelliteId}`,
      mobility: 'mobile',
      promptChannelType: 'voice',
      ...(primaryCompanionId
        ? {
            sharedDevice: {
              primaryCompanionId,
              observationRecipients: [],
              emanationMemberIds: [primaryCompanionId],
              responseLease: { durationMs: 5_000, activeConversationTtlMs: 60_000 },
            },
          }
        : {}),
      capabilities: {
        advertised: ['audio_input'],
        registryMax: ['audio_input'],
        effective: ['audio_input'],
        policyDenied: [],
      },
      telemetryScopes: [],
      auth: { mode: 'api_key', principalId: 'principal-1', certBound: false },
    },
  };
  return message;
}

function voiceStreamResponder(routed: { messages: any[] }) {
  return (msg: any, emit: (response: unknown) => void) => {
    if (!msg.id || typeof msg.method !== 'string') return;
    if (msg.method === 'satellite.response.eligibility') {
      emit({
        jsonrpc: '2.0',
        id: msg.id,
        result: { fatigueAllows: true },
      });
      return;
    }
    if (msg.method === 'voice.transcript.begin' || msg.method === 'voice.transcript.chunk') {
      if (msg.method === 'voice.transcript.begin') {
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
    if (msg.method === 'voice.transcript.end') {
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
    expect(resolveGatewayMultiCompanionConfig({}, baseChannels(), EMPTY_SATELLITE_REGISTRY)).toEqual({
      enabled: false,
      fleetCompanionIds: [],
      channelRouting: {},
      discordAccounts: {},
      personalWorkspaceByCompanionId: {},
    });
  });

  it('builds the routing table from channels.json companionId fields when enabled', () => {
    const channels = baseChannels();
    channels.discord.companionId = '11111111-1111-4111-8111-111111111111';
    channels.telegram.companionId = '22222222-2222-4222-8222-222222222222';
    channels.api.companionId = '22222222-2222-4222-8222-222222222222';
    expect(resolveGatewayMultiCompanionConfig({
      multiCompanion: true,
      companionFleet: resolvedFleet(['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']),
    }, channels, EMPTY_SATELLITE_REGISTRY)).toEqual({
      enabled: true,
      fleetCompanionIds: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
      channelRouting: { discord: '11111111-1111-4111-8111-111111111111', telegram: '22222222-2222-4222-8222-222222222222', api: '22222222-2222-4222-8222-222222222222' },
      discordAccounts: {},
      personalWorkspaceByCompanionId: {
        '11111111-1111-4111-8111-111111111111': '/runtime/workspaces/personal/11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222': '/runtime/workspaces/personal/22222222-2222-4222-8222-222222222222',
      },
      sharedWorkspacePath: '/runtime/workspaces/shared',
    });
  });

  it('builds per-account discord routing from channels.json discord.accounts when enabled', () => {
    const channels = baseChannels();
    channels.discord.accounts = [
      {
        accountId: 'acct-a',
        companionId: '11111111-1111-4111-8111-111111111111',
        tokenEnvVar: 'DISCORD_TOKEN_A',
        token: 'token-a',
        heartbeatChannelId: '',
        allowedBotUserIds: [],
        groupMemory: { channelOverrides: {} } as any,
      },
      {
        accountId: 'acct-b',
        companionId: '22222222-2222-4222-8222-222222222222',
        tokenEnvVar: 'DISCORD_TOKEN_B',
        token: 'token-b',
        heartbeatChannelId: '',
        allowedBotUserIds: [],
        groupMemory: { channelOverrides: {} } as any,
      },
    ];
    expect(resolveGatewayMultiCompanionConfig({
      multiCompanion: true,
      companionFleet: resolvedFleet(['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']),
    }, channels, EMPTY_SATELLITE_REGISTRY)).toEqual({
      enabled: true,
      fleetCompanionIds: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
      channelRouting: {},
      discordAccounts: { 'acct-a': '11111111-1111-4111-8111-111111111111', 'acct-b': '22222222-2222-4222-8222-222222222222' },
      personalWorkspaceByCompanionId: {
        '11111111-1111-4111-8111-111111111111': '/runtime/workspaces/personal/11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222': '/runtime/workspaces/personal/22222222-2222-4222-8222-222222222222',
      },
      sharedWorkspacePath: '/runtime/workspaces/shared',
    });
  });

  it('fails closed when routing is declared for a single-companion deployment', () => {
    const channels = baseChannels();
    channels.discord.companionId = '11111111-1111-4111-8111-111111111111';
    expect(() => resolveGatewayMultiCompanionConfig({}, channels, EMPTY_SATELLITE_REGISTRY)).toThrow(
      /single-companion \(one-entry companions\.json\) deployment/,
    );
  });

  it('fails closed when discord.accounts is declared for a single-companion deployment', () => {
    const channels = baseChannels();
    channels.discord.accounts = [{
      accountId: 'acct-a',
      companionId: '11111111-1111-4111-8111-111111111111',
      tokenEnvVar: 'DISCORD_TOKEN_A',
      token: 'token-a',
      heartbeatChannelId: '',
      allowedBotUserIds: [],
      groupMemory: { channelOverrides: {} } as any,
    }];
    expect(() => resolveGatewayMultiCompanionConfig({}, channels, EMPTY_SATELLITE_REGISTRY)).toThrow(
      /discord\.accounts \[acct-a\] but this is a single-companion/,
    );
  });

  it('fails closed when enabled without a resolved fleet', () => {
    expect(() => resolveGatewayMultiCompanionConfig({
      multiCompanion: true,
    }, baseChannels(), EMPTY_SATELLITE_REGISTRY))
      .toThrow(/non-empty resolved companions\.json fleet/);
  });

  it('enables fleet-bound routing for a Fleet Auth roster with one entry', () => {
    expect(resolveGatewayMultiCompanionConfig({
      multiCompanion: false,
      fleetAuth: {} as never,
      companionFleet: resolvedFleet(['11111111-1111-4111-8111-111111111111']),
    }, baseChannels(), EMPTY_SATELLITE_REGISTRY)).toMatchObject({
      enabled: true,
      fleetCompanionIds: ['11111111-1111-4111-8111-111111111111'],
      personalWorkspaceByCompanionId: {
        '11111111-1111-4111-8111-111111111111':
          '/runtime/workspaces/personal/11111111-1111-4111-8111-111111111111',
      },
    });
  });

  it('fails closed when channel routing names a companion outside the fleet', () => {
    const channels = baseChannels();
    channels.api.companionId = '22222222-2222-4222-8222-222222222222';
    expect(() => resolveGatewayMultiCompanionConfig({
      multiCompanion: true,
      companionFleet: resolvedFleet(['11111111-1111-4111-8111-111111111111']),
    }, channels, EMPTY_SATELLITE_REGISTRY)).toThrow(/absent from companions\.json/);
  });

  it('fails closed when a shared satellite names a companion outside the fleet', () => {
    expect(() => resolveGatewayMultiCompanionConfig({
      multiCompanion: true,
      companionFleet: resolvedFleet(['11111111-1111-4111-8111-111111111111']),
    }, baseChannels(), {
      schemaVersion: 1,
      enabled: true,
      satellites: [{
        satelliteId: 'sat-app',
        displayName: 'Satellite App',
        mobility: 'mobile',
        sharedDevice: {
          primaryCompanionId: '22222222-2222-4222-8222-222222222222',
          observationRecipients: [],
          emanationMemberIds: ['22222222-2222-4222-8222-222222222222'],
          responseLease: { durationMs: 5_000, activeConversationTtlMs: 60_000 },
        },
        endpoints: [],
      }],
    })).toThrow(/satellites\.json.*absent from companions\.json/);
  });

  it('fails closed when an enabled fleet satellite omits shared-device authority', () => {
    expect(() => resolveGatewayMultiCompanionConfig({
      multiCompanion: true,
      companionFleet: resolvedFleet(['11111111-1111-4111-8111-111111111111']),
    }, baseChannels(), {
      schemaVersion: 1,
      enabled: true,
      satellites: [{
        satelliteId: 'sat-ungoverned',
        displayName: 'Ungoverned',
        mobility: 'static',
        endpoints: [],
      }],
    })).toThrow(/requires sharedDevice authority/);
  });

  it('does not silently ignore satellite ownership for a single-companion deployment', () => {
    expect(() => resolveGatewayMultiCompanionConfig({}, baseChannels(), {
      schemaVersion: 1,
      enabled: true,
      satellites: [{
        satelliteId: 'sat-app',
        displayName: 'Satellite App',
        mobility: 'mobile',
        sharedDevice: {
          primaryCompanionId: '11111111-1111-4111-8111-111111111111',
          observationRecipients: [],
          emanationMemberIds: ['11111111-1111-4111-8111-111111111111'],
          responseLease: { durationMs: 5_000, activeConversationTtlMs: 60_000 },
        },
        endpoints: [],
      }],
    })).toThrow(/single-companion \(one-entry companions\.json\) deployment/);
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

    const first = await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 901);
    const second = await identifyAgent(connB, '11111111-1111-4111-8111-111111111111', 902);
    expect(first.result).toEqual({ success: true, role: 'agent', companionId: '11111111-1111-4111-8111-111111111111' });
    expect(second.result).toEqual({ success: true, role: 'agent', companionId: '11111111-1111-4111-8111-111111111111' });
  });

  it('keeps satellite voice on the single ready-agent path while the flag is off', async () => {
    const routed = { messages: new Array<SubstrateMessage>() };
    const { server, connect } = await setupServer(createMinimalOptions());
    const conn = await connect(voiceStreamResponder(routed));
    await identifyAgent(conn, '11111111-1111-4111-8111-111111111111', 903);

    await expect(server.requestAgentVoiceStream(
      makeSatelliteVoiceMessage('sat-single', '22222222-2222-4222-8222-222222222222'),
    )).resolves.toMatchObject({ content: 'voice response' });
    expect(methodFrames(conn, 'voice.transcript.begin')).toHaveLength(1);
  });

  it('broadcasts inbound channel messages to every ready agent (characterizes existing behavior)', async () => {
    const { server, connect } = await setupServer(createMinimalOptions());
    const connA = await connect();
    const connB = await connect();

    expect(server.notifyChannelMessage('discord', 'discord.message', {
      message: { id: 'm1', channelId: 'ch1' },
    })).toBe(2);

    expect(methodFrames(connA, 'discord.message')).toHaveLength(1);
    expect(methodFrames(connB, 'discord.message')).toHaveLength(1);
  });

  it('disconnects a frame that explicitly carries a malformed companion identity claim', async () => {
    const auditAppend = vi.fn(async () => 7);
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      auditStore: createMockAuditStore({ append: auditAppend }),
    });
    const conn = await connect();

    conn._emit({
      jsonrpc: '2.0',
      id: 9,
      method: 'llm.complete',
      params: { companionId: null },
    });
    await new Promise(r => setTimeout(r, 20));

    expect(conn.conn.destroyed).toBe(true);
    expect(auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      method: 'gateway.companion.identity_claim_invalid',
      decision: 'DENY',
    }));
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
  it('validates and attributes posture by authenticated connection across reconnects', async () => {
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({}),
    });
    const connA = await connect();
    const connB = await connect();
    await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);
    await identifyAgent(connB, '22222222-2222-4222-8222-222222222222', 2);
    const now = Date.now();

    expect((await invokeRpc(connA, 3, 'gateway.client.health', {
      posture: fleetPosture(now, 25),
    })).result).toEqual({ success: true });
    expect((await invokeRpc(connB, 4, 'gateway.client.health', {
      posture: fleetPosture(now, 100),
    })).result).toEqual({ success: true });

    const initial = server.getFleetConnectionSnapshot(now);
    expect(initial.connections.find(connection => (
      connection.companionId === '11111111-1111-4111-8111-111111111111'
    ))?.posture?.charge.utilizationPercent).toBe(25);
    expect(initial.connections.find(connection => (
      connection.companionId === '22222222-2222-4222-8222-222222222222'
    ))?.posture?.charge.utilizationPercent).toBe(100);

    const spoof = await invokeRpc(connA, 5, 'gateway.client.health', {
      companionId: '11111111-1111-4111-8111-111111111111',
      posture: fleetPosture(now, 100),
    });
    expect(spoof.error?.message).toMatch(/accepts only/i);
    expect(server.getFleetConnectionSnapshot(now).connections.find(connection => (
      connection.companionId === '11111111-1111-4111-8111-111111111111'
    ))?.posture?.charge.utilizationPercent).toBe(25);

    connA._emitClose();
    await new Promise(resolve => setTimeout(resolve, 5));
    const replacementA = await connect();
    await identifyAgent(replacementA, '11111111-1111-4111-8111-111111111111', 6);
    expect(server.getFleetConnectionSnapshot(now).connections.find(connection => (
      connection.companionId === '11111111-1111-4111-8111-111111111111'
    ))?.posture).toBeUndefined();
    expect((await invokeRpc(replacementA, 7, 'gateway.client.health', {
      posture: fleetPosture(now, 50),
    })).result).toEqual({ success: true });
    expect(server.getFleetConnectionSnapshot(now).connections.find(connection => (
      connection.companionId === '11111111-1111-4111-8111-111111111111'
    ))?.posture?.charge.utilizationPercent).toBe(50);
  });

  it('refreshes only the sending companion from an unaudited transport heartbeat', async () => {
    const auditAppend = vi.fn(async () => 30);
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({}),
      auditStore: createMockAuditStore({ append: auditAppend }),
    });
    const connA = await connect();
    const connB = await connect();
    await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);
    await identifyAgent(connB, '22222222-2222-4222-8222-222222222222', 2);
    auditAppend.mockClear();

    const before = server.getFleetConnectionSnapshot();
    const beforeA = before.connections.find(connection => connection.companionId === '11111111-1111-4111-8111-111111111111')!;
    const beforeB = before.connections.find(connection => connection.companionId === '22222222-2222-4222-8222-222222222222')!;
    await new Promise(resolve => setTimeout(resolve, 5));
    connA._emitHeartbeat();

    const after = server.getFleetConnectionSnapshot();
    const afterA = after.connections.find(connection => connection.companionId === '11111111-1111-4111-8111-111111111111')!;
    const afterB = after.connections.find(connection => connection.companionId === '22222222-2222-4222-8222-222222222222')!;
    expect(afterA.lastSeenAt).toBeGreaterThan(beforeA.lastSeenAt);
    expect(afterB.lastSeenAt).toBe(beforeB.lastSeenAt);
    expect(auditAppend).not.toHaveBeenCalled();

    const realRpc = await invokeRpc(connA, 3, 'discord.typing', {
      channelId: '11111111-1111-4111-8111-111111111111-channel',
      companionId: '11111111-1111-4111-8111-111111111111',
    });
    expect(realRpc.result).toEqual({ success: true });
    expect(auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      method: 'discord.typing',
      decision: 'ALLOW',
    }));
  });

  it('keeps retained inline images private to the authenticated companion connection', async () => {
    const options = createMinimalOptions();
    const stream = vi.mocked(options.llmProvider.stream);
    const { connect } = await setupServer({
      ...options,
      visionIntake: {
        screenImage: vi.fn(async () => ({
          kind: 'screened' as const,
          mode: 'enforce' as const,
          flagged: false,
          withheld: false,
        })),
      },
      multiCompanion: multiCompanion({}),
    });
    const connA = await connect();
    const connB = await connect();
    await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);
    await identifyAgent(connB, '22222222-2222-4222-8222-222222222222', 2);

    const screened = await invokeRpc(connA, 3, 'intake.screen_image', {
      companionId: '11111111-1111-4111-8111-111111111111',
      imageBase64: 'aGVsbG8=',
      mimeType: 'image/png',
      originRef: 'discord:channel:message:attachment:0',
      requestScope: 'turn-a',
    });
    const handle = screened.result?.retainedImage?.handle as string | undefined;
    expect(handle).toEqual(expect.any(String));

    const legitimate = await invokeRpc(connA, 4, 'llm.chat', {
      companionId: '11111111-1111-4111-8111-111111111111',
      model: '',
      provider: '',
      systemPrompt: 'system',
      turnId: 'turn-a',
      messages: [{
        role: 'user',
        content: [{ type: 'gateway_image_ref', handle }],
      }],
    });
    expect(legitimate.error).toBeUndefined();
    expect(stream).toHaveBeenCalledTimes(1);

    const crossover = await invokeRpc(connB, 5, 'llm.chat', {
      companionId: '22222222-2222-4222-8222-222222222222',
      model: '',
      provider: '',
      systemPrompt: 'system',
      turnId: 'turn-a',
      messages: [{
        role: 'user',
        content: [{ type: 'gateway_image_ref', handle }],
      }],
    });
    expect(crossover.error?.code).toBe(GatewayErrors.INLINE_IMAGE_RETENTION_MISS);
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('clears retained inline images when the authenticated connection closes', async () => {
    const options = createMinimalOptions();
    const stream = vi.mocked(options.llmProvider.stream);
    const { connect } = await setupServer({
      ...options,
      visionIntake: {
        screenImage: vi.fn(async () => ({
          kind: 'screened' as const,
          mode: 'enforce' as const,
          flagged: false,
          withheld: false,
        })),
      },
      multiCompanion: multiCompanion({}),
    });
    const original = await connect();
    await identifyAgent(original, '11111111-1111-4111-8111-111111111111', 1);
    const screened = await invokeRpc(original, 2, 'intake.screen_image', {
      companionId: '11111111-1111-4111-8111-111111111111',
      imageBase64: 'aGVsbG8=',
      mimeType: 'image/png',
      originRef: 'discord:channel:message:attachment:0',
      requestScope: 'turn-disconnected',
    });
    const handle = screened.result?.retainedImage?.handle as string;
    original._emitClose();
    await new Promise(r => setTimeout(r, 5));

    const reconnected = await connect();
    await identifyAgent(reconnected, '11111111-1111-4111-8111-111111111111', 3);
    const afterReconnect = await invokeRpc(reconnected, 4, 'llm.chat', {
      companionId: '11111111-1111-4111-8111-111111111111',
      model: '',
      provider: '',
      systemPrompt: 'system',
      turnId: 'turn-disconnected',
      messages: [{
        role: 'user',
        content: [{ type: 'gateway_image_ref', handle }],
      }],
    });

    expect(afterReconnect.error?.code).toBe(GatewayErrors.INLINE_IMAGE_RETENTION_MISS);
    expect(stream).not.toHaveBeenCalled();
  });

  it('confines filesystem reads and writes to the authenticated Personal Workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-gateway-workspace-isolation-'));
    const personalA = join(root, 'personal', '11111111-1111-4111-8111-111111111111');
    const personalB = join(root, 'personal', '22222222-2222-4222-8222-222222222222');
    mkdirSync(personalA, { recursive: true });
    mkdirSync(personalB, { recursive: true });
    writeFileSync(join(personalA, 'note.txt'), 'alpha');
    writeFileSync(join(personalB, 'note.txt'), 'beta');
    try {
      const routing = multiCompanion({});
      routing.personalWorkspaceByCompanionId = {
        '11111111-1111-4111-8111-111111111111': personalA,
        '22222222-2222-4222-8222-222222222222': personalB,
        '33333333-3333-4333-8333-333333333333': join(root, 'personal', '33333333-3333-4333-8333-333333333333'),
      };
      const { connect } = await setupServer({
        ...createMinimalOptions(),
        multiCompanion: routing,
        capabilityTierProvider: () => 'autonomous',
      });
      const conn = await connect();
      await identifyAgent(conn, '11111111-1111-4111-8111-111111111111', 1);

      expect((await invokeRpc(conn, 2, 'fs.read', { path: 'note.txt' })).result.content)
        .toBe('alpha');
      expect((await invokeRpc(conn, 3, 'fs.read', { path: join(personalB, 'note.txt') })).error)
        .toBeDefined();
      expect((await invokeRpc(conn, 4, 'fs.write', {
        path: join(personalB, 'intrusion.txt'),
        content: 'nope',
      })).error).toBeDefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('denies filesystem writes and edits to every authenticated companion managed skills root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-gateway-skills-protection-'));
    const companionA = '11111111-1111-4111-8111-111111111111';
    const companionB = '22222222-2222-4222-8222-222222222222';
    const personalA = join(root, 'personal', companionA);
    const personalB = join(root, 'personal', companionB);
    for (const workspacePath of [personalA, personalB]) {
      mkdirSync(join(workspacePath, 'skills', 'x'), { recursive: true });
      writeFileSync(join(workspacePath, 'skills', 'x', 'SKILL.md'), 'before');
    }
    try {
      const routing = multiCompanion({});
      routing.personalWorkspaceByCompanionId = {
        [companionA]: personalA,
        [companionB]: personalB,
        '33333333-3333-4333-8333-333333333333': join(
          root,
          'personal',
          '33333333-3333-4333-8333-333333333333',
        ),
      };
      const baseOptions = createMinimalOptions();
      const { connect } = await setupServer({
        ...baseOptions,
        policyConfig: {
          ...baseOptions.policyConfig,
          protectedWritePaths: ['/workspace/skills'],
        },
        multiCompanion: routing,
        capabilityTierProvider: () => 'autonomous',
      });
      const connA = await connect();
      const connB = await connect();
      await identifyAgent(connA, companionA, 1);
      await identifyAgent(connB, companionB, 2);

      for (const [conn, workspacePath] of [[connA, personalA], [connB, personalB]] as const) {
        const skillPath = join(workspacePath, 'skills', 'x', 'SKILL.md');
        expect((await invokeRpc(conn, 3, 'fs.write', {
          path: skillPath,
          content: 'hostile',
        })).error?.code).toBe(GatewayErrors.POLICY_DENIED);
        expect((await invokeRpc(conn, 4, 'fs.edit', {
          path: skillPath,
          oldText: 'before',
          newText: 'hostile',
        })).error?.code).toBe(GatewayErrors.POLICY_DENIED);
        expect(readFileSync(skillPath, 'utf8')).toBe('before');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

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

  it('rejects a companionId outside the active fleet', async () => {
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({}),
    });
    const conn = await connect();

    const response = await identifyAgent(conn, '44444444-4444-4444-8444-444444444444', 2);
    expect(response.error).toMatchObject({ code: GatewayErrors.COMPANION_AUTH_FAILED });
    expect(response.error.message).toContain('active fleet');
  });

  it('rejects missing or invalid companion authentication', async () => {
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({}),
    });
    const missing = await connect();
    const invalid = await connect();

    const missingResponse = await invokeRpc(missing, 3, 'gateway.client.identify', {
      role: 'agent',
      companionId: '11111111-1111-4111-8111-111111111111',
    });
    const invalidResponse = await invokeRpc(invalid, 4, 'gateway.client.identify', {
      role: 'agent',
      companionId: '11111111-1111-4111-8111-111111111111',
      authToken: 'v1.not-a-valid-token',
    });

    expect(missingResponse.error).toMatchObject({ code: GatewayErrors.COMPANION_AUTH_FAILED });
    expect(invalidResponse.error).toMatchObject({ code: GatewayErrors.COMPANION_AUTH_FAILED });
  });

  it('binds authentication tokens to the requested connection role', async () => {
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({}),
    });
    const workerAsAgent = await connect();
    const agentAsWorker = await connect();

    const workerEscalation = await invokeRpc(workerAsAgent, 6, 'gateway.client.identify', {
      role: 'agent',
      companionId: '11111111-1111-4111-8111-111111111111',
      authToken: deriveCompanionAuthToken(
        '11111111-1111-4111-8111-111111111111',
        'internal_session_integrity',
        TEST_SESSION_HMAC_KEYRING,
      ),
    });
    const agentEscalation = await invokeRpc(agentAsWorker, 7, 'gateway.client.identify', {
      role: 'internal_session_integrity',
      companionId: '11111111-1111-4111-8111-111111111111',
      authToken: deriveCompanionAuthToken('11111111-1111-4111-8111-111111111111', 'agent', TEST_SESSION_HMAC_KEYRING),
    });

    expect(workerEscalation.error).toMatchObject({ code: GatewayErrors.COMPANION_AUTH_FAILED });
    expect(agentEscalation.error).toMatchObject({ code: GatewayErrors.COMPANION_AUTH_FAILED });
  });

  it('restricts agent and session-integrity roles to disjoint method surfaces', async () => {
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({}),
    });
    const agent = await connect();
    const worker = await connect();
    await identifyAgent(agent, '11111111-1111-4111-8111-111111111111', 8);
    await identifySessionIntegrityWorker(worker, '11111111-1111-4111-8111-111111111111', 9);

    const entry = {
      type: 'message',
      id: 1,
      channelId: 'api:test',
      role: 'user',
      content: 'hello',
      timestamp: 1_000,
    };
    const agentSigning = await invokeRpc(agent, 10, 'session.hmac.sign', {
      entry,
      previousHmac: null,
    });
    const workerProvider = await invokeRpc(worker, 11, 'llm.embed', { texts: ['x'] });
    const workerCompanionSend = await invokeRpc(worker, 12, 'companion.message.send', {
      channelId: 'companion-room:test',
      content: 'should not route',
    });
    const workerSigning = await invokeRpc(worker, 13, 'session.hmac.sign', {
      entry,
      previousHmac: null,
    });

    expect(agentSigning.error).toMatchObject({ code: GatewayErrors.CONNECTION_ROLE_DENIED });
    expect(workerProvider.error).toMatchObject({ code: GatewayErrors.CONNECTION_ROLE_DENIED });
    expect(workerCompanionSend.error).toMatchObject({ code: GatewayErrors.CONNECTION_ROLE_DENIED });
    expect(workerSigning.result.entry._hmac).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('returns only the configured redacted credential-presence snapshot to an agent', async () => {
    const credentialPresence = {
      discordToken: true,
      apiKey: false,
      adminToken: true,
      openrouterApiKey: false,
      litellmBaseUrl: true,
      litellmApiKey: true,
      importProcessingLocalApiKey: false,
      falApiKey: true,
      telegramBotToken: false,
    };
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({}),
      credentialPresence,
    });
    const agent = await connect();
    await identifyAgent(agent, '11111111-1111-4111-8111-111111111111', 14);

    const response = await invokeRpc(agent, 15, 'runtime.credential_presence', {});

    expect(response.result).toEqual(credentialPresence);
    expect(Object.values(response.result).every(value => typeof value === 'boolean')).toBe(true);
  });

  it('rejects a duplicate companionId identify without evicting the first connection', async () => {
    const auditAppend = vi.fn(async () => 7);
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      auditStore: createMockAuditStore({ append: auditAppend }),
      multiCompanion: multiCompanion({ discord: '11111111-1111-4111-8111-111111111111' }),
    });
    const connA = await connect();
    const connB = await connect();

    const first = await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);
    expect(first.result).toMatchObject({ success: true, companionId: '11111111-1111-4111-8111-111111111111' });

    const second = await identifyAgent(connB, '11111111-1111-4111-8111-111111111111', 2);
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

    await identifyAgent(conn, '11111111-1111-4111-8111-111111111111', 1);
    const rebind = await identifyAgent(conn, '22222222-2222-4222-8222-222222222222', 2);
    expect(rebind.error).toBeDefined();
    expect(rebind.error.message).toContain('cannot change role or companion identity');
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

  it('scopes exact LLM cancellation, disconnect cleanup, and stop cleanup to owning connections', async () => {
    const providerSignals: AbortSignal[] = [];
    const complete = vi.fn(async (
      _context: unknown,
      _purpose: unknown,
      options?: { signal?: AbortSignal },
    ) => {
      const signal = options?.signal;
      if (!signal) throw new Error('test expected a cancellable provider signal');
      providerSignals.push(signal);
      if (signal.aborted) throw signal.reason;
      return await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      llmProvider: {
        stream: vi.fn(),
        complete,
      } as any,
      multiCompanion: multiCompanion({}),
    });
    const connA = await connect();
    const connB = await connect();
    const companionA = '11111111-1111-4111-8111-111111111111';
    const companionB = '22222222-2222-4222-8222-222222222222';
    await identifyAgent(connA, companionA, 1);
    await identifyAgent(connB, companionB, 2);

    const sharedCancellationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const startCompletion = (
      conn: MockConnection,
      id: number,
      companionId: string,
      cancellationId: string,
    ): void => {
      conn._emit({
        jsonrpc: '2.0',
        id,
        method: 'llm.complete',
        params: {
          companionId,
          cancellationId,
          model: '',
          provider: '',
          messages: [{ role: 'user', content: 'work' }],
          systemPrompt: 'system',
          purpose: 'background',
        },
      });
    };

    startCompletion(connA, 10, companionA, sharedCancellationId);
    await vi.waitFor(() => expect(providerSignals).toHaveLength(1));
    startCompletion(connB, 11, companionB, sharedCancellationId);
    await vi.waitFor(() => expect(providerSignals).toHaveLength(2));

    const unidentified = await connect();
    unidentified._emit({
      jsonrpc: '2.0',
      method: 'llm.cancel',
      params: { cancellationId: sharedCancellationId },
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(providerSignals[0].aborted).toBe(false);
    expect(providerSignals[1].aborted).toBe(false);

    expect((await invokeRpc(connA, 12, 'llm.cancel', {
      companionId: companionA,
      cancellationId: sharedCancellationId,
    })).result).toEqual({ cancelled: true });
    expect(providerSignals[0].aborted).toBe(true);
    expect(providerSignals[1].aborted).toBe(false);
    expect((await invokeRpc(connA, 13, 'llm.cancel', {
      companionId: companionA,
      cancellationId: sharedCancellationId,
    })).result).toEqual({ cancelled: false });

    startCompletion(
      connA,
      14,
      companionA,
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    );
    await vi.waitFor(() => expect(providerSignals).toHaveLength(3));
    connA._emitClose();
    await vi.waitFor(() => expect(providerSignals[2].aborted).toBe(true));
    expect(providerSignals[1].aborted).toBe(false);

    await server.stop();
    expect(providerSignals[1].aborted).toBe(true);
  });

  it.each([
    [
      'llm.complete',
      {
        model: '',
        provider: '',
        messages: [{ role: 'user', content: 'work' }],
        systemPrompt: 'system',
        purpose: 'background',
      },
    ],
    [
      'llm.chat',
      {
        requestId: 'late-chat',
        model: '',
        provider: '',
        messages: [{ role: 'user', content: 'work' }],
        systemPrompt: 'system',
        stream: true,
      },
    ],
  ])('audits cancelled %s as failed when its provider ignores abort and resolves late', async (
    method,
    params,
  ) => {
    let releaseProvider!: (response: {
      content: string;
      toolCalls: [];
      model: string;
      inputTokens: number;
      outputTokens: number;
      stopReason: string;
    }) => void;
    const lateProvider = new Promise<{
      content: string;
      toolCalls: [];
      model: string;
      inputTokens: number;
      outputTokens: number;
      stopReason: string;
    }>(resolve => {
      releaseProvider = resolve;
    });
    const providerStarted = vi.fn();
    const lateOperation = vi.fn(async () => {
      providerStarted();
      // Deliberately ignore the supplied signal and resolve after cancellation.
      return await lateProvider;
    });
    const auditAppend = vi.fn(async () => 71);
    const auditComplete = vi.fn(async () => undefined);
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      llmProvider: {
        stream: method === 'llm.chat' ? lateOperation : vi.fn(),
        complete: method === 'llm.complete' ? lateOperation : vi.fn(),
      } as any,
      auditStore: createMockAuditStore({
        append: auditAppend,
        complete: auditComplete,
      }),
      multiCompanion: multiCompanion({}),
    });
    const conn = await connect();
    const companionId = '11111111-1111-4111-8111-111111111111';
    await identifyAgent(conn, companionId, 1);
    auditAppend.mockClear();
    auditComplete.mockClear();
    const cancellationId = method === 'llm.chat'
      ? 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
      : 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

    const pending = invokeRpc(conn, 10, method, {
      ...params,
      companionId,
      cancellationId,
    });
    await vi.waitFor(() => expect(providerStarted).toHaveBeenCalledOnce());
    expect((await invokeRpc(conn, 11, 'llm.cancel', {
      companionId,
      cancellationId,
    })).result).toEqual({ cancelled: true });
    expect((await pending).error?.message).toContain('cancelled by its owning connection');
    expect(auditComplete).not.toHaveBeenCalled();

    releaseProvider({
      content: 'late result',
      toolCalls: [],
      model: 'late-model',
      inputTokens: 12,
      outputTokens: 4,
      stopReason: 'stop',
    });
    await vi.waitFor(() => expect(auditComplete).toHaveBeenCalledOnce());

    expect(auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      method,
      decision: 'ALLOW',
    }));
    expect(auditComplete).toHaveBeenCalledWith(
      71,
      expect.any(Number),
      expect.stringContaining('cancelled by its owning connection'),
    );
    await server.stop();
  });

  it('disconnects a connection whose request claims another companion identity', async () => {
    const auditAppend = vi.fn(async () => 9);
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      auditStore: createMockAuditStore({ append: auditAppend }),
      multiCompanion: multiCompanion({}),
    });
    const conn = await connect();
    await identifyAgent(conn, '11111111-1111-4111-8111-111111111111', 1);

    conn._emit({
      jsonrpc: '2.0',
      id: 6,
      method: 'llm.complete',
      params: { companionId: '22222222-2222-4222-8222-222222222222' },
    });
    await new Promise(r => setTimeout(r, 20));

    expect(conn.conn.destroyed).toBe(true);
    expect(auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      method: 'gateway.companion.identity_mismatch',
      decision: 'DENY',
      params: expect.objectContaining({
        boundCompanionId: '11111111-1111-4111-8111-111111111111',
        claimedCompanionId: '22222222-2222-4222-8222-222222222222',
      }),
    }));
    await expect(server.requestAgent('test', {})).rejects.toThrow();
  });

  it.each([
    ['blank', '   '],
    ['null', null],
    ['number', 42],
    ['invalid format', 'comp:a'],
  ])('disconnects and audits a present-but-%s per-frame companionId', async (_label, claim) => {
    const auditAppend = vi.fn(async () => 10);
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      auditStore: createMockAuditStore({ append: auditAppend }),
      multiCompanion: multiCompanion({}),
    });
    const conn = await connect();
    await identifyAgent(conn, '11111111-1111-4111-8111-111111111111', 1);

    conn._emit({
      jsonrpc: '2.0',
      id: 7,
      method: 'llm.complete',
      params: { companionId: claim },
    });
    await new Promise(r => setTimeout(r, 20));

    expect(conn.conn.destroyed).toBe(true);
    expect(auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      method: 'gateway.companion.identity_claim_invalid',
      decision: 'DENY',
      params: expect.objectContaining({ boundCompanionId: '11111111-1111-4111-8111-111111111111' }),
    }));
  });
});

describe('GatewayServer multi-companion routing (flag on)', () => {
  it('routes confirmation queue invalidations only to the authenticated companion', async () => {
    const eventBus = new EventBus();
    const { connect } = await setupServer({
      ...createMinimalOptions(),
      eventBus,
      capabilityTierProvider: () => 'apprentice',
      multiCompanion: multiCompanion({}),
    });
    const connA = await connect();
    const connB = await connect();
    await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);
    await identifyAgent(connB, '22222222-2222-4222-8222-222222222222', 2);

    const queued = await invokeRpc(connA, 3, 'fs.write', {
      path: '/tmp/11111111-1111-4111-8111-111111111111-needs-approval.txt',
      content: 'held',
    });

    expect(queued.error.code).toBe(GatewayErrors.NEEDS_APPROVAL);
    expect(methodFrames(connA, 'garden.queue.changed')).toEqual([
      expect.objectContaining({ params: { queue: 'confirmations' } }),
    ]);
    expect(methodFrames(connB, 'garden.queue.changed')).toHaveLength(0);
  });

  it('exposes reviewed shared artifacts read-only to authenticated companions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-shared-reader-'));
    mkdirSync(join(root, 'artifacts', 'world'), { recursive: true });
    mkdirSync(join(root, 'artifacts', 'private'), { recursive: true });
    mkdirSync(join(root, 'reviews'), { recursive: true });
    mkdirSync(join(root, 'provenance', 'events'), { recursive: true });
    const reviewedContent = '# Reviewed guide\n';
    const reviewedRevision = createHash('sha256').update(reviewedContent).digest('hex');
    const reviewId = '11111111-1111-4111-8111-111111111111';
    writeFileSync(join(root, 'artifacts', 'world', 'guide.md'), reviewedContent);
    writeFileSync(join(root, 'artifacts', 'private', 'pending.md'), 'not reviewed');
    writeFileSync(join(root, 'reviews', `${reviewId}.json`), JSON.stringify({
      reviewId,
      artifactPath: 'world/guide.md',
      proposedRevision: reviewedRevision,
      status: 'approved',
    }));
    writeFileSync(join(root, 'provenance', 'events', `${reviewId}.approved.json`), JSON.stringify({
      schemaVersion: 1,
      event: 'approved',
      at: '2026-07-13T00:00:00.000Z',
      reviewId,
      artifactPath: 'world/guide.md',
      proposedRevision: reviewedRevision,
    }));
    writeFileSync(join(root, 'reviews', 'pending.json'), JSON.stringify({
      artifactPath: 'private/pending.md',
      status: 'pending',
      content: 'not reviewed',
    }));
    try {
      const config = multiCompanion({});
      config.sharedWorkspacePath = root;
      const { connect } = await setupServer({
        ...createMinimalOptions(),
        multiCompanion: config,
      });
      const connA = await connect();
      const connB = await connect();
      await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);
      await identifyAgent(connB, '22222222-2222-4222-8222-222222222222', 2);

      const listA = await invokeRpc(connA, 3, 'shared.workspace.list', {});
      const listB = await invokeRpc(connB, 4, 'shared.workspace.list', {});
      expect(listA.result.artifacts).toEqual([
        expect.objectContaining({ artifactPath: 'world/guide.md' }),
      ]);
      expect(listB.result).toEqual(listA.result);
      expect(JSON.stringify(listA.result)).not.toContain('pending.md');

      const read = await invokeRpc(connA, 5, 'shared.workspace.read', {
        artifactPath: 'world/guide.md',
      });
      expect(read.result.content).toBe('# Reviewed guide\n');

      const traversal = await invokeRpc(connB, 6, 'shared.workspace.read', {
        artifactPath: '../reviews/pending.json',
      });
      expect(traversal.error).toBeDefined();
      const identityClaim = await invokeRpc(connB, 7, 'shared.workspace.read', {
        artifactPath: 'world/guide.md',
        companionId: '22222222-2222-4222-8222-222222222222',
      });
      expect(identityClaim.error.message).toContain('identity assertions are forbidden');
      const write = await invokeRpc(connA, 8, 'shared.workspace.write', {
        artifactPath: 'world/guide.md',
        content: 'changed',
      });
      expect(write.error).toBeDefined();

      writeFileSync(join(root, 'artifacts', 'world', 'guide.md'), 'unreviewed mutation\n');
      const tamperedList = await invokeRpc(connA, 9, 'shared.workspace.list', {});
      expect(tamperedList.error.message).toContain('no longer matches its approved revision');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('delivers inbound channel messages to exactly the routed companion', async () => {
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({ discord: '11111111-1111-4111-8111-111111111111' }),
    });
    const connA = await connect();
    const connB = await connect();
    await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);
    await identifyAgent(connB, '22222222-2222-4222-8222-222222222222', 2);

    server.notifyChannelMessage('discord', 'discord.message', { message: { id: 'm1' } });

    expect(methodFrames(connA, 'discord.message')).toHaveLength(1);
    expect(methodFrames(connB, 'discord.message')).toHaveLength(0);
  });

  it('fails closed for unrouted channel surfaces and audits the violation', async () => {
    const auditAppend = vi.fn(async () => 11);
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      auditStore: createMockAuditStore({ append: auditAppend }),
      multiCompanion: multiCompanion({ discord: '11111111-1111-4111-8111-111111111111' }),
    });
    const connA = await connect();
    await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);

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
      multiCompanion: multiCompanion({ discord: '11111111-1111-4111-8111-111111111111' }),
    });
    const connA = await connect();
    await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);

    await expect(server.requestAgentVoiceStream(makeChannelMessage('terminal')))
      .rejects.toThrow('cannot map channelType "terminal"');
  });

  it('routes requestAgent (api surface) to the api companion, not the first ready agent', async () => {
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({ api: '22222222-2222-4222-8222-222222222222' }),
    });
    const connA = await connect();
    const connB = await connect();
    await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);
    await identifyAgent(connB, '22222222-2222-4222-8222-222222222222', 2);

    const requestPromise = server.requestAgent('api.health', {});
    await new Promise(r => setTimeout(r, 10));

    expect(methodFrames(connA, 'api.health')).toHaveLength(0);
    const requestFrame = methodFrames(connB, 'api.health')[0];
    expect(requestFrame).toBeDefined();
    connB._emit({ jsonrpc: '2.0', id: requestFrame.id, result: { ok: true } });
    await expect(requestPromise).resolves.toEqual({ ok: true });
  });

  it('routes an explicit companion authority read only to that authenticated agent', async () => {
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({ api: '22222222-2222-4222-8222-222222222222' }),
    });
    const connA = await connect();
    const connB = await connect();
    await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);
    await identifyAgent(connB, '22222222-2222-4222-8222-222222222222', 2);

    const requestPromise = server.requestCompanionAgent(
      '11111111-1111-4111-8111-111111111111',
      'contact.authority.snapshot',
      { contactId: 'contact-one', providerSubjectId: '123456789012345679' },
    );
    await new Promise(r => setTimeout(r, 10));

    expect(methodFrames(connB, 'contact.authority.snapshot')).toHaveLength(0);
    const requestFrame = methodFrames(connA, 'contact.authority.snapshot')[0];
    expect(requestFrame).toBeDefined();
    connA._emit({ jsonrpc: '2.0', id: requestFrame.id, result: null });
    await expect(requestPromise).resolves.toBeNull();
  });

  it('attributes pinned and selected chat responses to the authenticated responding connection', async () => {
    const companionA = '11111111-1111-4111-8111-111111111111';
    const companionB = '22222222-2222-4222-8222-222222222222';
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({ api: companionA }),
    });
    const connA = await connect();
    const connB = await connect();
    await identifyAgent(connA, companionA, 1);
    await identifyAgent(connB, companionB, 2);
    const runtime = new GatewayApiRuntime(server);

    const runTurn = async (
      targetCompanionId: string,
      targetConnection: MockConnection,
      stream: boolean,
    ) => {
      const onDelta = vi.fn();
      const completion = runtime.handleChatCompletion({
        request: {
          model: 'openai-compatible-placeholder',
          messages: [{ role: 'user', content: 'hello' }],
          stream,
        },
        principal: { id: 'principal', mode: 'api_key' },
        headers: {},
        companionId: targetCompanionId,
        ...(stream ? { onDelta } : {}),
      });
      await new Promise(r => setTimeout(r, 10));
      const frame = methodFrames(targetConnection, 'api.chat.completion').at(-1);
      expect(frame).toBeDefined();
      if (stream) {
        targetConnection._emit({
          jsonrpc: '2.0',
          method: 'api.stream.delta',
          params: { requestId: frame.params.requestId, text: 'delta' },
        });
      }
      targetConnection._emit({
        jsonrpc: '2.0',
        id: frame.id,
        result: {
          ok: true,
          response: {
            content: 'done',
            channelId: 'api:principal:session',
            inputTokens: 1,
            outputTokens: 1,
          },
        },
      });
      return { result: await completion, onDelta };
    };

    const pinned = await runTurn(companionA, connA, false);
    expect(pinned.result).toMatchObject({
      ok: true,
      response: { companionId: companionA },
    });
    expect(methodFrames(connB, 'api.chat.completion')).toHaveLength(0);

    const selected = await runTurn(companionB, connB, true);
    expect(selected.result).toMatchObject({
      ok: true,
      response: { companionId: companionB },
    });
    expect(selected.onDelta).toHaveBeenCalledWith('delta', companionB);
    expect(methodFrames(connA, 'api.chat.completion')).toHaveLength(1);
  });

  it('routes voice/channel streams by message channelType to exactly the routed companion', async () => {
    const routed = { messages: [] as any[] };
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({ telegram: '22222222-2222-4222-8222-222222222222' }),
    });
    const connA = await connect();
    const connB = await connect(voiceStreamResponder(routed));
    await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);
    await identifyAgent(connB, '22222222-2222-4222-8222-222222222222', 2);

    const result = await server.requestAgentVoiceStream(makeChannelMessage('telegram'));
    expect(result.content).toBe('voice response');
    expect(methodFrames(connA, 'voice.transcript.begin')).toHaveLength(0);
    expect(methodFrames(connB, 'voice.transcript.begin')).toHaveLength(1);
  });

  it('routes a shared satellite voice lease only to its Primary', async () => {
    const routed = { messages: new Array<SubstrateMessage>() };
    const auditAppend = vi.fn(async () => 1);
    const { server, connect } = await setupServer({
      ...withSharedSatelliteEligibility(createMinimalOptions()),
      auditStore: createMockAuditStore({ append: auditAppend }),
      multiCompanion: multiCompanion({ api: '11111111-1111-4111-8111-111111111111' }),
    });
    const connA = await connect();
    const connB = await connect(voiceStreamResponder(routed));
    await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);
    await identifyAgent(connB, '22222222-2222-4222-8222-222222222222', 2);
    const result = await server.requestAgentVoiceStream(
      makeSatelliteVoiceMessage('sat-app', '22222222-2222-4222-8222-222222222222'),
    );

    expect(result.content).toBe('voice response');
    expect(methodFrames(connA, 'voice.transcript.begin')).toHaveLength(0);
    expect(methodFrames(connB, 'voice.transcript.begin')).toHaveLength(1);
    expect(routed.messages[0]?.routing?.gateway?.companionId).toBe('22222222-2222-4222-8222-222222222222');
    await vi.waitFor(() => {
      expect(auditAppend).toHaveBeenCalledWith(expect.objectContaining({
        method: 'satellite.response.lease',
        decision: 'ALLOW',
      }));
    });

    await server.recordSharedSatelliteObservationAudit({
      satelliteId: 'sat-app',
      companionId: '22222222-2222-4222-8222-222222222222',
      scope: 'presence',
      eventId: 'event-1',
      timestamp: 1_000,
    });
    expect(auditAppend).toHaveBeenCalledWith({
      method: 'satellite.observation.delivered',
      decision: 'ALLOW',
      params: expect.objectContaining({ eventId: 'event-1' }),
    });
  });

  it('fails closed when multi-companion satellite voice has no shared-device policy', async () => {
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({ api: '11111111-1111-4111-8111-111111111111' }),
    });
    const connA = await connect();
    await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);
    await expect(server.requestAgentVoiceStream(makeSatelliteVoiceMessage('sat-unbound')))
      .rejects.toThrow(/satellite "sat-unbound" has no shared-device policy/i);
    expect(methodFrames(connA, 'voice.transcript.begin')).toHaveLength(0);
  });

  it('fails closed when a satellite voice source is missing authenticated satellite metadata', async () => {
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({ api: '11111111-1111-4111-8111-111111111111' }),
    });
    const connA = await connect();
    await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);
    const message = makeChannelMessage('api');
    message.routing = { source: 'satellite' };

    await expect(server.requestAgentVoiceStream(message))
      .rejects.toThrow(/requires authenticated satellite metadata/i);
    expect(methodFrames(connA, 'voice.transcript.begin')).toHaveLength(0);
  });

  it('stamps the routed companionId on wyoming-tagged api voice streams', async () => {
    const routed = { messages: [] as any[] };
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({ api: '22222222-2222-4222-8222-222222222222' }),
    });
    const connA = await connect();
    const connB = await connect(voiceStreamResponder(routed));
    await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);
    await identifyAgent(connB, '22222222-2222-4222-8222-222222222222', 2);

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

    expect(methodFrames(connA, 'voice.transcript.begin')).toHaveLength(0);
    expect(routed.messages[0]?.routing?.gateway).toEqual({
      schemaVersion: 1,
      companionId: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('fails closed when the routed companion connection is gone', async () => {
    const auditAppend = vi.fn(async () => 12);
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      auditStore: createMockAuditStore({ append: auditAppend }),
      multiCompanion: multiCompanion({ discord: '11111111-1111-4111-8111-111111111111' }),
    });
    const connA = await connect();
    const connB = await connect();
    await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);
    await identifyAgent(connB, '22222222-2222-4222-8222-222222222222', 2);

    connA._emitClose();
    await new Promise(r => setTimeout(r, 5));

    expect(() => server.notifyChannelMessage('discord', 'discord.message', { message: { id: 'm1' } }))
      .toThrow('No agent connection for companion "11111111-1111-4111-8111-111111111111"');
    expect(methodFrames(connB, 'discord.message')).toHaveLength(0);

    await new Promise(r => setTimeout(r, 10));
    expect(auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      method: 'gateway.companion.companion_not_connected',
      decision: 'DENY',
    }));
  });

  it('keeps a surface unrouted after a gateway bounce until the agent re-identifies on the new connection (imlb)', async () => {
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({ discord: '11111111-1111-4111-8111-111111111111' }),
    });
    const connA = await connect();
    await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);

    // Baseline: routing works while the agent is identified.
    server.notifyChannelMessage('discord', 'discord.message', { message: { id: 'm1' } });
    expect(methodFrames(connA, 'discord.message')).toHaveLength(1);

    // Gateway bounce: the agent's connection drops and a replacement connection
    // is established, but it has NOT re-run gateway.client.identify yet — the
    // exact post-reconnect state from the S10 field incident.
    connA._emitClose();
    await new Promise(r => setTimeout(r, 5));
    const connReplacement = await connect();

    // Surface routing (companionConnections) was cleared on close and the
    // replacement connection never re-registered its surfaces, so inbound
    // routing must fail closed rather than deliver to a stale/absent agent.
    expect(() => server.notifyChannelMessage('discord', 'discord.message', { message: { id: 'm2' } }))
      .toThrow('No agent connection for companion "11111111-1111-4111-8111-111111111111"');
    expect(methodFrames(connReplacement, 'discord.message')).toHaveLength(0);

    // Re-identify on the replacement connection is what repopulates surface
    // routing; after it, inbound routing succeeds again with no change to the
    // static channel routing. This is the contract the agent must satisfy on
    // reconnect (guaranteed by the fail-closed restart in app/agent/main.ts).
    await identifyAgent(connReplacement, '11111111-1111-4111-8111-111111111111', 3);
    server.notifyChannelMessage('discord', 'discord.message', { message: { id: 'm3' } });
    expect(methodFrames(connReplacement, 'discord.message')).toHaveLength(1);
  });

  it('drops api.stream.delta frames from connections that are not the routed api companion', async () => {
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({ api: '11111111-1111-4111-8111-111111111111' }),
    });
    const connA = await connect();
    const connB = await connect();
    await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);
    await identifyAgent(connB, '22222222-2222-4222-8222-222222222222', 2);

    const received: string[] = [];
    server.subscribeApiStream('req-1', (text) => received.push(text));

    connB._emit({
      jsonrpc: '2.0',
      method: 'api.stream.delta',
      params: { requestId: 'req-1', text: 'stolen', companionId: '22222222-2222-4222-8222-222222222222' },
    });
    await new Promise(r => setTimeout(r, 10));
    expect(received).toEqual([]);

    connA._emit({
      jsonrpc: '2.0',
      method: 'api.stream.delta',
      params: { requestId: 'req-1', text: 'legit', companionId: '11111111-1111-4111-8111-111111111111' },
    });
    await new Promise(r => setTimeout(r, 10));
    expect(received).toEqual(['legit']);
  });

  it('accepts selected-companion stream deltas only from the request-bound companion', async () => {
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({ api: '11111111-1111-4111-8111-111111111111' }),
    });
    const connA = await connect();
    const connB = await connect();
    await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);
    await identifyAgent(connB, '22222222-2222-4222-8222-222222222222', 2);

    const received: string[] = [];
    server.subscribeApiStream(
      'req-selected',
      (text) => received.push(text),
      '22222222-2222-4222-8222-222222222222',
    );

    connA._emit({
      jsonrpc: '2.0',
      method: 'api.stream.delta',
      params: { requestId: 'req-selected', text: 'wrong responder' },
    });
    connB._emit({
      jsonrpc: '2.0',
      method: 'api.stream.delta',
      params: { requestId: 'req-selected', text: 'selected responder' },
    });
    await new Promise(r => setTimeout(r, 10));

    expect(received).toEqual(['selected responder']);
  });
});

describe('GatewayServer multi-account discord routing (flag on, W1-P2)', () => {
  function createAccountDock(id: string): {
    dock: any;
    sendText: ReturnType<typeof vi.fn>;
    sendMedia: ReturnType<typeof vi.fn>;
  } {
    const sendText = vi.fn(async () => undefined);
    const sendMedia = vi.fn(async () => undefined);
    return {
      dock: {
        id,
        outbound: { textChunkLimit: 2000, sendText, sendMedia },
      },
      sendText,
      sendMedia,
    };
  }

  function createMultiAccountOptions(): {
    options: GatewayServerOptions;
    dockA: ReturnType<typeof createAccountDock>;
    dockB: ReturnType<typeof createAccountDock>;
  } {
    const dockA = createAccountDock('discord:acct-a');
    const dockB = createAccountDock('discord:acct-b');
    const options: GatewayServerOptions = {
      ...createMinimalOptions(),
      discordAccountDocks: new Map([
        ['11111111-1111-4111-8111-111111111111', dockA.dock],
        ['22222222-2222-4222-8222-222222222222', dockB.dock],
      ]),
      multiCompanion: multiCompanion({}, { 'acct-a': '11111111-1111-4111-8111-111111111111', 'acct-b': '22222222-2222-4222-8222-222222222222' }),
    };
    return { options, dockA, dockB };
  }

  it('fails closed at construction when a routed companion has no outbound dock', () => {
    expect(() => new GatewayServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({}, { 'acct-a': '11111111-1111-4111-8111-111111111111' }),
    })).toThrow(/missing docks for: 11111111-1111-4111-8111-111111111111/);
  });

  it('delivers inbound account messages to exactly the routed companion per account', async () => {
    const { options } = createMultiAccountOptions();
    const { server, connect } = await setupServer(options);
    const connA = await connect();
    const connB = await connect();
    await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);
    await identifyAgent(connB, '22222222-2222-4222-8222-222222222222', 2);

    expect(server.notifyChannelMessage(
      'discord',
      'discord.message',
      { message: { id: 'm-a' } },
      'acct-a',
    )).toBe(1);
    expect(server.notifyChannelMessage(
      'discord',
      'discord.message',
      { message: { id: 'm-b' } },
      'acct-b',
    )).toBe(1);

    const aFrames = methodFrames(connA, 'discord.message');
    const bFrames = methodFrames(connB, 'discord.message');
    expect(aFrames).toHaveLength(1);
    expect(aFrames[0].params.message.id).toBe('m-a');
    expect(bFrames).toHaveLength(1);
    expect(bFrames[0].params.message.id).toBe('m-b');
  });

  it('reports zero when the exact routed companion rejects the frame without rerouting', async () => {
    const { options } = createMultiAccountOptions();
    const { server, connect } = await setupServer(options);
    const connA = await connect();
    const connB = await connect();
    await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);
    await identifyAgent(connB, '22222222-2222-4222-8222-222222222222', 2);
    const rejectedSend = vi.spyOn(connA.conn, 'send').mockReturnValue(false);

    expect(server.notifyChannelMessage(
      'discord',
      'discord.message',
      { message: { id: 'm-rejected' } },
      'acct-a',
    )).toBe(0);
    expect(rejectedSend).toHaveBeenCalledWith(expect.objectContaining({
      method: 'discord.message',
      params: { message: { id: 'm-rejected' } },
    }));
    expect(methodFrames(connB, 'discord.message')).toHaveLength(0);
  });

  it('fails closed when the inbound discord message carries no accountId', async () => {
    const auditAppend = vi.fn(async () => 21);
    const { options } = createMultiAccountOptions();
    const { server, connect } = await setupServer({
      ...options,
      auditStore: createMockAuditStore({ append: auditAppend }),
    });
    const connA = await connect();
    await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);

    expect(() => server.notifyChannelMessage('discord', 'discord.message', { message: { id: 'm1' } }))
      .toThrow('Multi-account discord routing requires an accountId');
    expect(methodFrames(connA, 'discord.message')).toHaveLength(0);

    await new Promise(r => setTimeout(r, 10));
    expect(auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      method: 'gateway.companion.unrouted_discord_account',
      decision: 'DENY',
    }));
  });

  it('fails closed for an unknown discord accountId', async () => {
    const auditAppend = vi.fn(async () => 22);
    const { options } = createMultiAccountOptions();
    const { server, connect } = await setupServer({
      ...options,
      auditStore: createMockAuditStore({ append: auditAppend }),
    });
    const connA = await connect();
    await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);

    expect(() => server.notifyChannelMessage('discord', 'discord.message', { message: { id: 'm1' } }, 'acct-x'))
      .toThrow('no companion for discord account "acct-x"');
    expect(methodFrames(connA, 'discord.message')).toHaveLength(0);

    await new Promise(r => setTimeout(r, 10));
    expect(auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      method: 'gateway.companion.unrouted_discord_account',
      decision: 'DENY',
    }));
  });

  it('fails closed when an accountId is supplied but no account routing is configured', async () => {
    const { server, connect } = await setupServer({
      ...createMinimalOptions(),
      multiCompanion: multiCompanion({ discord: '11111111-1111-4111-8111-111111111111' }),
    });
    const connA = await connect();
    await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);

    expect(() => server.notifyChannelMessage('discord', 'discord.message', { message: { id: 'm1' } }, 'acct-a'))
      .toThrow('No discord account routing configured for account "acct-a"');
    expect(methodFrames(connA, 'discord.message')).toHaveLength(0);
  });

  it('fails closed for discord voice-stream requests, which have no per-account lane yet', async () => {
    const { options } = createMultiAccountOptions();
    const { server, connect } = await setupServer(options);
    const connA = await connect();
    await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);

    await expect(server.requestAgentVoiceStream(makeChannelMessage('discord')))
      .rejects.toThrow('Multi-account discord routing requires an accountId');
  });

  it('sends outbound discord.send through the calling companion\'s own bot account', async () => {
    const { options, dockA, dockB } = createMultiAccountOptions();
    const { connect } = await setupServer(options);
    const connA = await connect();
    const connB = await connect();
    await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);
    await identifyAgent(connB, '22222222-2222-4222-8222-222222222222', 2);

    const responseA = await invokeRpc(connA, 10, 'discord.send', {
      channelId: 'ch-1',
      content: 'from companion a',
      companionId: '11111111-1111-4111-8111-111111111111',
    });
    expect(responseA.result).toEqual({ success: true });
    const responseB = await invokeRpc(connB, 11, 'discord.send', {
      channelId: 'ch-1',
      content: 'from companion b',
      companionId: '22222222-2222-4222-8222-222222222222',
    });
    expect(responseB.result).toEqual({ success: true });

    expect(dockA.sendText).toHaveBeenCalledTimes(1);
    expect(dockA.sendText).toHaveBeenCalledWith({ channelId: 'ch-1' }, 'from companion a');
    expect(dockB.sendText).toHaveBeenCalledTimes(1);
    expect(dockB.sendText).toHaveBeenCalledWith({ channelId: 'ch-1' }, 'from companion b');
  });

  it('rejects outbound discord sends from a companion that owns no bot account', async () => {
    const auditAppend = vi.fn(async () => 23);
    const { options, dockA, dockB } = createMultiAccountOptions();
    const { connect } = await setupServer({
      ...options,
      auditStore: createMockAuditStore({ append: auditAppend }),
    });
    const connC = await connect();
    await identifyAgent(connC, '33333333-3333-4333-8333-333333333333', 1);

    const response = await invokeRpc(connC, 12, 'discord.send', {
      channelId: 'ch-1',
      content: 'stolen egress',
      companionId: '33333333-3333-4333-8333-333333333333',
    });
    expect(response.error).toBeDefined();
    expect(response.error.message).toContain('has no discord bot account');
    expect(dockA.sendText).not.toHaveBeenCalled();
    expect(dockB.sendText).not.toHaveBeenCalled();

    await new Promise(r => setTimeout(r, 10));
    expect(auditAppend).toHaveBeenCalledWith(expect.objectContaining({
      method: 'gateway.companion.discord_send_no_account',
      decision: 'DENY',
    }));
  });

  it('materializes discord.sendMedia inside the calling companion workspace and rejects a peer path', async () => {
    const { options, dockA, dockB } = createMultiAccountOptions();
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'psfn-discord-media-routing-'));
    try {
      const workspaceA = join(workspaceRoot, '11111111-1111-4111-8111-111111111111');
      const workspaceB = join(workspaceRoot, '22222222-2222-4222-8222-222222222222');
      mkdirSync(workspaceA);
      mkdirSync(workspaceB);
      const peerPath = join(workspaceA, 'peer.png');
      const ownPath = join(workspaceB, 'own.png');
      writeFileSync(peerPath, 'peer-bytes');
      writeFileSync(ownPath, 'own-bytes');
      options.multiCompanion = {
        ...options.multiCompanion!,
        personalWorkspaceByCompanionId: {
          '11111111-1111-4111-8111-111111111111': workspaceA,
          '22222222-2222-4222-8222-222222222222': workspaceB,
          '33333333-3333-4333-8333-333333333333': join(workspaceRoot, '33333333-3333-4333-8333-333333333333'),
        },
      };
      const { connect } = await setupServer(options);
      const connB = await connect();
      await identifyAgent(connB, '22222222-2222-4222-8222-222222222222', 1);

      const response = await invokeRpc(connB, 13, 'discord.sendMedia', {
        channelId: 'ch-2',
        media: {
          name: 'pic.png',
          contentType: 'image/png',
          url: 'https://example.test/pic.png',
          localPath: ownPath,
        },
        companionId: '22222222-2222-4222-8222-222222222222',
      });
      expect(response.result).toEqual({ success: true });
      expect(dockB.sendMedia).toHaveBeenCalledWith({ channelId: 'ch-2' }, {
        name: 'pic.png',
        contentType: 'image/png',
        url: 'https://example.test/pic.png',
        dataBase64: Buffer.from('own-bytes').toString('base64'),
      });

      const peerResponse = await invokeRpc(connB, 14, 'discord.sendMedia', {
        channelId: 'ch-2',
        media: {
          name: 'peer.png',
          contentType: 'image/png',
          url: 'https://example.test/peer.png',
          localPath: peerPath,
        },
        companionId: '22222222-2222-4222-8222-222222222222',
      });
      expect(peerResponse.error?.message).toMatch(/outside its authenticated root/);
      expect(dockB.sendMedia).toHaveBeenCalledTimes(1);
      expect(dockA.sendMedia).not.toHaveBeenCalled();
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('keeps flag-off outbound discord sends on the shared adapter (parity)', async () => {
    const options = createMinimalOptions();
    const sendText = vi.fn(async () => undefined);
    options.discordAdapter = {
      id: 'discord',
      outbound: { textChunkLimit: 2000, sendText },
    } as any;
    const { connect } = await setupServer(options);
    const conn = await connect();

    const response = await invokeRpc(conn, 14, 'discord.send', {
      channelId: 'ch-3',
      content: 'single mode send',
    });
    expect(response.result).toEqual({ success: true });
    expect(sendText).toHaveBeenCalledWith({ channelId: 'ch-3' }, 'single mode send');
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
      multiCompanion: multiCompanion({ discord: '11111111-1111-4111-8111-111111111111', api: '22222222-2222-4222-8222-222222222222' }),
    });
    const connA = await connect();
    const connB = await connect();
    await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 500);
    await identifyAgent(connB, '22222222-2222-4222-8222-222222222222', 500);

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
          companionId: '11111111-1111-4111-8111-111111111111',
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
          companionId: '22222222-2222-4222-8222-222222222222',
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

// an52.3: the gateway must resolve each authenticated companion's OWN capability
// tier (from that companion's capability-tier.json), not the single hydrated
// root. Wired through the real GatewayCapabilityTierResolver so this exercises
// the production per-companion resolution path, not a stub provider.
describe('GatewayServer per-companion capability tier (an52.3)', () => {
  function optionsFor(
    routing: GatewayMultiCompanionConfig,
    resolver: GatewayCapabilityTierResolver,
  ): GatewayServerOptions {
    return {
      ...createMinimalOptions(),
      // shard.backend.request only reaches the handler's tier gate when the
      // policy permits the backend command; otherwise it is DENY'd earlier.
      policyConfig: {
        workspacePath: '/workspace',
        shellExec: { enabled: true, allowlist: ['docker', 'kubectl'] },
      },
      multiCompanion: routing,
      capabilityTierProvider: companionId => resolver.resolveTier(companionId),
      capabilityGrantSnapshotProvider: companionId =>
        resolver.snapshotOwnerGrantStrict(companionId),
    };
  }

  function buildTwoCompanionTierFixture(): {
    root: string;
    options: GatewayServerOptions;
    shardParams(companionId: string, name: string): Record<string, unknown>;
  } {
    const root = mkdtempSync(join(tmpdir(), 'psfn-per-companion-tier-'));
    const dataDirA = join(root, 'companions', 'a');
    const dataDirB = join(root, 'companions', 'b');
    const baseDir = join(root, 'companions', 'gateway-root');
    const personalA = join(root, 'personal', '11111111-1111-4111-8111-111111111111');
    const personalB = join(root, 'personal', '22222222-2222-4222-8222-222222222222');
    for (const dir of [dataDirA, dataDirB, baseDir, personalA, personalB]) {
      mkdirSync(dir, { recursive: true });
    }
    // A autonomous, B apprentice — distinct capability-tier.json per companion.
    writeFileSync(join(dataDirA, 'capability-tier.json'), JSON.stringify({ tier: 'autonomous', customTokens: [] }));
    writeFileSync(join(dataDirB, 'capability-tier.json'), JSON.stringify({ tier: 'apprentice', customTokens: [] }));
    // The gateway-hydrated root deliberately differs from BOTH companions, so a
    // regression to global-tier behavior would surface as the wrong decision.
    writeFileSync(join(baseDir, 'capability-tier.json'), JSON.stringify({ tier: 'nursery', customTokens: [] }));

    const companionFleet = {
      persistenceRoot: root,
      workspacesRoot: join(root, 'workspaces'),
      sharedWorkspacePath: join(root, 'workspaces', 'shared'),
      companions: [
        {
          companionId: '11111111-1111-4111-8111-111111111111',
          companionDataDir: dataDirA,
          characterCardPath: join(dataDirA, 'companion.json'),
          postgresSchema: 'companion_a',
          personalWorkspacePath: personalA,
        },
        {
          companionId: '22222222-2222-4222-8222-222222222222',
          companionDataDir: dataDirB,
          characterCardPath: join(dataDirB, 'companion.json'),
          postgresSchema: 'companion_b',
          personalWorkspacePath: personalB,
        },
      ],
    } as unknown as ResolvedCompanionsFleetConfig;

    const resolver = new GatewayCapabilityTierResolver({
      baseRuntime: new CapabilityRuntime({ dataDir: baseDir }),
      multiCompanion: true,
      companionFleet,
    });

    const routing = multiCompanion({});
    routing.personalWorkspaceByCompanionId = {
      '11111111-1111-4111-8111-111111111111': personalA,
      '22222222-2222-4222-8222-222222222222': personalB,
      '33333333-3333-4333-8333-333333333333': join(root, 'personal', '33333333-3333-4333-8333-333333333333'),
    };

    const shardParams = (companionId: string, name: string) => {
      const snapshot = resolver.snapshotOwnerGrantStrict(companionId);
      const grant = deriveShardCapabilityGrant({
        companionId,
        tier: snapshot.tier,
        customTokens: snapshot.customTokens,
      });
      return {
        backend: 'container',
        shardId: `shard-${name}`,
        name,
        ownerVersion: grant.ownerVersion,
        grantDigest: grant.grantDigest,
      };
    };

    return { root, options: optionsFor(routing, resolver), shardParams };
  }

  it('gates shard.backend.request on each companion\'s own tier (A autonomous admitted, B apprentice denied)', async () => {
    const { root, options, shardParams } = buildTwoCompanionTierFixture();
    try {
      const { connect } = await setupServer(options);
      const connA = await connect();
      const connB = await connect();
      await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);
      await identifyAgent(connB, '22222222-2222-4222-8222-222222222222', 2);

      const aShard = await invokeRpc(connA, 3, 'shard.backend.request', shardParams('11111111-1111-4111-8111-111111111111', 'alpha'));
      expect(aShard.error).toBeUndefined();
      expect(aShard.result).toMatchObject({ backend: 'container', controller: 'gateway' });

      const bShard = await invokeRpc(connB, 4, 'shard.backend.request', shardParams('22222222-2222-4222-8222-222222222222', 'beta'));
      expect(bShard.result).toBeUndefined();
      expect(bShard.error.code).toBe(GatewayErrors.POLICY_DENIED);
      expect(bShard.error.message).toContain('autonomous');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('auto-clears autonomous approvals for A but holds apprentice B for operator approval', async () => {
    const { root, options } = buildTwoCompanionTierFixture();
    try {
      const { connect } = await setupServer(options);
      const connA = await connect();
      const connB = await connect();
      await identifyAgent(connA, '11111111-1111-4111-8111-111111111111', 1);
      await identifyAgent(connB, '22222222-2222-4222-8222-222222222222', 2);

      // A write outside the personal workspace is a NEEDS_APPROVAL policy path.
      // Autonomous A auto-clears the approval gate (its error, if any, is the
      // downstream workspace confinement — never the approval hold); apprentice
      // B must queue for operator approval, so its call is held, not executed.
      const outsidePathB = join(root, 'outside', 'b-apprentice.txt');
      mkdirSync(join(root, 'outside'), { recursive: true });

      const aWrite = await invokeRpc(connA, 3, 'fs.write', {
        path: join(root, 'outside', 'a-autonomous.txt'),
        content: 'auto-cleared',
      });
      // Autonomous auto-clear must reach the fs.write HANDLER: the error is the
      // handler's fleet Personal-Workspace confinement (POLICY_DENIED), never
      // the approval hold. A held call would surface NEEDS_APPROVAL instead.
      expect(aWrite.error.code).toBe(GatewayErrors.POLICY_DENIED);
      expect(aWrite.error.message).toContain('Personal Workspace');

      const bWrite = await invokeRpc(connB, 4, 'fs.write', { path: outsidePathB, content: 'held' });
      expect(bWrite.result).toBeUndefined();
      expect(bWrite.error.code).toBe(GatewayErrors.NEEDS_APPROVAL);
      // Apprentice write was held for approval, never executed.
      expect(existsSync(outsidePathB)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('injects the authenticated companion identity into LLM eligibility out-of-band from params', async () => {
    const { root, options } = buildTwoCompanionTierFixture();
    try {
      const llmResponse = {
        content: 'ok',
        toolCalls: [],
        model: 'test-model',
        inputTokens: 1,
        outputTokens: 1,
        stopReason: 'end',
      };
      const complete = vi.fn().mockResolvedValue(llmResponse);
      const stream = vi.fn().mockResolvedValue(llmResponse);
      options.llmProvider = { complete, stream } as any;
      const { connect } = await setupServer(options);
      const connB = await connect();
      await identifyAgent(connB, '22222222-2222-4222-8222-222222222222', 1);

      const baseCompleteParams = {
        model: '',
        provider: '',
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'hello' }],
        purpose: 'background',
      };

      // (a) companionId claim omitted entirely: the identity handed to the LLM
      // eligibility path must still be the connection's authenticated companion.
      const omitted = await invokeRpc(connB, 2, 'llm.complete', baseCompleteParams);
      expect(omitted.error).toBeUndefined();
      expect(complete).toHaveBeenCalledTimes(1);
      expect(complete.mock.calls[0][2]).toMatchObject({ eligibilityCompanionId: '22222222-2222-4222-8222-222222222222' });

      // (b) claim present but telemetryVisibility companion_private (which
      // strips identity from correlation): the out-of-band id survives.
      const companionPrivate = await invokeRpc(connB, 3, 'llm.complete', {
        ...baseCompleteParams,
        companionId: '22222222-2222-4222-8222-222222222222',
        telemetryVisibility: 'companion_private',
      });
      expect(companionPrivate.error).toBeUndefined();
      expect(complete).toHaveBeenCalledTimes(2);
      expect(complete.mock.calls[1][2]).toMatchObject({ eligibilityCompanionId: '22222222-2222-4222-8222-222222222222' });

      // Streaming path (llm.chat) carries the same server-injected identity.
      const chat = await invokeRpc(connB, 4, 'llm.chat', {
        systemPrompt: 'System',
        messages: [{ role: 'user', content: 'hello' }],
      });
      expect(chat.error).toBeUndefined();
      expect(stream).toHaveBeenCalledTimes(1);
      expect(stream.mock.calls[0][2]).toMatchObject({ eligibilityCompanionId: '22222222-2222-4222-8222-222222222222' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when an authenticated companion has no resolvable tier file', async () => {
    const { root, options, shardParams } = buildTwoCompanionTierFixture();
    const boundParams = shardParams('22222222-2222-4222-8222-222222222222', 'beta');
    // Remove 22222222-2222-4222-8222-222222222222's tier file so its CapabilityRuntime construction throws.
    rmSync(join(root, 'companions', 'b', 'capability-tier.json'), { force: true });
    try {
      const { connect } = await setupServer(options);
      const connB = await connect();
      await identifyAgent(connB, '22222222-2222-4222-8222-222222222222', 1);

      const bShard = await invokeRpc(connB, 2, 'shard.backend.request', boundParams);
      expect(bShard.result).toBeUndefined();
      expect(bShard.error.code).toBe(GatewayErrors.POLICY_DENIED);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
