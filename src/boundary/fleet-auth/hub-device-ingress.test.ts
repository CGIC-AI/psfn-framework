import { describe, expect, it, vi } from 'vitest';
import type {
  HubDeviceAssertionExpectedBinding,
  HubDevicePrincipal,
} from '../../shared/contracts/hub-device-ingress.js';
import {
  GatewayHubDeviceIngressService,
  InMemoryHubDeviceSessionAdmissionStore,
  serializeHubDevicePrincipal,
  type AuthenticatedHubDeviceConnection,
} from './hub-device-ingress.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';

function connection(overrides: Partial<AuthenticatedHubDeviceConnection> = {}): AuthenticatedHubDeviceConnection {
  return {
    connectionId: 'connection-digest',
    deviceId: 'office-device',
    enrollmentVersion: 7,
    enrollmentStatus: 'active',
    companionId: COMPANION_ID,
    sessionId: 'realtime:office-device:session',
    placeId: 'office',
    ...overrides,
  };
}

function principal(overrides: Partial<HubDevicePrincipal> = {}): HubDevicePrincipal {
  return {
    kind: 'hub_device',
    issuer: 'psfn-satellite-hub',
    keyId: 'hub-2026-07',
    deviceId: 'office-device',
    enrollmentVersion: 7,
    enrollmentAssurance: 'device_credential',
    placeId: 'office',
    audience: 'https://fleet.example.test',
    companionId: COMPANION_ID,
    sessionId: 'realtime:office-device:session',
    issuedAt: new Date('2026-07-16T12:00:00.000Z'),
    expiresAt: new Date('2026-07-16T12:00:30.000Z'),
    jti: '018f0f10-79b2-4cc7-8c99-0242ac120002',
    ...overrides,
  };
}

describe('GatewayHubDeviceIngressService', () => {
  it('derives the verifier binding only from the authenticated connection and admits a normalized device principal', async () => {
    const verifyAndConsume = vi.fn(async (
      _assertion: string,
      _expected: HubDeviceAssertionExpectedBinding,
    ) => principal());
    const sessions = new InMemoryHubDeviceSessionAdmissionStore();
    const ingress = new GatewayHubDeviceIngressService({ verifyAndConsume, sessions });

    const result = await ingress.admit({
      assertion: 'signed-assertion',
      connection: connection(),
    });

    expect(verifyAndConsume).toHaveBeenCalledWith('signed-assertion', {
      deviceId: 'office-device',
      enrollmentVersion: 7,
      enrollmentStatus: 'active',
      companionId: COMPANION_ID,
      sessionId: 'realtime:office-device:session',
      placeId: 'office',
    });
    expect(result).toEqual({
      devicePrincipal: serializeHubDevicePrincipal(principal()),
      sessionDisposition: 'created',
    });
    expect(result).not.toHaveProperty('humanPrincipal');
  });

  it('does not create a second device session for exact or concurrent assertion retries', async () => {
    const sessions = new InMemoryHubDeviceSessionAdmissionStore();
    const onCreate = vi.fn();
    sessions.onCreate(onCreate);
    const ingress = new GatewayHubDeviceIngressService({
      verifyAndConsume: async () => principal(),
      sessions,
    });

    const [first, concurrent] = await Promise.all([
      ingress.admit({ assertion: 'same', connection: connection() }),
      ingress.admit({ assertion: 'same', connection: connection() }),
    ]);
    const retry = await ingress.admit({ assertion: 'same', connection: connection() });

    expect([first.sessionDisposition, concurrent.sessionDisposition].sort()).toEqual(['created', 'retry']);
    expect(retry.sessionDisposition).toBe('retry');
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it('does not admit a session when verification fails or returns a mismatched principal', async () => {
    const sessions = new InMemoryHubDeviceSessionAdmissionStore();
    const unavailable = new GatewayHubDeviceIngressService({
      verifyAndConsume: async () => { throw new Error('postgres://secret@database unavailable'); },
      sessions,
    });
    await expect(unavailable.admit({ assertion: 'signed', connection: connection() }))
      .rejects.toThrow(/database unavailable/);
    expect(sessions.size).toBe(0);

    const mismatched = new GatewayHubDeviceIngressService({
      verifyAndConsume: async () => principal({ deviceId: 'other-device' }),
      sessions,
    });
    await expect(mismatched.admit({ assertion: 'signed', connection: connection() }))
      .rejects.toThrow(/normalized principal.*binding/i);
    expect(sessions.size).toBe(0);
  });

  it('keeps later human attachment behind a separate explicit port contract', () => {
    const source = String.raw`${GatewayHubDeviceIngressService}`;
    expect(source).not.toMatch(/humanPrincipal|contactId|providerSubject/iu);
  });
});
