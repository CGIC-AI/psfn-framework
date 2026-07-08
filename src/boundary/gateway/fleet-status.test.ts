import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { GatewayServer, type GatewayServerOptions } from './server.js';
import type { GatewayRpcConnection } from './transport.js';
import type { SessionHmacKeyring } from '../../persistence/journals/journal-utils.js';
import type { GatewayMultiCompanionConfig } from './multi-companion.js';
import {
  FleetStatusServer,
  buildFleetStatusPayload,
  startOptionalFleetStatusServer,
  type FleetStatusPayload,
} from './fleet-status.js';

// Mock the transport module to avoid real socket operations (same harness as
// server.multi-companion.test.ts — the fleet view reads the same registry).
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

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';

type MockConnection = {
  conn: GatewayRpcConnection;
  sent: unknown[];
  _emit(message: unknown): void;
  _emitClose(): void;
};

function createMockConnection(): MockConnection {
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

function createMinimalOptions(
  multiCompanion?: GatewayMultiCompanionConfig,
): GatewayServerOptions {
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
    wyomingShardRouting: { enabled: false },
    ...(multiCompanion ? { multiCompanion } : {}),
  };
}

async function setupServer(options: GatewayServerOptions): Promise<{
  server: GatewayServer;
  connect: () => Promise<MockConnection>;
}> {
  const server = new GatewayServer(options);
  let onConnectionCb: ((conn: GatewayRpcConnection) => void) | null = null;
  mockedCreateSocketServer.mockImplementation((_path, cb) => {
    onConnectionCb = cb;
    // close must invoke its callback so `await server.stop()` resolves.
    return { close: vi.fn((done?: () => void) => done?.()), listen: vi.fn() } as any;
  });
  server.start();
  return {
    server,
    connect: async () => {
      const conn = createMockConnection();
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

async function identifyAgent(conn: MockConnection, companionId: string, rpcId = 900): Promise<any> {
  return await invokeRpc(conn, rpcId, 'gateway.client.identify', {
    role: 'agent',
    companionId,
  });
}

function multiCompanion(
  channelRouting: GatewayMultiCompanionConfig['channelRouting'],
): GatewayMultiCompanionConfig {
  return { enabled: true, channelRouting, discordAccounts: {} };
}

async function fetchJson(port: number, path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  const text = await response.text();
  return {
    status: response.status,
    body: response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text,
  };
}

describe('GatewayServer.getFleetConnectionSnapshot', () => {
  it('reports identified companions with ready state and last-seen activity', async () => {
    const { server, connect } = await setupServer(
      createMinimalOptions(multiCompanion({ api: COMPANION_A })),
    );
    const connA = await connect();
    await identifyAgent(connA, COMPANION_A);

    const snapshot = server.getFleetConnectionSnapshot();
    expect(snapshot.connections).toHaveLength(1);
    expect(snapshot.connections[0]).toMatchObject({
      companionId: COMPANION_A,
      state: 'ready',
      health: 'healthy',
    });
    expect(snapshot.lastSeenByCompanionId[COMPANION_A]).toBeTypeOf('number');
    expect(snapshot.unattributedRecentViolationCount).toBe(0);

    await server.stop();
  });

  it('drops a companion from connections on disconnect but retains last-seen', async () => {
    const { server, connect } = await setupServer(
      createMinimalOptions(multiCompanion({ api: COMPANION_A })),
    );
    const connA = await connect();
    await identifyAgent(connA, COMPANION_A);

    connA._emitClose();
    await new Promise(r => setTimeout(r, 10));

    const snapshot = server.getFleetConnectionSnapshot();
    expect(snapshot.connections).toHaveLength(0);
    expect(snapshot.lastSeenByCompanionId[COMPANION_A]).toBeTypeOf('number');

    await server.stop();
  });

  it('counts attributed violation alarms in the recent window', async () => {
    const { server, connect } = await setupServer(
      createMinimalOptions(multiCompanion({ api: COMPANION_A })),
    );
    const connA = await connect();
    await identifyAgent(connA, COMPANION_A);
    connA._emitClose();
    await new Promise(r => setTimeout(r, 10));

    // Routing to a disconnected companion alarms companion_not_connected with
    // an attributed companionId in its details.
    expect(() => server.notifyChannelMessage('api', 'message.channel', {}))
      .toThrow(/No agent connection for companion/);

    const snapshot = server.getFleetConnectionSnapshot();
    expect(snapshot.recentViolationsByCompanionId[COMPANION_A]).toBe(1);

    await server.stop();
  });

  it('counts unattributed violation alarms separately', async () => {
    const { server } = await setupServer(
      createMinimalOptions(multiCompanion({ api: COMPANION_A })),
    );

    // Telegram surface has no routing entry: unrouted_channel carries no
    // companion attribution.
    expect(() => server.notifyChannelMessage('telegram', 'message.channel', {}))
      .toThrow(/no companion for channel surface/);

    const snapshot = server.getFleetConnectionSnapshot();
    expect(snapshot.unattributedRecentViolationCount).toBe(1);
    expect(snapshot.recentViolationsByCompanionId).toEqual({});

    await server.stop();
  });
});

describe('buildFleetStatusPayload', () => {
  it('merges the expected fleet with live connections, marking absent companions down', () => {
    const payload = buildFleetStatusPayload(
      [
        { companionId: COMPANION_A, gardenPort: 10061 },
        { companionId: COMPANION_B },
      ],
      {
        generatedAt: 1_750_000_000_000,
        connections: [{
          companionId: COMPANION_A,
          state: 'ready',
          health: 'healthy',
          stateReason: 'rpc_message_received',
          connectedAt: 1_749_999_000_000,
          lastSeenAt: 1_749_999_900_000,
        }],
        lastSeenByCompanionId: {
          [COMPANION_A]: 1_749_999_900_000,
          [COMPANION_B]: 1_749_990_000_000,
        },
        recentViolationsByCompanionId: { [COMPANION_B]: 2 },
        unattributedRecentViolationCount: 1,
        recentViolationWindowMs: 3_600_000,
      },
    );

    expect(payload.companionCount).toBe(2);
    expect(payload.upCount).toBe(1);
    expect(payload.companions[0]).toEqual({
      companionId: COMPANION_A,
      up: true,
      state: 'ready',
      health: 'healthy',
      stateReason: 'rpc_message_received',
      connectedAt: new Date(1_749_999_000_000).toISOString(),
      lastSeenAt: new Date(1_749_999_900_000).toISOString(),
      recentViolationCount: 0,
      gardenPort: 10061,
    });
    expect(payload.companions[1]).toEqual({
      companionId: COMPANION_B,
      up: false,
      state: 'down',
      lastSeenAt: new Date(1_749_990_000_000).toISOString(),
      recentViolationCount: 2,
    });
    expect(payload.unattributedRecentViolationCount).toBe(1);
  });

  it('reports a never-seen companion as down with no last-seen timestamp', () => {
    const payload = buildFleetStatusPayload(
      [{ companionId: COMPANION_A }],
      {
        generatedAt: Date.now(),
        connections: [],
        lastSeenByCompanionId: {},
        recentViolationsByCompanionId: {},
        unattributedRecentViolationCount: 0,
        recentViolationWindowMs: 3_600_000,
      },
    );
    expect(payload.companions[0].up).toBe(false);
    expect(payload.companions[0].state).toBe('down');
    expect(payload.companions[0].lastSeenAt).toBeUndefined();
  });
});

describe('FleetStatusServer', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });

  async function startFleetServer(
    server: GatewayServer,
    fleet: Parameters<typeof buildFleetStatusPayload>[0],
  ): Promise<FleetStatusServer> {
    const fleetServer = new FleetStatusServer({ port: 0, fleet, source: server });
    await fleetServer.start();
    cleanups.push(() => fleetServer.stop());
    return fleetServer;
  }

  it('serves the fleet payload and tracks up→down transitions', async () => {
    const { server, connect } = await setupServer(
      createMinimalOptions(multiCompanion({ api: COMPANION_A })),
    );
    cleanups.push(() => server.stop());
    const connA = await connect();
    await identifyAgent(connA, COMPANION_A);

    const fleetServer = await startFleetServer(server, [
      { companionId: COMPANION_A, gardenPort: 10061 },
      { companionId: COMPANION_B, gardenPort: 10062 },
    ]);
    const port = fleetServer.boundPort();

    const up = await fetchJson(port, '/fleet/status.json');
    expect(up.status).toBe(200);
    const upPayload = up.body as FleetStatusPayload;
    expect(upPayload.upCount).toBe(1);
    expect(upPayload.companions).toHaveLength(2);
    expect(upPayload.companions[0]).toMatchObject({
      companionId: COMPANION_A,
      up: true,
      state: 'ready',
      gardenPort: 10061,
    });
    expect(upPayload.companions[1]).toMatchObject({
      companionId: COMPANION_B,
      up: false,
      state: 'down',
      gardenPort: 10062,
    });

    connA._emitClose();
    await new Promise(r => setTimeout(r, 10));

    const down = await fetchJson(port, '/fleet/status.json');
    const downPayload = down.body as FleetStatusPayload;
    expect(downPayload.upCount).toBe(0);
    expect(downPayload.companions[0]).toMatchObject({
      companionId: COMPANION_A,
      up: false,
      state: 'down',
    });
    // Last-seen survives the disconnect so operators can see when it died.
    expect(downPayload.companions[0].lastSeenAt).toBeTypeOf('string');
  });

  it('serves a self-contained HTML page and rejects everything else read-only', async () => {
    const { server } = await setupServer(
      createMinimalOptions(multiCompanion({ api: COMPANION_A })),
    );
    cleanups.push(() => server.stop());
    const fleetServer = await startFleetServer(server, [{ companionId: COMPANION_A }]);
    const port = fleetServer.boundPort();

    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain('PSFN Fleet Status');
    // Self-contained: no external asset references.
    expect(html).not.toMatch(/src\s*=\s*"http/);

    const missing = await fetch(`http://127.0.0.1:${port}/api/admin/anything`);
    expect(missing.status).toBe(404);

    const mutation = await fetch(`http://127.0.0.1:${port}/fleet/status.json`, { method: 'POST' });
    expect(mutation.status).toBe(405);
  });

  it('fails closed when the port is already taken (never picks another)', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    cleanups.push(async () => { blocker.close(); });
    const takenPort = (blocker.address() as { port: number }).port;

    const { server } = await setupServer(
      createMinimalOptions(multiCompanion({ api: COMPANION_A })),
    );
    cleanups.push(() => server.stop());

    const fleetServer = new FleetStatusServer({
      port: takenPort,
      fleet: [{ companionId: COMPANION_A }],
      source: server,
    });
    await expect(fleetServer.start()).rejects.toThrow(/failed to bind 127\.0\.0\.1:.*EADDRINUSE/);
  });

  it('rejects non-loopback hosts fail-closed', async () => {
    const { server } = await setupServer(
      createMinimalOptions(multiCompanion({ api: COMPANION_A })),
    );
    cleanups.push(() => server.stop());
    expect(() => new FleetStatusServer({
      host: '0.0.0.0',
      port: 0,
      fleet: [{ companionId: COMPANION_A }],
      source: server,
    })).toThrow(/loopback/);
  });
});

