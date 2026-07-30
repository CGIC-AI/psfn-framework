import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { GatewayRpcConnection } from '../../boundary/gateway/transport.js';
import { GatewayServer, type GatewayServerOptions } from '../../boundary/gateway/server.js';
import { deriveCompanionAuthToken } from '../../boundary/gateway/companion-auth.js';
import {
  GatewayFleetPortalProjection,
  serializeFleetPortalProjection,
} from '../../boundary/gateway/fleet-portal-projection.js';
import { EventBus } from '../../shared/event-bus.js';
import type { SessionHmacKeyring } from '../../persistence/journals/journal-utils.js';
import {
  FLEET_POSTURE_EXPIRY_TIMEOUT_MS,
  FLEET_POSTURE_STALE_TIMEOUT_MS,
  type FleetCompanionPostureSummary,
} from '../../shared/telemetry/fleet-posture.js';

vi.mock('../../boundary/gateway/transport.js', () => ({
  createSocketServer: vi.fn(),
  createWebSocketRpcServer: vi.fn(),
}));

import { createSocketServer } from '../../boundary/gateway/transport.js';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';
const SESSION_TOKEN = 'S'.repeat(43);
const KEYRING: SessionHmacKeyring = {
  activeVersion: 'v1',
  keys: { v1: 'fleet-posture-validation-key' },
};

interface MockConnection {
  readonly conn: GatewayRpcConnection;
  readonly sent: unknown[];
  emitMessage(message: unknown): void;
  emitClose(): void;
}

