import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { TLSSocket } from 'node:tls';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { parseSatelliteRegistryConfig } from '../backplane/satellite-registry.js';
import { deriveApiKeyPrincipalId } from '../backplane/http/auth.js';
import { CompanionUiWebSocketAdapter } from './companion-ui-websocket.js';
import { EventBus } from '../../shared/event-bus.js';
import { CompanionEventRelay } from '../backplane/companion-relay/relay.js';

// Key path (psfn-framework-7oh9y): an ADMIN_TOKEN / API_KEY bearer on the
// upgrade is a complete human authority. No Hub, no device assertion, no fleet
// SSO session is required, and none may ride along.

const companionId = '11111111-1111-4111-8111-111111111111';
const adminToken = 'admin-token-with-more-than-sixteen-characters';
const apiKey = 'api-key-with-more-than-sixteen-characters-too';
const satelliteKey = 'satellite-key-with-more-than-sixteen-characters';
const origin = 'http://127.0.0.1:10183';
const CONFIGURE = Buffer.from(JSON.stringify({
  schemaVersion: 1,
  type: 'session.configure',
  eventCapabilities: ['approvals.v2'],
}));

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

function request(
  headers: Record<string, string>,
  overrides: Partial<IncomingMessage> = {},
): IncomingMessage {
  return {
    url: `/companion-ui/companions/${companionId}/ws`,
    method: 'GET',
    headers,
    rawHeaders: Object.entries(headers).flatMap(([name, value]) => [name, value]),
    socket: {} as IncomingMessage['socket'],
    ...overrides,
  } as IncomingMessage;
}

function keyRequest(bearer = adminToken, extra: Record<string, string> = {}): IncomingMessage {
  return request({
    host: '127.0.0.1:10183',
    origin,
    authorization: `Bearer ${bearer}`,
    ...extra,
  });
}

function fixture(options: { hub?: boolean; keys?: readonly string[] } = {}) {
  const eventBus = new EventBus();
  const eventRelay = new CompanionEventRelay({
    eventBus,
    defaultCompanionId: companionId,
    approvalBindingOf: () => ({ companionId }),
  });
  const webSocket = new FakeWebSocket();
  const handleUpgrade = vi.fn((_request, _socket, _head, callback) => callback(webSocket));
  const operatorExecute = vi.fn(async () => ({ content: 'operator reply' }));
  const admit = vi.fn(async () => { throw new Error('hub admission not expected'); });
  const adapter = new CompanionUiWebSocketAdapter({
    canonicalOrigin: origin,
    ...(options.hub ? {
      satelliteApiKeys: [satelliteKey],
      satelliteRegistry: parseSatelliteRegistryConfig({
        schemaVersion: 1,
        enabled: true,
        satellites: [{
          satelliteId: 'office', displayName: 'Office', mobility: 'static', placeId: 'office',
          endpoints: [{
            endpointId: 'display', displayName: 'Display', claimTypes: ['hub-device'],
            promptChannelType: 'satellite_hub',
            auth: { mode: 'api_key', apiKeyPrincipalIds: [deriveApiKeyPrincipalId(satelliteKey)] },
            defaultIdentity: {
              authorId: 'legacy', authorName: 'Legacy', canonicalContactId: 'legacy-contact', channelPrivacy: 'private',
            },
            maxCapabilities: ['text'],
            telemetryScopes: ['status'],
            hubDeviceEnrollment: { deviceId: 'display', enrollmentVersion: 1, enrollmentStatus: 'active' },
          }],
        }],
      }),
      hubDeviceIngress: { admit } as never,
      guestMode: 'explicit' as const,
    } : {}),
    operatorKeys: options.keys ?? [adminToken, apiKey],
    operatorActionBroker: { execute: operatorExecute },
    eventRelay,
    authorityPollMs: 60_000,
    createWebSocketServer: () => ({
      handleUpgrade,
      close: (callback: (error?: Error) => void) => callback(),
    }) as never,
  });
  return { adapter, admit, eventBus, handleUpgrade, operatorExecute, webSocket };
}

