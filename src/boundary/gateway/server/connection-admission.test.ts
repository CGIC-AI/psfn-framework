// Post-await re-verification in multi-companion agent identify
// (psfn-framework-kmxsf): state decided before awaiting pending ICP
// invalidations is re-checked afterwards, and nothing binds when it changed.
import { fromAny } from '@total-typescript/shoehorn';
import { describe, expect, it, vi } from 'vitest';
import { deriveCompanionAuthToken } from '../companion-auth.js';
import { GatewayFleetPostureCache } from '../fleet-posture-cache.js';
import type { GatewayRpcConnection } from '../transport.js';
import { GatewayConnectionAdmission } from './connection-admission.js';
import type { GatewayConnectionStatus } from './connection-status.js';

const A = '11111111-1111-4111-8111-111111111111';
const KEYRING = { activeVersion: 'v1', keys: { v1: 'test-session-secret' } };

function setup() {
  const conn = fromAny<GatewayRpcConnection, object>({ destroyed: false });
  const status: GatewayConnectionStatus = {
    role: 'unidentified',
    state: 'registering',
    stateReason: 'connected',
    health: 'healthy',
    connectedAt: 0,
    lastHealthcheckAt: 0,
    lastTransitionAt: 0,
    healthcheckStaleAfterMs: 60_000,
    runtimeReadyDeclared: false,
  };
  let releaseInvalidation!: () => void;
  const invalidationDone = new Promise<void>(resolve => { releaseInvalidation = resolve; });
  const connections = new Set([conn]);
  const connectionStatuses = new Map([[conn, status]]);
  const companionConnections = new Map<string, GatewayRpcConnection>();
  const alarm = vi.fn();
  const admission = new GatewayConnectionAdmission(fromAny({
    connections,
    connectionStatuses,
    companionConnections,
    companionLastSeen: new Map(),
    companionPostures: new GatewayFleetPostureCache<GatewayRpcConnection>(),
    fatigueFencedCompanionIds: new Set(),
    multiCompanion: { enabled: true },
    fleetCompanionIds: new Set([A]),
    sessionHmacKeyring: KEYRING,
    removeConnection: vi.fn(),
    companionDisplayLabel: (id: string) => id,
    alarmCompanionViolation: alarm,
    auditTrail: {},
    connectionLifecycle: { transitionConnectionState: vi.fn() },
    icpInvalidations: { awaitIcpInvalidationBeforeReconnect: vi.fn(() => invalidationDone) },
  }));
  const identify = () => admission.identifyConnection(conn, {
    role: 'agent',
    companionId: A,
    authToken: deriveCompanionAuthToken(A, 'agent', KEYRING),
  });
  return { conn, status, connections, connectionStatuses, companionConnections, alarm, identify, releaseInvalidation };
}

describe('GatewayConnectionAdmission identify re-verification after the ICP wait', () => {
  it('does not bind a connection that closed while identify was pending', async () => {
    const harness = setup();
    const pending = harness.identify();
    harness.status.state = 'offline';
    harness.connections.delete(harness.conn);
    harness.connectionStatuses.delete(harness.conn);
    harness.releaseInvalidation();

    await expect(pending).rejects.toThrow('Gateway connection closed while identify was pending; identify rejected');
    expect(harness.companionConnections.size).toBe(0);
    expect(harness.status.companionId).toBeUndefined();
  });

  it('alarms and rejects when the connection identity changed while identify was pending', async () => {
    const harness = setup();
    const pending = harness.identify();
    harness.status.role = 'internal_session_integrity';
    harness.status.companionId = A;
    harness.releaseInvalidation();

    await expect(pending).rejects.toThrow('Gateway connection is already identified and cannot change role or companion identity');
    expect(harness.alarm).toHaveBeenCalledWith('identify_rebind_rejected', expect.any(String), expect.objectContaining({
      boundCompanionId: A,
      boundRole: 'internal_session_integrity',
      claimedRole: 'agent',
    }));
    expect(harness.companionConnections.size).toBe(0);
  });

  it('rejects a concurrent identify and admits a later one once the first settles', async () => {
    const harness = setup();
    const first = harness.identify();
    await expect(harness.identify()).rejects.toThrow('concurrent identify rejected');
    expect(harness.alarm).toHaveBeenCalledWith('identify_concurrent_rejected', expect.any(String), { companionId: A });
    harness.releaseInvalidation();
    await expect(first).resolves.toEqual({ success: true, role: 'agent', companionId: A });
    expect(harness.companionConnections.get(A)).toBe(harness.conn);
    await expect(harness.identify()).resolves.toEqual({ success: true, role: 'agent', companionId: A });
  });
});
