// Gateway identify admission through the real GatewayServer message path
// (mocked socket transport only): alarm names precede the rejected response,
// error messages are stable, rebind is rejected with an alarm, and concurrent
// identify requests on one connection cannot both bind (psfn-framework-kmxsf).
import { EventEmitter } from 'node:events';
import { fromAny } from '@total-typescript/shoehorn';
import { describe, expect, it, vi } from 'vitest';
import { GatewayServer, type GatewayServerOptions } from './server.js';
import { GatewayErrors } from './protocol.js';
import type { GatewayRpcConnection } from './transport.js';
import type { GatewayAuditStorePort } from './audit-port.js';
import type { SessionHmacKeyring } from '../../persistence/journals/journal-utils.js';
import { deriveCompanionAuthToken } from './companion-auth.js';
import { EventBus } from '../../shared/event-bus.js';
import { testShadowIntakeScreening } from '../../test-support/intake-screening.js';

vi.mock('./transport.js', () => ({
  createSocketServer: vi.fn(),
  createWebSocketRpcServer: vi.fn(),
}));

import { createSocketServer } from './transport.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const OUTSIDER = '44444444-4444-4444-8444-444444444444';
const KEYRING: SessionHmacKeyring = { activeVersion: 'v1', keys: { v1: 'test-session-secret' } };

interface Harness {
  server: GatewayServer;
  /** Ordered trace of alarm audit appends and error frames sent to peers. */
  trace: string[];
  connect(): TestConnection;
}

interface RpcResponse {
  id: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface TestConnection {
  sent: Array<Record<string, unknown>>;
  emit(message: unknown): void;
  close(): void;
  response(id: number): Promise<RpcResponse>;
}

function options(auditStore: GatewayAuditStorePort, multiCompanionEnabled: boolean): GatewayServerOptions {
  return {
    socketPath: '/tmp/identify-admission.sock',
    llmProvider: fromAny({ stream: vi.fn(), complete: vi.fn() }),
    embeddingService: fromAny({ embed: vi.fn(), embedBatch: vi.fn(), dims: 1024 }),
    discordAdapter: fromAny({ id: 'discord', outbound: { textChunkLimit: 2000, sendText: vi.fn() } }),
    policyConfig: { workspacePath: '/workspace' },
    sessionHmacKeyring: KEYRING,
    wyomingShardRouting: { enabled: false },
    eventBus: new EventBus(),
    approvalParentLabelProvider: companionId => `Test ${companionId}`,
    auditStore,
    intakeScreeningMode: 'shadow',
    ...(multiCompanionEnabled
      ? {
          intakeScreeningProvider: testShadowIntakeScreening,
          visionIntakeProvider: () => null,
          multiCompanion: {
            enabled: true,
            fleetCompanionIds: [A, B],
            channelRouting: {},
            discordAccounts: {},
            pluginAccounts: {},
            personalWorkspaceByCompanionId: { [A]: `/workspace/${A}`, [B]: `/workspace/${B}` },
          },
        }
      : { intakeScreening: testShadowIntakeScreening() }),
  };
}

function setup(multiCompanionEnabled = true): Harness {
  const trace: string[] = [];
  const auditStore: GatewayAuditStorePort = {
    append: vi.fn(async (entry: { method: string; decision: string }) => {
      if (entry.decision === 'DENY') trace.push(`alarm:${entry.method}`);
      return 1;
    }),
    complete: vi.fn(async () => undefined),
    recordSummary: vi.fn(async () => 1),
    createSummaryHook: vi.fn(() => async () => undefined),
    enforceRotation: vi.fn(async () => undefined),
    getRecent: vi.fn(async () => []),
    getByMethod: vi.fn(async () => []),
    getApprovalEvents: vi.fn(async () => []),
    count: vi.fn(async () => 0),
  };
  const server = new GatewayServer(options(auditStore, multiCompanionEnabled));
  let onConnection: ((conn: GatewayRpcConnection) => void) | undefined;
  vi.mocked(createSocketServer).mockImplementation((_path, cb) => {
    onConnection = cb;
    return fromAny({ close: vi.fn((done?: () => void) => done?.()), listen: vi.fn() });
  });
  server.start();

  return {
    server,
    trace,
    connect(): TestConnection {
      const emitter = new EventEmitter();
      const sent: Array<Record<string, unknown>> = [];
      let destroyed = false;
      const conn = {
        send(data: unknown): boolean {
          const frame = data as Record<string, unknown>;
          sent.push(frame);
          if ('error' in frame) trace.push(`error:${String(frame.id)}`);
          return true;
        },
        onMessage(handler: (message: unknown) => void): void { emitter.on('message', handler); },
        on(event: string, handler: (...args: unknown[]) => void): void { emitter.on(event, handler); },
        destroy(): void { destroyed = true; emitter.removeAllListeners(); },
        get destroyed(): boolean { return destroyed; },
      };
      onConnection!(conn as unknown as GatewayRpcConnection);
      return {
        sent,
        emit: message => emitter.emit('message', message),
        close: () => emitter.emit('close'),
        async response(id: number) {
          for (let attempt = 0; attempt < 200; attempt++) {
            const found = sent.find(frame => frame.id === id && ('result' in frame || 'error' in frame));
            if (found) return found as unknown as RpcResponse;
            await new Promise(resolve => setTimeout(resolve, 2));
          }
          throw new Error(`No RPC response for id ${id}`);
        },
      };
    },
  };
}

function identifyFrame(
  id: number,
  role: 'agent' | 'internal_session_integrity',
  companionId?: string,
  authToken?: string,
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method: 'gateway.client.identify',
    params: {
      role,
      ...(companionId ? { companionId } : {}),
      ...(authToken !== undefined ? { authToken } : {}),
    },
  };
}