async function admitted(f: ReturnType<typeof fixture>, req: IncomingMessage): Promise<FakeSocket> {
  const tcp = new FakeSocket();
  expect(f.adapter.handleUpgrade(req, tcp as unknown as Duplex, Buffer.alloc(0))).toBe(true);
  await vi.waitFor(() => expect(f.handleUpgrade).toHaveBeenCalled());
  return tcp;
}

async function denied(f: ReturnType<typeof fixture>, req: IncomingMessage): Promise<FakeSocket> {
  const tcp = new FakeSocket();
  expect(f.adapter.handleUpgrade(req, tcp as unknown as Duplex, Buffer.alloc(0))).toBe(true);
  await vi.waitFor(() => expect(tcp.destroyed).toBe(true));
  expect(tcp.written.startsWith('HTTP/1.1 403')).toBe(true);
  expect(f.handleUpgrade).not.toHaveBeenCalled();
  return tcp;
}

describe('Companion UI WebSocket operator key path', () => {
  it('composes without any Hub or fleet SSO authority and pins a loopback HTTP origin', () => {
    expect(() => fixture()).not.toThrow();
    expect(() => new CompanionUiWebSocketAdapter({
      canonicalOrigin: 'http://fleet.example.test',
      operatorKeys: [adminToken],
      operatorActionBroker: { execute: vi.fn() },
      eventRelay: fixture().adapter as never,
    })).toThrow(/HTTPS origin/u);
    expect(() => new CompanionUiWebSocketAdapter({
      canonicalOrigin: origin,
      eventRelay: fixture().adapter as never,
    })).toThrow(/Satellite Hub registry authority or an operator key/u);
  });

  it.each([['ADMIN_TOKEN', adminToken], ['API_KEY', apiKey]])(
    'admits an %s bearer as the human authority and dispatches frames with its principal',
    async (_label, key) => {
      const f = fixture();
      await admitted(f, keyRequest(key));
      f.webSocket.emit('message', CONFIGURE, false);
      await vi.waitFor(() => expect(f.webSocket.sent.length).toBe(1));
      const ready = JSON.parse(f.webSocket.sent[0]!) as {
        type: string; device: { id: string }; capabilities: string[]; telemetryScopes: string[]; eventCapabilities: string[];
      };
      expect(ready.type).toBe('session.ready');
      expect(ready.device.id).toBe('operator-key');
      expect(ready.capabilities).toContain('text');
      expect(ready.capabilities).not.toContain('audio_output');
      // No STT ingress composed in this fixture: audio input is not advertised.
      expect(ready.capabilities).not.toContain('speech_to_text');
      expect(ready.telemetryScopes).toEqual(['status', 'approvals', 'artifacts', 'tool_activity', 'emotion']);
      expect(ready.eventCapabilities).toEqual(['approvals.v2']);

      const body = Buffer.from(JSON.stringify({
        schemaVersion: 1,
        requestId: 'req-1',
        action: 'companion.interact',
        resource: 'conversation.interact',
        body: { content: 'hello from the operator' },
      }));
      f.webSocket.emit('message', body, false);
      await vi.waitFor(() => expect(f.webSocket.sent.length).toBe(2));
      expect(JSON.parse(f.webSocket.sent[1]!)).toEqual({
        schemaVersion: 1, type: 'result', requestId: 'req-1', ok: true, result: { content: 'operator reply' },
      });
      expect(f.operatorExecute).toHaveBeenCalledWith(expect.objectContaining({
        companionId,
        principal: { id: deriveApiKeyPrincipalId(key), mode: 'api_key' },
        physicalCeiling: expect.objectContaining({ capabilities: expect.arrayContaining(['text']) }),
      }));
      expect(f.admit).not.toHaveBeenCalled();
      await f.adapter.stop();
    },
  );

  it('denies an unknown bearer, and denies a key that borrows cookie, Hub, or identity provenance', async () => {
    await denied(fixture(), keyRequest('not-a-configured-key-at-all-here'));
    await denied(fixture(), keyRequest(adminToken, { cookie: `__Host-psfn_session=${'s'.repeat(43)}` }));
    await denied(fixture(), keyRequest(adminToken, { 'x-psfn-hub-device-assertion': 'signed' }));
    await denied(fixture(), keyRequest(adminToken, { 'x-psfn-satellite-id': 'office' }));
    await denied(fixture(), keyRequest(adminToken, { 'x-identity-claim-author': 'someone' }));
    await denied(fixture(), request({ host: '127.0.0.1:10183', origin: 'http://evil.example.test', authorization: `Bearer ${adminToken}` }));
  });

  it('denies a satellite bearer when only the key path is composed, and admits it when the Hub path is', async () => {
    const keyOnly = fixture();
    await denied(keyOnly, keyRequest(satelliteKey));
    expect(keyOnly.admit).not.toHaveBeenCalled();

    const both = fixture({ hub: true });
    both.admit.mockImplementation(async () => { throw new Error('assertion rejected'); });
    const hubUpgrade = keyRequest(satelliteKey, {
      'x-psfn-hub-device-assertion': 'signed-hub-assertion',
      'x-psfn-satellite-claim-type': 'hub-device',
      'x-psfn-satellite-id': 'office',
      'x-psfn-satellite-endpoint-id': 'display',
      'x-psfn-satellite-session-id': 'hub-session-1',
      'x-psfn-satellite-capabilities': 'text',
      'x-psfn-satellite-telemetry-scopes': 'status',
    });
    // The Hub path insists on WSS; present a TLS socket so it reaches admission.
    (hubUpgrade as { socket: unknown }).socket = Object.create(TLSSocket.prototype) as unknown;
    await denied(both, hubUpgrade);
    // The Hub path ran (and its assertion was rejected); the key path did not
    // treat the satellite bearer as an operator.
    expect(both.admit).toHaveBeenCalled();
    expect(both.operatorExecute).not.toHaveBeenCalled();
  });

  it('rejects operator keys that collide with satellite keys', () => {
    expect(() => fixture({ hub: true, keys: [satelliteKey] })).toThrow(/distinct from satellite keys/u);
  });

  it('delivers companion relay events under the operator ceiling and refuses Hub renewals', async () => {
    const f = fixture();
    await admitted(f, keyRequest());
    f.webSocket.emit('message', CONFIGURE, false);
    await vi.waitFor(() => expect(f.webSocket.sent.length).toBe(1));
    await f.eventBus.emit('companion.approval.requested', {
      companionId,
      payload: {
        id: 'approval-1',
        title: 'web.fetch: example.test',
        requestedAt: '2026-07-17T00:00:00.000Z',
        redactedContext: 'Read documentation',
        status: 'pending',
        sourceSystem: 'tool-access',
        attribution: { parentId: companionId, parentLabel: 'Companion' },
        action: 'web.fetch',
        scope: 'example.test',
        reason: 'Read documentation',
        grantMode: { kind: 'once' },
      },
      timestamp: Date.now(),
    });
    await vi.waitFor(() => expect(f.webSocket.sent.length).toBe(2));
    expect(JSON.parse(f.webSocket.sent[1]!)).toMatchObject({
      type: 'event', event: { type: 'approval.requested' },
    });

    f.webSocket.emit('message', Buffer.from(JSON.stringify({
      schemaVersion: 1, type: 'hub.session.renew', requestId: 'renew-1', assertion: 'fresh-signed-assertion',
    })), false);
    await vi.waitFor(() => expect(f.webSocket.closeArgs[0]).toBe(4403));
    await f.adapter.stop();
  });
});
