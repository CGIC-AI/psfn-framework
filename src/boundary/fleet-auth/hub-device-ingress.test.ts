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
  type HubDeviceHumanAttachmentPort,
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

function enrollmentAuthority() {
  return { resolve: async (input: { authenticatedConnection: AuthenticatedHubDeviceConnection }) => (
    input.authenticatedConnection
  ) };
}

function guestAttachments(): HubDeviceHumanAttachmentPort {
  return {
    attach: async input => ({
      attachmentId: 'attachment-id',
      disposition: 'guest_created',
      deviceActor: Object.freeze({
        kind: 'hub_device',
        principal: input.devicePrincipal,
        connectionId: input.connection.connectionId,
      }),
      actor: Object.freeze({ kind: 'guest', companionId: input.connection.companionId }),
      channel: Object.freeze({
        source: 'server',
        id: 'hub-device:channel-digest',
        companionId: input.connection.companionId,
      }),
    }),
    fenceDevice: async () => undefined,
  };
}

describe('GatewayHubDeviceIngressService', () => {
  it('derives enrollment only through server authority and returns sibling device and guest contexts', async () => {
    const verifyAndConsume = vi.fn(async (
      _assertion: string,
      _expected: HubDeviceAssertionExpectedBinding,
    ) => principal());
    const sessions = new InMemoryHubDeviceSessionAdmissionStore();
    const enrollmentAuthority = {
      resolve: vi.fn(async () => connection()),
    };
    const attachments: HubDeviceHumanAttachmentPort = {
      attach: vi.fn(async input => ({
        attachmentId: 'attachment-id',
        disposition: 'created',
        deviceActor: Object.freeze({
          kind: 'hub_device',
          principal: input.devicePrincipal,
          connectionId: input.connection.connectionId,
        }),
        actor: Object.freeze({ kind: 'guest', companionId: COMPANION_ID }),
        channel: Object.freeze({
          source: 'server',
          id: 'hub-device:channel-digest',
          companionId: COMPANION_ID,
        }),
      })),
      fenceDevice: vi.fn(async () => undefined),
    };
    const ingress = new GatewayHubDeviceIngressService({
      verifyAndConsume,
      enrollmentAuthority,
      attachments,
      sessions,
    });

    const result = await ingress.admit({
      assertion: 'signed-assertion',
      connection: connection({
        deviceId: 'caller-controlled-device',
        companionId: '22222222-2222-4222-8222-222222222222',
      }),
    });

    expect(enrollmentAuthority.resolve).toHaveBeenCalledWith({
      connectionId: 'connection-digest',
      authenticatedConnection: expect.objectContaining({ deviceId: 'caller-controlled-device' }),
    });
    expect(verifyAndConsume).toHaveBeenCalledWith('signed-assertion', {
      deviceId: 'office-device',
      enrollmentVersion: 7,
      enrollmentStatus: 'active',
      companionId: COMPANION_ID,
      sessionId: 'realtime:office-device:session',
      placeId: 'office',
    });
    expect(result).toMatchObject({
      devicePrincipal: serializeHubDevicePrincipal(principal()),
      sessionDisposition: 'created',
      attachment: {
        disposition: 'created',
        deviceActor: { kind: 'hub_device' },
        actor: { kind: 'guest' },
        channel: { source: 'server', companionId: COMPANION_ID },
      },
    });
    expect(result.attachment.deviceActor).not.toBe(result.attachment.actor);
    expect(attachments.attach).toHaveBeenCalledWith(expect.objectContaining({
      assertionDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      connection: connection(),
      human: { kind: 'guest' },
    }));
  });

  it('does not create a second device session for exact or concurrent assertion retries', async () => {
    const sessions = new InMemoryHubDeviceSessionAdmissionStore();
    const onCreate = vi.fn();
    sessions.onCreate(onCreate);
    const ingress = new GatewayHubDeviceIngressService({
      verifyAndConsume: async () => principal(),
      enrollmentAuthority: enrollmentAuthority(),
      attachments: guestAttachments(),
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
      enrollmentAuthority: enrollmentAuthority(),
      attachments: guestAttachments(),
      sessions,
    });
    await expect(unavailable.admit({ assertion: 'signed', connection: connection() }))
      .rejects.toThrow(/database unavailable/);
    expect(sessions.size).toBe(0);

    const mismatched = new GatewayHubDeviceIngressService({
      verifyAndConsume: async () => principal({ deviceId: 'other-device' }),
      enrollmentAuthority: enrollmentAuthority(),
      attachments: guestAttachments(),
      sessions,
    });
    await expect(mismatched.admit({ assertion: 'signed', connection: connection() }))
      .rejects.toThrow(/normalized principal.*binding/i);
    expect(sessions.size).toBe(0);
  });

  it('fences the durable device attachment when current enrollment rejects the assertion', async () => {
    const attachments = guestAttachments();
    const fenceDevice = vi.spyOn(attachments, 'fenceDevice');
    const ingress = new GatewayHubDeviceIngressService({
      verifyAndConsume: async () => { throw new Error('Hub device assertion enrollment is not active'); },
      enrollmentAuthority: enrollmentAuthority(),
      attachments,
    });

    await expect(ingress.admit({ assertion: 'revoked', connection: connection() }))
      .rejects.toThrow(/enrollment is not active/);
    expect(fenceDevice).toHaveBeenCalledWith({
      assertionDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      connectionId: 'connection-digest',
      reason: 'assertion_rejected',
    });
  });
});