function signedIdentify(id: number, role: 'agent' | 'internal_session_integrity', companionId: string) {
  return identifyFrame(id, role, companionId, deriveCompanionAuthToken(companionId, role, KEYRING));
}

async function rejected(
  conn: TestConnection,
  frame: Record<string, unknown>,
): Promise<{ message: string; code: number }> {
  conn.emit(frame);
  const response = await conn.response(frame.id as number);
  expect(response.error, JSON.stringify(response)).toBeDefined();
  return response.error!;
}

function expectAlarmBeforeError(harness: Harness, event: string, id: number): void {
  const alarm = harness.trace.indexOf(`alarm:gateway.companion.${event}`);
  const error = harness.trace.indexOf(`error:${id}`);
  expect(alarm, harness.trace.join(', ')).toBeGreaterThanOrEqual(0);
  expect(error, harness.trace.join(', ')).toBeGreaterThan(alarm);
}

describe('gateway identify admission (multi-companion)', () => {
  it('alarms connection_role_denied before rejecting an out-of-role method', async () => {
    const harness = setup();
    const worker = harness.connect();
    worker.emit(signedIdentify(1, 'internal_session_integrity', A));
    expect((await worker.response(1)).result).toMatchObject({ success: true, role: 'internal_session_integrity' });

    const error = await rejected(worker, { jsonrpc: '2.0', id: 2, method: 'llm.embed', params: { texts: ['x'] } });
    expect(error).toEqual({
      code: GatewayErrors.CONNECTION_ROLE_DENIED,
      message: 'Gateway role "internal_session_integrity" is not authorized for llm.embed',
    });
    expectAlarmBeforeError(harness, 'connection_role_denied', 2);
  });

  it('alarms identify_missing_companion before rejecting an identify without companionId', async () => {
    const harness = setup();
    const error = await rejected(harness.connect(), identifyFrame(3, 'agent'));
    expect(error.message).toBe('Multi-companion mode requires a companionId in gateway.client.identify');
    expectAlarmBeforeError(harness, 'identify_missing_companion', 3);
  });

  it('alarms identify_missing_companion for a flag-off session-integrity identify without companionId', async () => {
    const harness = setup(false);
    const error = await rejected(harness.connect(), identifyFrame(4, 'internal_session_integrity'));
    expect(error.message).toBe('The internal session-integrity role requires a companionId in gateway.client.identify');
    expectAlarmBeforeError(harness, 'identify_missing_companion', 4);
  });

  it('alarms identify_unknown_companion before rejecting a companion outside the fleet', async () => {
    const harness = setup();
    const error = await rejected(harness.connect(), signedIdentify(5, 'agent', OUTSIDER));
    expect(error).toEqual({
      code: GatewayErrors.COMPANION_AUTH_FAILED,
      message: `Companion ${JSON.stringify(OUTSIDER)} is not a member of the active fleet`,
    });
    expectAlarmBeforeError(harness, 'identify_unknown_companion', 5);
  });

  it('alarms identify_auth_failed before rejecting an invalid or missing token', async () => {
    const harness = setup();
    const invalid = await rejected(harness.connect(), identifyFrame(6, 'agent', A, 'v1.not-a-valid-token'));
    expect(invalid).toEqual({ code: GatewayErrors.COMPANION_AUTH_FAILED, message: 'Companion authentication failed' });
    expectAlarmBeforeError(harness, 'identify_auth_failed', 6);

    const missing = await rejected(harness.connect(), identifyFrame(7, 'agent', A));
    expect(missing).toEqual({ code: GatewayErrors.COMPANION_AUTH_FAILED, message: 'Companion authentication failed' });
    expectAlarmBeforeError(harness, 'identify_auth_failed', 7);
  });

  it('alarms identify_rebind_rejected and keeps the original binding when a bound connection re-identifies', async () => {
    const harness = setup();
    const conn = harness.connect();
    conn.emit(signedIdentify(8, 'agent', A));
    expect((await conn.response(8)).result).toEqual({ success: true, role: 'agent', companionId: A });

    const rebind = await rejected(conn, signedIdentify(9, 'agent', B));
    expect(rebind.message).toBe('Gateway connection is already identified and cannot change role or companion identity');
    expectAlarmBeforeError(harness, 'identify_rebind_rejected', 9);

    const roleChange = await rejected(conn, signedIdentify(10, 'internal_session_integrity', A));
    expect(roleChange.message).toBe('Gateway connection is already identified and cannot change role or companion identity');
    expectAlarmBeforeError(harness, 'identify_rebind_rejected', 10);

    expect(harness.server.getFleetConnectionSnapshot().connections.map(entry => entry.companionId)).toEqual([A]);
  });

  it('keeps exact idempotent re-identify successful without an alarm', async () => {
    const harness = setup();
    const conn = harness.connect();
    conn.emit(signedIdentify(11, 'agent', A));
    await conn.response(11);
    conn.emit(signedIdentify(12, 'agent', A));
    expect((await conn.response(12)).result).toEqual({ success: true, role: 'agent', companionId: A });
    expect(harness.trace.filter(entry => entry.startsWith('alarm:'))).toEqual([]);
  });

  it('rejects a second agent identify sent while the first is pending on the same connection', async () => {
    const harness = setup();
    const conn = harness.connect();
    conn.emit(signedIdentify(13, 'agent', A));
    conn.emit(signedIdentify(14, 'agent', B));
    const [first, second] = await Promise.all([conn.response(13), conn.response(14)]);

    expect(first.result).toEqual({ success: true, role: 'agent', companionId: A });
    expect(second.error).toEqual({
      code: expect.any(Number),
      message: 'Gateway connection already has an identify request in flight; concurrent identify rejected',
    });
    expectAlarmBeforeError(harness, 'identify_concurrent_rejected', 14);
    expect(harness.server.getFleetConnectionSnapshot().connections.map(entry => entry.companionId)).toEqual([A]);
  });

  it('rejects a session-integrity identify racing a pending agent identify on the same connection', async () => {
    const harness = setup();
    const conn = harness.connect();
    conn.emit(signedIdentify(15, 'agent', A));
    conn.emit(signedIdentify(16, 'internal_session_integrity', B));
    const [first, second] = await Promise.all([conn.response(15), conn.response(16)]);

    expect(first.result).toEqual({ success: true, role: 'agent', companionId: A });
    expect(second.error?.message).toBe(
      'Gateway connection already has an identify request in flight; concurrent identify rejected',
    );
    // The connection stays an agent for A: signing methods remain denied.
    const signing = await rejected(conn, {
      jsonrpc: '2.0',
      id: 17,
      method: 'session.hmac.sign',
      params: { entry: { type: 'message', id: 1 }, previousHmac: null },
    });
    expect(signing.code).toBe(GatewayErrors.CONNECTION_ROLE_DENIED);
  });

  it('does not bind a connection that closed while its identify was pending', async () => {
    const harness = setup();
    const conn = harness.connect();
    conn.emit(signedIdentify(18, 'agent', A));
    conn.close();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(harness.server.getFleetConnectionSnapshot().connections).toEqual([]);
  });
});