function createConnection(): MockConnection {
  const emitter = new EventEmitter();
  const sent: unknown[] = [];
  let destroyed = false;
  const conn = {
    send(data: unknown): boolean {
      sent.push(data);
      return true;
    },
    sendHeartbeat(): boolean {
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
    get serializedTransportStats() {
      return {
        frameCount: 0,
        serializedBytes: 0,
        rpcCallCount: 0,
        byMethod: {},
      };
    },
  };
  return {
    conn: conn as GatewayRpcConnection,
    sent,
    emitMessage: message => emitter.emit('message', message),
    emitClose: () => emitter.emit('close'),
  };
}

function options(): GatewayServerOptions {
  return {
    socketPath: '/tmp/fleet-posture-validation.sock',
    llmProvider: {
      stream: vi.fn(),
      complete: vi.fn(),
    } as unknown as GatewayServerOptions['llmProvider'],
    embeddingService: {
      embed: vi.fn(),
      embedBatch: vi.fn(),
      dims: 1,
    },
    discordAdapter: {
      id: 'validation-discord',
      outbound: {
        textChunkLimit: 2_000,
        sendText: vi.fn(),
      },
    },
    policyConfig: { workspacePath: '/validation/workspace' },
    intakeScreeningMode: 'off',
    intakeScreeningProvider: () => null,
    visionIntakeProvider: () => null,
    sessionHmacKeyring: KEYRING,
    wyomingShardRouting: { enabled: false },
    eventBus: new EventBus(),
    approvalParentLabelProvider: companionId => `Companion ${companionId}`,
    multiCompanion: {
      enabled: true,
      fleetCompanionIds: [COMPANION_A, COMPANION_B],
      channelRouting: {},
      discordAccounts: {},
      personalWorkspaceByCompanionId: {
        [COMPANION_A]: `/validation/workspaces/${COMPANION_A}`,
        [COMPANION_B]: `/validation/workspaces/${COMPANION_B}`,
      },
    },
  };
}

async function invoke(
  connection: MockConnection,
  id: number,
  method: string,
  params: unknown,
): Promise<Record<string, unknown>> {
  connection.emitMessage({ jsonrpc: '2.0', id, method, params });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = connection.sent.find((frame: unknown) => {
      const candidate = frame as { id?: unknown; result?: unknown; error?: unknown };
      return candidate.id === id
        && (Object.hasOwn(candidate, 'result') || Object.hasOwn(candidate, 'error'));
    });
    if (response) return response as Record<string, unknown>;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Fleet posture validation RPC ${method} did not respond`);
}

async function identify(
  connection: MockConnection,
  companionId: string,
  id: number,
): Promise<void> {
  const response = await invoke(connection, id, 'gateway.client.identify', {
    role: 'agent',
    companionId,
    authToken: deriveCompanionAuthToken(companionId, 'agent', KEYRING),
  });
  expect(response.error).toBeUndefined();
  const ready = await invoke(connection, id + 10_000, 'gateway.client.ready', {});
  expect(ready.error).toBeUndefined();
}

function posture(
  updatedAt: number,
  state: FleetCompanionPostureSummary['charge']['state'],
  utilizationPercent: number,
): FleetCompanionPostureSummary {
  return {
    schemaVersion: 1,
    updatedAt,
    charge: { state, utilizationPercent },
    fatigue: {
      state: state === 'exhausted' ? 'exhausted' : 'clear',
      utilizationPercent,
    },
  };
}

function logProjection(
  event: 'connected' | 'stale' | 'expired' | 'disconnected' | 'reconnected',
  projection: Awaited<ReturnType<GatewayFleetPortalProjection['resolve']>>,
): void {
  for (const companion of projection.companions) {
    console.log(JSON.stringify({
      event,
      companionId: companion.companionId,
      connection: companion.health.agentRpc,
      posture: companion.posture.status === 'unavailable'
        ? 'unavailable'
        : {
            charge: companion.posture.charge,
            fatigue: companion.posture.fatigue,
          },
      updatedAt: companion.posture.status === 'unavailable'
        ? null
        : companion.posture.updatedAt,
      staleness: companion.posture.status,
    }));
  }
}

describe('local two-agent fleet posture runtime validation', () => {
  it('proves authenticated attribution, stale expiry, disconnect, and reconnect replacement', async () => {
    let registerConnection: ((connection: GatewayRpcConnection) => void) | undefined;
    vi.mocked(createSocketServer).mockImplementation((_path, onConnection) => {
      registerConnection = onConnection;
      return { close: vi.fn(), listen: vi.fn() } as never;
    });
    const server = new GatewayServer(options());
    server.start();
    const connect = (): MockConnection => {
      const connection = createConnection();
      registerConnection?.(connection.conn);
      return connection;
    };

    const connectionA = connect();
    const connectionB = connect();
    await identify(connectionA, COMPANION_A, 1);
    await identify(connectionB, COMPANION_B, 2);
    const updatedAt = Date.now();
    expect((await invoke(connectionA, 3, 'gateway.client.health', {
      posture: posture(updatedAt, 'pressured', 25),
    })).result).toEqual({ success: true });
    expect((await invoke(connectionB, 4, 'gateway.client.health', {
      posture: posture(updatedAt, 'exhausted', 100),
    })).result).toEqual({ success: true });

    let projectionNow = updatedAt;
    const portal = new GatewayFleetPortalProjection({
      authorizer: {
        resolve: async () => ({
          companions: [
            { companionId: COMPANION_A, gardenLinkEligible: true },
            { companionId: COMPANION_B, gardenLinkEligible: true },
          ],
        }),
      },
      fleet: [
        { companionId: COMPANION_A, displayName: 'Companion One' },
        { companionId: COMPANION_B, displayName: 'Companion Two' },
      ],
      source: server,
      now: () => new Date(projectionNow),
    });

    const connected = await portal.resolve({ sessionToken: SESSION_TOKEN });
    expect(connected.companions.map(companion => ({
      companionId: companion.companionId,
      utilization: companion.posture.status === 'unavailable'
        ? null
        : companion.posture.charge.utilizationPercent,
    }))).toEqual([
      { companionId: COMPANION_A, utilization: 25 },
      { companionId: COMPANION_B, utilization: 100 },
    ]);
    expect(JSON.parse(serializeFleetPortalProjection(connected).toString('utf8')))
      .toEqual(connected);
    logProjection('connected', connected);

    projectionNow = updatedAt + FLEET_POSTURE_STALE_TIMEOUT_MS + 1;
    const stale = await portal.resolve({ sessionToken: SESSION_TOKEN });
    expect(stale.companions.every(companion => companion.posture.status === 'stale')).toBe(true);
    logProjection('stale', stale);

    projectionNow = updatedAt + FLEET_POSTURE_EXPIRY_TIMEOUT_MS + 1;
    const expired = await portal.resolve({ sessionToken: SESSION_TOKEN });
    expect(expired.companions.every(companion => (
      companion.posture.status === 'unavailable'
    ))).toBe(true);
    logProjection('expired', expired);

    connectionB.emitClose();
    projectionNow = Date.now();
    const disconnected = await portal.resolve({ sessionToken: SESSION_TOKEN });
    expect(disconnected.companions.find(companion => (
      companion.companionId === COMPANION_B
    ))).toMatchObject({
      health: { agentRpc: 'down', adminTransport: 'unknown', channels: 'unknown' },
      posture: { status: 'unavailable' },
    });
    logProjection('disconnected', disconnected);

    const replacementB = connect();
    await identify(replacementB, COMPANION_B, 5);
    const beforeReplacement = await portal.resolve({ sessionToken: SESSION_TOKEN });
    expect(beforeReplacement.companions.find(companion => (
      companion.companionId === COMPANION_B
    ))?.posture).toEqual({ status: 'unavailable' });
    logProjection('reconnected', beforeReplacement);

    const replacementUpdatedAt = Date.now();
    await invoke(replacementB, 6, 'gateway.client.health', {
      posture: posture(replacementUpdatedAt, 'pressured', 50),
    });
    projectionNow = replacementUpdatedAt;
    const replaced = await portal.resolve({ sessionToken: SESSION_TOKEN });
    expect(replaced.companions.find(companion => (
      companion.companionId === COMPANION_B
    ))?.posture).toMatchObject({
      status: 'available',
      charge: { utilizationPercent: 50 },
    });
    logProjection('reconnected', replaced);
  });
});
