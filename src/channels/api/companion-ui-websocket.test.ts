import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { parseSatelliteRegistryConfig } from '../backplane/satellite-registry.js';
import { deriveApiKeyPrincipalId } from '../backplane/http/auth.js';
import { CompanionUiWebSocketAdapter } from './companion-ui-websocket.js';

const companionId = '11111111-1111-4111-8111-111111111111';
const satelliteKey = 'satellite-key-with-more-than-sixteen-characters';
const proxyToken = 'trusted-proxy-token-with-more-than-32-characters';
const certDigest = 'a'.repeat(64);

class FakeSocket extends EventEmitter {
  destroyed = false;
  written = '';
  write(value: string): boolean {
    this.written += value;
    return true;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

class FakeWebSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent: string[] = [];
  closeArgs: unknown[] = [];
  send(value: string): void { this.sent.push(value); }
  close(...args: unknown[]): void { this.closeArgs = args; this.readyState = WebSocket.CLOSED; this.emit('close'); }
}

function request(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  const headers: IncomingMessage['headers'] = {
    host: 'fleet.example.test',
    origin: 'https://fleet.example.test',
    cookie: `__Host-psfn_session=${'s'.repeat(43)}`,
    authorization: `Bearer ${satelliteKey}`,
    'x-psfn-hub-device-assertion': 'signed-hub-assertion',
    'x-psfn-satellite-claim-type': 'hub-device',
    'x-psfn-satellite-id': 'office',
    'x-psfn-satellite-endpoint-id': 'display',
    'x-psfn-satellite-session-id': 'hub-session-1',
    'x-psfn-satellite-capabilities': 'text',
    'x-psfn-satellite-telemetry-scopes': 'status',
    'x-psfn-trusted-proxy-token': proxyToken,
    'x-psfn-client-cert-fingerprint-sha256': certDigest,
  };
  return {
    url: `/companion-ui/companions/${companionId}/ws`,
    method: 'GET',
    headers,
    rawHeaders: Object.entries(headers).flatMap(([name, value]) => [name, String(value)]),
    socket: {} as IncomingMessage['socket'],
    ...overrides,
  } as IncomingMessage;
}

function fixture() {
  const webSocket = new FakeWebSocket();
  const handleUpgrade = vi.fn((_request, _socket, _head, callback) => callback(webSocket));
  const attachment = {
    attachmentId: '22222222-2222-4222-8222-222222222222',
    disposition: 'created' as const,
    deviceActor: {
      kind: 'hub_device' as const,
      principal: {
        kind: 'hub_device' as const, issuer: 'hub', keyId: 'key', deviceId: 'display',
        enrollmentVersion: 1, enrollmentAssurance: 'device_credential' as const,
        placeId: 'office', audience: 'https://fleet.example.test', companionId,
        sessionId: 'hub-session-1', issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(), jti: 'jti-1',
      },
      connectionId: 'connection-1',
    },
    actor: {
      kind: 'human' as const, principalId: '33333333-3333-4333-8333-333333333333', companionId,
      providerSubject: { provider: 'discord' as const, subjectId: '123456789012345678' },
      contact: { bindingId: '44444444-4444-4444-8444-444444444444', contactId: 'contact-1', bindingVersion: 1 },
      operator: { grantId: '55555555-5555-4555-8555-555555555555', role: 'member' as const, grantVersion: 1 },
      session: { recordId: '66666666-6666-4666-8666-666666666666', authorityGeneration: 1, globalAuthEpoch: 1 },
    },
    channel: { source: 'server' as const, id: `hub-device:${'b'.repeat(64)}`, companionId },
  };
  const admit = vi.fn(async () => ({
    devicePrincipal: attachment.deviceActor.principal,
    sessionDisposition: 'created' as const,
    attachment,
  }));
  const adapter = new CompanionUiWebSocketAdapter({
    canonicalOrigin: 'https://fleet.example.test',
    satelliteApiKeys: [satelliteKey],
    trustedProxyClientCertToken: proxyToken,
    satelliteRegistry: parseSatelliteRegistryConfig({
      schemaVersion: 1,
      enabled: true,
      satellites: [{
        satelliteId: 'office', displayName: 'Office', mobility: 'static', placeId: 'office',
        endpoints: [{
          endpointId: 'display', displayName: 'Display', claimTypes: ['hub-device'],
          promptChannelType: 'satellite_hub',
          auth: {
            mode: 'mtls', apiKeyPrincipalIds: [deriveApiKeyPrincipalId(satelliteKey)],
            clientCertFingerprintSha256: certDigest,
          },
          defaultIdentity: {
            authorId: 'legacy', authorName: 'Legacy', canonicalContactId: 'legacy-contact', channelPrivacy: 'private',
          },
          maxCapabilities: ['text'], telemetryScopes: ['status'],
          hubDeviceEnrollment: { deviceId: 'display', enrollmentVersion: 1, enrollmentStatus: 'active' },
        }],
      }],
    }),
    hubDeviceIngress: { admit } as never,
    actionBroker: { execute: vi.fn() } as never,
    authorityPollMs: 60_000,
    createWebSocketServer: () => ({
      handleUpgrade,
      close: (callback: (error?: Error) => void) => callback(),
    }) as never,
  });
  return { adapter, admit, handleUpgrade, webSocket };
}

describe('CompanionUiWebSocketAdapter upgrade policy', () => {
  it('admits only the exact query-free same-origin path and attaches the cookie human to verified Hub authority', async () => {
    const built = fixture();
    const socket = new FakeSocket();
    expect(built.adapter.handleUpgrade(request(), socket as unknown as Duplex, Buffer.alloc(0))).toBe(true);
    await new Promise(resolve => setImmediate(resolve));
    expect(socket.destroyed, socket.written).toBe(false);
    await vi.waitFor(() => expect(built.handleUpgrade).toHaveBeenCalledOnce());
    expect(socket.destroyed).toBe(false);
    expect(built.admit).toHaveBeenCalledWith(expect.objectContaining({
      assertion: 'signed-hub-assertion',
      connection: expect.objectContaining({ companionId, deviceId: 'display', sessionId: 'hub-session-1' }),
      human: { kind: 'fleet_browser_session', sessionToken: 's'.repeat(43) },
    }));
    await built.adapter.stop();
  });

  it.each([
    ['query secret', { url: `/companion-ui/companions/${companionId}/ws?token=secret` }],
    ['wrong origin', { headers: { ...request().headers, origin: 'https://evil.example.test' } }],
    ['extra cookie', { headers: { ...request().headers, cookie: `__Host-psfn_session=${'s'.repeat(43)}; other=x` } }],
    ['non-exact cookie whitespace', { headers: { ...request().headers, cookie: ` __Host-psfn_session=${'s'.repeat(43)}` } }],
    ['subprotocol', { headers: { ...request().headers, 'sec-websocket-protocol': 'secret' } }],
    ['legacy author', { headers: { ...request().headers, 'x-psfn-author-id': 'forged' } }],
    ['caller parent capability', { headers: { ...request().headers, 'x-psfn-parent-capability': 'forged' } }],
  ])('rejects %s before WebSocket upgrade', async (_label, override) => {
    const built = fixture();
    const candidate = request(override as Partial<IncomingMessage>);
    candidate.rawHeaders = Object.entries(candidate.headers).flatMap(([name, value]) => [name, String(value)]);
    const socket = new FakeSocket();
    expect(built.adapter.handleUpgrade(candidate, socket as unknown as Duplex, Buffer.alloc(0))).toBe(true);
    await vi.waitFor(() => expect(socket.destroyed).toBe(true));
    expect(built.handleUpgrade).not.toHaveBeenCalled();
    await built.adapter.stop();
  });

  it('closes an open socket when session, enrollment, key, or device authority no longer revalidates', async () => {
    const built = fixture();
    const socket = new FakeSocket();
    built.adapter.handleUpgrade(request(), socket as unknown as Duplex, Buffer.alloc(0));
    await vi.waitFor(() => expect(built.handleUpgrade).toHaveBeenCalledOnce());
    built.admit.mockRejectedValueOnce(new Error('revoked'));
    built.webSocket.emit('message', Buffer.from(JSON.stringify({
      schemaVersion: 1,
      requestId: 'ui-request-1',
      action: 'companion.interact',
      resource: 'conversation.interact',
      body: { content: 'must not dispatch' },
    })), false);
    await vi.waitFor(() => expect(built.webSocket.readyState).toBe(WebSocket.CLOSED));
    expect(built.webSocket.closeArgs[0]).toBe(4403);
    await built.adapter.stop();
  });
});