describe('startOptionalFleetStatusServer (flag gating)', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });

  async function makeSource(): Promise<GatewayServer> {
    const { server } = await setupServer(
      createMinimalOptions(multiCompanion({ api: COMPANION_A })),
    );
    cleanups.push(() => server.stop());
    return server;
  }

  it('starts nothing when FLEET_STATUS_PORT is unset (flag-off parity)', async () => {
    const source = await makeSource();
    await expect(startOptionalFleetStatusServer({
      env: {},
      multiCompanion: false,
      source,
    })).resolves.toBeUndefined();
    await expect(startOptionalFleetStatusServer({
      env: {},
      multiCompanion: true,
      fleet: [{ companionId: COMPANION_A }],
      source,
    })).resolves.toBeUndefined();
  });

  it('refuses FLEET_STATUS_PORT without the multi-companion topology', async () => {
    const source = await makeSource();
    await expect(startOptionalFleetStatusServer({
      env: { FLEET_STATUS_PORT: '10070' },
      multiCompanion: false,
      source,
    })).rejects.toThrow(/PSFN_MULTI_COMPANION is not enabled/);
  });

  it('refuses an unparseable FLEET_STATUS_PORT', async () => {
    const source = await makeSource();
    await expect(startOptionalFleetStatusServer({
      env: { FLEET_STATUS_PORT: 'not-a-port' },
      multiCompanion: true,
      fleet: [{ companionId: COMPANION_A }],
      source,
    })).rejects.toThrow(/Invalid FLEET_STATUS_PORT/);
  });

  it('starts the listener when the port and topology are configured', async () => {
    const source = await makeSource();
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const probePort = (blocker.address() as { port: number }).port;
    await new Promise<void>((resolve) => blocker.close(() => resolve()));

    const fleetServer = await startOptionalFleetStatusServer({
      env: { FLEET_STATUS_PORT: String(probePort) },
      multiCompanion: true,
      fleet: [{ companionId: COMPANION_A, gardenPort: 10061 }],
      source,
    });
    expect(fleetServer).toBeDefined();
    cleanups.push(() => fleetServer!.stop());

    const { status, body } = await fetchJson(probePort, '/fleet/status.json');
    expect(status).toBe(200);
    expect((body as FleetStatusPayload).companions[0].companionId).toBe(COMPANION_A);
  });
});
