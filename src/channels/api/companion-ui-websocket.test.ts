import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { parseSatelliteRegistryConfig } from '../backplane/satellite-registry.js';
import { deriveApiKeyPrincipalId } from '../backplane/http/auth.js';
import { CompanionUiWebSocketAdapter } from './companion-ui-websocket.js';
import { EventBus } from '../../shared/event-bus.js';
import { CompanionEventRelay } from '../backplane/companion-relay/relay.js';
import { encodeCompanionUiAudioChunk } from '../../shared/contracts/companion-ui-audio.js';
import type {
  CompanionUiAudioIngressCallbacks,
  CompanionUiAudioIngressSession,
} from '../../boundary/gateway/companion-ui-audio-ingress.js';
import { CompanionUiAudioOutputRelay } from '../backplane/companion-ui-audio-output-relay.js';
import type { CompanionUiAudioOutputBinding } from '../../shared/contracts/companion-ui-audio-output.js';

const companionId = '11111111-1111-4111-8111-111111111111';
const satelliteKey = 'satellite-key-with-more-than-sixteen-characters';
const proxyToken = 'trusted-proxy-token-with-more-than-32-characters';
const certDigest = 'a'.repeat(64);
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

function fixture(options: { guest?: boolean; audio?: boolean; audioOutput?: boolean } = {}) {
  const eventBus = new EventBus();
  const eventRelay = new CompanionEventRelay({
    eventBus,
    defaultCompanionId: companionId,
    approvalBindingOf: () => ({ companionId }),
  });
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
    actor: options.guest ? {
      kind: 'guest' as const,
      companionId,
    } : {
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
  const execute = vi.fn(async () => options.audio ? ({
    content: 'companion heard you',
    channelId: 'server-owned-channel',
    inputTokens: 2,
    outputTokens: 3,
  }) : ({ generation: 1, currentDeviceIsPrimary: true }));
  const guestExecute = vi.fn(async () => ({
    content: 'guest reply',
    channelId: 'server-owned-channel',
    inputTokens: 1,
    outputTokens: 2,
  }));
  const audioIngress = options.audio ? createAudioIngressHarness() : undefined;
  const screenAudioTranscript = vi.fn(async (input: { transcript: string }) => (
    input.transcript === 'hello there' ? 'screened speech' : input.transcript
  ));
  const cancelAudioInteraction = vi.fn(async () => undefined);
  const audioOutputRelay = new CompanionUiAudioOutputRelay(1_048_576);
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
          maxCapabilities: [
            'text',
            ...(options.audio ? ['audio_input' as const, 'speech_to_text' as const] : []),
            ...(options.audioOutput ? ['audio_output' as const] : []),
          ],
          telemetryScopes: ['status', 'approvals'],
          hubDeviceEnrollment: { deviceId: 'display', enrollmentVersion: 1, enrollmentStatus: 'active' },
        }],
      }],
    }),
    hubDeviceIngress: { admit } as never,
    actionBroker: { execute } as never,
    ...(audioIngress ? {
      audioIngress,
      screenAudioTranscript,
      cancelAudioInteraction,
    } : {}),
    eventRelay,
    audioOutputRelay,
    ...(options.guest ? {
      guestMode: 'explicit' as const,
      guestActionBroker: { execute: guestExecute } as never,
    } : {}),
    authorityPollMs: 60_000,
    createWebSocketServer: () => ({
      handleUpgrade,
      close: (callback: (error?: Error) => void) => callback(),
    }) as never,
  });
  return {
    adapter,
    admit,
    eventBus,
    execute,
    guestExecute,
    handleUpgrade,
    webSocket,
    audioIngress,
    screenAudioTranscript,
    cancelAudioInteraction,
    audioOutputRelay,
  };
}

function audioOutputBinding(): CompanionUiAudioOutputBinding {
  return {
    companionId,
    principalId: deriveApiKeyPrincipalId(satelliteKey),
    satelliteId: 'office',
    endpointId: 'display',
    claimType: 'hub-device',
    sessionId: 'hub-session-1',
  };
}

function createAudioIngressHarness() {
  let callbacks: CompanionUiAudioIngressCallbacks | undefined;
  const writePcm = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const cancel = vi.fn(async () => undefined);
  const session: CompanionUiAudioIngressSession = { writePcm, stop, cancel };
  const start = vi.fn(async (next: CompanionUiAudioIngressCallbacks) => {
    callbacks = next;
    return session;
  });
  return {
    start,
    writePcm,
    stop,
    cancel,
    get callbacks() { return callbacks; },
  };
}

describe('CompanionUiWebSocketAdapter upgrade policy', () => {
  it('relays exact Hub audio brackets only to a session carrying the audio_output ceiling', async () => {
    const built = fixture({ audioOutput: true });
    const candidate = request();
    candidate.headers['x-psfn-satellite-capabilities'] = 'text,audio_output';
    candidate.rawHeaders = Object.entries(candidate.headers)
      .flatMap(([name, value]) => [name, String(value)]);
    const socket = new FakeSocket();
    built.adapter.handleUpgrade(candidate, socket as unknown as Duplex, Buffer.alloc(0));
    await vi.waitFor(() => expect(built.handleUpgrade).toHaveBeenCalledOnce());
    built.webSocket.emit('message', CONFIGURE, false);
    await vi.waitFor(() => expect(built.webSocket.sent).toHaveLength(1));
    expect(JSON.parse(built.webSocket.sent[0]!)).toMatchObject({
      type: 'session.ready',
      capabilities: ['text', 'audio_output'],
    });

    built.audioOutputRelay.publish(
      { ...audioOutputBinding(), sessionId: 'different-session' },
      { type: 'audio', data: 'AQID' },
    );
    await new Promise(resolve => setImmediate(resolve));
    expect(built.webSocket.sent).toHaveLength(1);

    built.audioOutputRelay.publish(audioOutputBinding(), { type: 'text', data: 'audio-init' });
    built.audioOutputRelay.publish(audioOutputBinding(), { type: 'audio', data: 'AQID' });
    built.audioOutputRelay.publish(audioOutputBinding(), { type: 'text', data: 'audio-end' });

    await vi.waitFor(() => expect(built.webSocket.sent).toHaveLength(4));
    expect(built.webSocket.sent.slice(1).map(value => JSON.parse(value))).toEqual([
      { schemaVersion: 1, type: 'event', event: { type: 'text', data: 'audio-init' } },
      { schemaVersion: 1, type: 'event', event: { type: 'audio', data: 'AQID' } },
      { schemaVersion: 1, type: 'event', event: { type: 'text', data: 'audio-end' } },
    ]);
    await built.adapter.stop();
  });

  it('delivers zero audio frames when the server-owned session ceiling lacks audio_output', async () => {
    const built = fixture({ audioOutput: true });
    const socket = new FakeSocket();
    built.adapter.handleUpgrade(request(), socket as unknown as Duplex, Buffer.alloc(0));
    await vi.waitFor(() => expect(built.handleUpgrade).toHaveBeenCalledOnce());
    built.webSocket.emit('message', CONFIGURE, false);
    await vi.waitFor(() => expect(built.webSocket.sent).toHaveLength(1));
    expect(JSON.parse(built.webSocket.sent[0]!)).toMatchObject({ capabilities: ['text'] });

    built.audioOutputRelay.publish(audioOutputBinding(), { type: 'text', data: 'audio-init' });
    built.audioOutputRelay.publish(audioOutputBinding(), { type: 'audio', data: 'AQID' });
    built.audioOutputRelay.publish(audioOutputBinding(), { type: 'text', data: 'audio-end' });
    await new Promise(resolve => setImmediate(resolve));

    expect(built.webSocket.sent).toHaveLength(1);
    await built.adapter.stop();
  });

  it('reauthorizes Hub audio delivery and closes without a frame after authority loss', async () => {
    const built = fixture({ audioOutput: true });
    const candidate = request();
    candidate.headers['x-psfn-satellite-capabilities'] = 'text,audio_output';
    candidate.rawHeaders = Object.entries(candidate.headers)
      .flatMap(([name, value]) => [name, String(value)]);
    const socket = new FakeSocket();
    built.adapter.handleUpgrade(candidate, socket as unknown as Duplex, Buffer.alloc(0));
    await vi.waitFor(() => expect(built.handleUpgrade).toHaveBeenCalledOnce());
    built.webSocket.emit('message', CONFIGURE, false);
    await vi.waitFor(() => expect(built.webSocket.sent).toHaveLength(1));

    built.admit.mockRejectedValueOnce(new Error('authority revoked'));
    built.audioOutputRelay.publish(audioOutputBinding(), { type: 'text', data: 'audio-init' });

    await vi.waitFor(() => expect(built.webSocket.readyState).toBe(WebSocket.CLOSED));
    expect(built.webSocket.closeArgs[0]).toBe(4401);
    expect(built.webSocket.sent).toHaveLength(1);
    await built.adapter.stop();
  });

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
    built.webSocket.emit('message', CONFIGURE, false);
    await vi.waitFor(() => expect(built.webSocket.sent).toHaveLength(1));
    expect(built.webSocket.sent.map(value => JSON.parse(value))).toEqual([{
      schemaVersion: 1,
      type: 'session.ready',
      device: { id: 'display', label: 'Display' },
      place: { id: 'office', label: 'office' },
      capabilities: ['text'],
      telemetryScopes: ['status'],
      eventCapabilities: [],
    }]);
    expect(built.webSocket.sent[0]).not.toMatch(/sessionId|channelId|human|cookie|credential|assertion/u);
    await built.adapter.stop();
  });

  it('admits an explicit no-cookie guest through the authenticated Hub and uses only the guest broker', async () => {
    const built = fixture({ guest: true });
    const guestRequest = request();
    delete guestRequest.headers.cookie;
    guestRequest.rawHeaders = Object.entries(guestRequest.headers)
      .flatMap(([name, value]) => [name, String(value)]);
    const socket = new FakeSocket();
    built.adapter.handleUpgrade(guestRequest, socket as unknown as Duplex, Buffer.alloc(0));
    await vi.waitFor(() => expect(built.handleUpgrade).toHaveBeenCalledOnce());
    expect(built.admit).toHaveBeenCalledWith(expect.objectContaining({ human: { kind: 'guest' } }));
    built.webSocket.emit('message', CONFIGURE, false);
    await vi.waitFor(() => expect(built.webSocket.sent).toHaveLength(1));

    const body = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      requestId: 'guest-interact-1',
      action: 'companion.interact',
      resource: 'conversation.interact',
      body: { content: 'hello as guest' },
    }));
    built.webSocket.emit('message', body, false);
    await vi.waitFor(() => expect(built.guestExecute).toHaveBeenCalledOnce());
    expect(built.execute).not.toHaveBeenCalled();
    expect(built.guestExecute).toHaveBeenCalledWith(expect.objectContaining({
      rawBody: expect.any(Uint8Array),
      companionId,
      attachment: expect.objectContaining({ actor: { kind: 'guest', companionId } }),
    }));
    await vi.waitFor(() => expect(built.webSocket.sent).toContainEqual(expect.stringContaining('"guest reply"')));

    built.webSocket.emit('message', body, false);
    await vi.waitFor(() => expect(built.webSocket.readyState).toBe(WebSocket.CLOSED));
    expect(built.guestExecute).toHaveBeenCalledOnce();
    expect(built.webSocket.closeArgs[0]).toBe(4403);
    await built.adapter.stop();
  });

  it('negotiates and forwards complete companion-scoped approval-v2 events', async () => {
    const built = fixture();
    const candidate = request();
    candidate.headers['x-psfn-satellite-telemetry-scopes'] = 'approvals';
    candidate.rawHeaders = Object.entries(candidate.headers)
      .flatMap(([name, value]) => [name, String(value)]);
    const socket = new FakeSocket();
    built.adapter.handleUpgrade(candidate, socket as unknown as Duplex, Buffer.alloc(0));
    await vi.waitFor(() => expect(built.handleUpgrade).toHaveBeenCalledOnce());
    built.webSocket.emit('message', CONFIGURE, false);
    await vi.waitFor(() => expect(built.webSocket.sent).toHaveLength(1));
    expect(JSON.parse(built.webSocket.sent[0]!)).toMatchObject({
      type: 'session.ready',
      eventCapabilities: ['approvals.v2'],
    });

    await built.eventBus.emit('companion.approval.requested', {
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

    await vi.waitFor(() => expect(built.webSocket.sent).toHaveLength(2));
    expect(JSON.parse(built.webSocket.sent[1]!)).toEqual({
      schemaVersion: 1,
      type: 'event',
      event: {
        type: 'approval.requested',
        data: expect.objectContaining({
          id: 'approval-1',
          sourceSystem: 'tool-access',
          attribution: { parentId: companionId, parentLabel: 'Companion' },
          grantMode: { kind: 'once' },
        }),
      },
    });
    await built.adapter.stop();
  });

  it('does not expose approval events when the Hub ceiling lacks the approvals scope', async () => {
    const built = fixture();
    const socket = new FakeSocket();
    built.adapter.handleUpgrade(request(), socket as unknown as Duplex, Buffer.alloc(0));
    await vi.waitFor(() => expect(built.handleUpgrade).toHaveBeenCalledOnce());
    built.webSocket.emit('message', CONFIGURE, false);
    await vi.waitFor(() => expect(built.webSocket.sent).toHaveLength(1));

    await built.eventBus.emit('companion.approval.requested', {
      companionId,
      payload: {
        id: 'approval-hidden',
        title: 'web.fetch: example.test',
        requestedAt: '2026-07-17T00:00:00.000Z',
        redactedContext: 'Read documentation',
        status: 'pending',
        sourceSystem: 'tool-access',
        attribution: { parentId: companionId, parentLabel: 'Test Companion' },
        action: 'web.fetch',
        scope: 'example.test',
        reason: 'Read documentation',
        grantMode: { kind: 'once' },
      },
      timestamp: Date.now(),
    });
    await new Promise(resolve => setImmediate(resolve));

    expect(built.webSocket.sent).toHaveLength(1);
    expect(JSON.parse(built.webSocket.sent[0]!)).toMatchObject({
      type: 'session.ready',
      eventCapabilities: [],
    });
    await built.adapter.stop();
  });

  it('reauthorizes before each approval event and closes without delivery after revocation', async () => {
    const built = fixture();
    const candidate = request();
    candidate.headers['x-psfn-satellite-telemetry-scopes'] = 'approvals';
    candidate.rawHeaders = Object.entries(candidate.headers)
      .flatMap(([name, value]) => [name, String(value)]);
    const socket = new FakeSocket();
    built.adapter.handleUpgrade(candidate, socket as unknown as Duplex, Buffer.alloc(0));
    await vi.waitFor(() => expect(built.handleUpgrade).toHaveBeenCalledOnce());
    built.webSocket.emit('message', CONFIGURE, false);
    await vi.waitFor(() => expect(built.webSocket.sent).toHaveLength(1));

    built.admit.mockRejectedValueOnce(new Error('operator grant revoked'));
    await built.eventBus.emit('companion.approval.requested', {
      companionId,
      payload: {
        id: 'approval-revoked',
        title: 'web.fetch: example.test',
        requestedAt: '2026-07-17T00:00:00.000Z',
        redactedContext: 'Read documentation',
        status: 'pending',
        sourceSystem: 'tool-access',
        attribution: { parentId: companionId, parentLabel: 'Test Companion' },
        action: 'web.fetch',
        scope: 'example.test',
        reason: 'Read documentation',
        grantMode: { kind: 'once' },
      },
      timestamp: Date.now(),
    });

    await vi.waitFor(() => expect(built.webSocket.readyState).toBe(WebSocket.CLOSED));
    expect(built.webSocket.closeArgs[0]).toBe(4401);
    expect(built.webSocket.sent).toHaveLength(1);
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
    built.webSocket.emit('message', CONFIGURE, false);
    await vi.waitFor(() => expect(built.webSocket.sent).toHaveLength(1));
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

  it('forwards an explicit generation-bound handoff without browser device or place authority', async () => {
    const built = fixture();
    const socket = new FakeSocket();
    built.adapter.handleUpgrade(request(), socket as unknown as Duplex, Buffer.alloc(0));
    await vi.waitFor(() => expect(built.handleUpgrade).toHaveBeenCalledOnce());
    built.webSocket.emit('message', CONFIGURE, false);
    await vi.waitFor(() => expect(built.webSocket.sent).toHaveLength(1));
    const body = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      requestId: 'embodiment-handoff-1',
      action: 'embodiment.handoff',
      resource: 'embodiment.handoff',
      body: {
        expectedGeneration: 0,
        decisionId: '77777777-7777-4777-8777-777777777777',
        reason: 'user_requested',
      },
    }));
    built.webSocket.emit('message', body, false);
    await vi.waitFor(() => expect(built.execute).toHaveBeenCalledOnce());
    expect(built.execute).toHaveBeenCalledWith(expect.objectContaining({
      rawBody: expect.any(Uint8Array),
      companionId,
      attachment: expect.objectContaining({
        deviceActor: expect.objectContaining({ principal: expect.objectContaining({ deviceId: 'display' }) }),
      }),
    }));
    expect(body.toString()).not.toContain('deviceId');
    expect(body.toString()).not.toContain('placeId');
    await vi.waitFor(() => expect(built.webSocket.sent).toContainEqual(expect.stringContaining('"ok":true')));
    await built.adapter.stop();
  });

  it('binds a continuous PCM stream to socket authority and dispatches final speech as a signed audio turn', async () => {
    const built = fixture({ audio: true });
    const candidate = request();
    candidate.headers['x-psfn-satellite-capabilities'] = 'text,audio_input,speech_to_text';
    candidate.rawHeaders = Object.entries(candidate.headers)
      .flatMap(([name, value]) => [name, String(value)]);
    const socket = new FakeSocket();
    built.adapter.handleUpgrade(candidate, socket as unknown as Duplex, Buffer.alloc(0));
    await vi.waitFor(() => expect(built.handleUpgrade).toHaveBeenCalledOnce());
    built.webSocket.emit('message', CONFIGURE, false);
    await vi.waitFor(() => expect(built.webSocket.sent).toHaveLength(1));
    expect(JSON.parse(built.webSocket.sent[0]!)).toMatchObject({
      type: 'session.ready',
      capabilities: ['text', 'audio_input', 'speech_to_text'],
    });

    built.webSocket.emit('message', Buffer.from(JSON.stringify({
      schemaVersion: 1,
      type: 'audio.start',
      requestId: 'z02-stream-1',
    })), false);
    await vi.waitFor(() => expect(built.audioIngress?.start).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(built.webSocket.sent).toContainEqual(
      JSON.stringify({ schemaVersion: 1, type: 'audio.ready', requestId: 'z02-stream-1' }),
    ));
    expect(built.audioIngress?.start).toHaveBeenCalledWith(expect.objectContaining({
      companionId,
      onPartial: expect.any(Function),
      onUtterance: expect.any(Function),
      onError: expect.any(Function),
    }));

    const pcm = Uint8Array.of(0x34, 0x12, 0xcc, 0xff);
    built.webSocket.emit('message', encodeCompanionUiAudioChunk(0, pcm), true);
    await vi.waitFor(() => expect(built.audioIngress?.writePcm).toHaveBeenCalledWith(pcm));
    await vi.waitFor(() => expect(built.webSocket.sent).toContainEqual(
      JSON.stringify({
        schemaVersion: 1,
        type: 'audio.ack',
        requestId: 'z02-stream-1',
        sequence: 0,
      }),
    ));

    built.audioIngress?.callbacks?.onPartial('hello there');
    await built.audioIngress?.callbacks?.onUtterance('hello there');
    await vi.waitFor(() => expect(built.execute).toHaveBeenCalledOnce());
    expect(built.screenAudioTranscript).toHaveBeenCalledWith(expect.objectContaining({
      companionId,
      transcript: 'hello there',
      requestId: expect.any(String),
      attachment: expect.objectContaining({
        channel: expect.objectContaining({ source: 'server', companionId }),
      }),
    }));
    const brokerInput = built.execute.mock.calls[0]?.[0] as { rawBody: Uint8Array };
    expect(JSON.parse(Buffer.from(brokerInput.rawBody).toString('utf8'))).toMatchObject({
      schemaVersion: 1,
      action: 'companion.interact',
      resource: 'conversation.audio',
      body: { transcript: 'screened speech' },
    });
    expect(built.webSocket.sent.map(value => JSON.parse(value))).toEqual(expect.arrayContaining([
      {
        schemaVersion: 1,
        type: 'event',
        event: { type: 'message', data: { role: 'user', content: 'hello there', live: true } },
      },
      {
        schemaVersion: 1,
        type: 'event',
        event: { type: 'message', data: { role: 'user', content: 'screened speech', final: true } },
      },
      {
        schemaVersion: 1,
        type: 'event',
        event: { type: 'message', data: { role: 'assistant', content: 'companion heard you', final: true } },
      },
    ]));
    expect(built.webSocket.sent.join('\n')).not.toContain('3412ccff');

    built.webSocket.emit('message', Buffer.from(JSON.stringify({
      schemaVersion: 1,
      type: 'audio.stop',
      requestId: 'z02-stream-1',
    })), false);
    await vi.waitFor(() => expect(built.audioIngress?.stop).toHaveBeenCalledWith('client stop'));
    await vi.waitFor(() => expect(built.webSocket.sent).toContainEqual(
      JSON.stringify({ schemaVersion: 1, type: 'audio.stopped', requestId: 'z02-stream-1' }),
    ));
    await built.adapter.stop();
  });

  it('routes an explicit guest audio turn only through the guest broker', async () => {
    const built = fixture({ guest: true, audio: true });
    const candidate = request();
    delete candidate.headers.cookie;
    candidate.headers['x-psfn-satellite-capabilities'] = 'text,audio_input,speech_to_text';
    candidate.rawHeaders = Object.entries(candidate.headers)
      .flatMap(([name, value]) => [name, String(value)]);
    const socket = new FakeSocket();
    built.adapter.handleUpgrade(candidate, socket as unknown as Duplex, Buffer.alloc(0));
    await vi.waitFor(() => expect(built.handleUpgrade).toHaveBeenCalledOnce());
    built.webSocket.emit('message', CONFIGURE, false);
    await vi.waitFor(() => expect(built.webSocket.sent).toHaveLength(1));
    built.webSocket.emit('message', Buffer.from(JSON.stringify({
      schemaVersion: 1,
      type: 'audio.start',
      requestId: 'z02-guest-stream',
    })), false);
    await vi.waitFor(() => expect(built.audioIngress?.start).toHaveBeenCalledOnce());

    await built.audioIngress?.callbacks?.onUtterance('guest speech');

    expect(built.execute).not.toHaveBeenCalled();
    expect(built.guestExecute).toHaveBeenCalledWith(expect.objectContaining({
      signal: expect.any(AbortSignal),
      attachment: expect.objectContaining({ actor: { kind: 'guest', companionId } }),
    }));
    await built.adapter.stop();
  });

  it('denies binary audio before a capability-gated server stream exists', async () => {
    const built = fixture();
    const socket = new FakeSocket();
    built.adapter.handleUpgrade(request(), socket as unknown as Duplex, Buffer.alloc(0));
    await vi.waitFor(() => expect(built.handleUpgrade).toHaveBeenCalledOnce());
    built.webSocket.emit('message', CONFIGURE, false);
    await vi.waitFor(() => expect(built.webSocket.sent).toHaveLength(1));

    built.webSocket.emit('message', encodeCompanionUiAudioChunk(0, Uint8Array.of(0, 0)), true);
    await vi.waitFor(() => expect(built.webSocket.readyState).toBe(WebSocket.CLOSED));
    expect(built.webSocket.closeArgs[0]).toBe(4403);
    expect(built.execute).not.toHaveBeenCalled();
    await built.adapter.stop();
  });

  it('interrupts the server-owned active audio turn without accepting an interaction id', async () => {
    const built = fixture({ audio: true });
    const candidate = request();
    candidate.headers['x-psfn-satellite-capabilities'] = 'text,audio_input,speech_to_text';
    candidate.rawHeaders = Object.entries(candidate.headers)
      .flatMap(([name, value]) => [name, String(value)]);
    const socket = new FakeSocket();
    built.adapter.handleUpgrade(candidate, socket as unknown as Duplex, Buffer.alloc(0));
    await vi.waitFor(() => expect(built.handleUpgrade).toHaveBeenCalledOnce());
    built.webSocket.emit('message', CONFIGURE, false);
    await vi.waitFor(() => expect(built.webSocket.sent).toHaveLength(1));
    built.webSocket.emit('message', Buffer.from(JSON.stringify({
      schemaVersion: 1,
      type: 'audio.start',
      requestId: 'z02-stream-interrupt',
    })), false);
    await vi.waitFor(() => expect(built.audioIngress?.start).toHaveBeenCalledOnce());

    let finishAction!: () => void;
    built.execute.mockImplementationOnce(() => new Promise(resolve => {
      finishAction = () => resolve({
        content: '',
        channelId: 'server-owned-channel',
        inputTokens: 1,
        outputTokens: 0,
      });
    }));
    const delivering = built.audioIngress?.callbacks?.onUtterance('interrupt me');
    await vi.waitFor(() => expect(built.webSocket.sent).toContainEqual(
      JSON.stringify({
        schemaVersion: 1,
        type: 'audio.turn.started',
        requestId: 'z02-stream-interrupt',
      }),
    ));

    built.webSocket.emit('message', Buffer.from(JSON.stringify({
      schemaVersion: 1,
      type: 'audio.interrupt',
      requestId: 'z02-stream-interrupt',
    })), false);
    await vi.waitFor(() => expect(built.cancelAudioInteraction).toHaveBeenCalledWith(
      expect.objectContaining({
        companionId,
        attachment: expect.objectContaining({ channel: expect.objectContaining({ companionId }) }),
        interactionId: expect.any(String),
      }),
    ));
    expect(built.cancelAudioInteraction.mock.calls[0]?.[0])
      .not.toHaveProperty('browserInteractionId');
    finishAction();
    await delivering;
    await vi.waitFor(() => expect(built.webSocket.sent).toContainEqual(
      JSON.stringify({
        schemaVersion: 1,
        type: 'audio.turn.ended',
        requestId: 'z02-stream-interrupt',
      }),
    ));
    expect(built.webSocket.sent).toContainEqual(JSON.stringify({
      schemaVersion: 1,
      type: 'event',
      event: { type: 'action', data: 'interrupt' },
    }));
    await built.adapter.stop();
  });

  it('propagates a fast interrupt that arrives before backend dispatch registration', async () => {
    const built = fixture({ audio: true });
    const candidate = request();
    candidate.headers['x-psfn-satellite-capabilities'] = 'text,audio_input,speech_to_text';
    candidate.rawHeaders = Object.entries(candidate.headers)
      .flatMap(([name, value]) => [name, String(value)]);
    const socket = new FakeSocket();
    built.adapter.handleUpgrade(candidate, socket as unknown as Duplex, Buffer.alloc(0));
    await vi.waitFor(() => expect(built.handleUpgrade).toHaveBeenCalledOnce());
    built.webSocket.emit('message', CONFIGURE, false);
    await vi.waitFor(() => expect(built.webSocket.sent).toHaveLength(1));
    built.webSocket.emit('message', Buffer.from(JSON.stringify({
      schemaVersion: 1,
      type: 'audio.start',
      requestId: 'z02-fast-interrupt',
    })), false);
    await vi.waitFor(() => expect(built.audioIngress?.start).toHaveBeenCalledOnce());

    const admission = await built.admit.mock.results[0]!.value;
    let releaseDispatchRefresh!: () => void;
    built.admit.mockImplementationOnce(async () => admission);
    built.admit.mockImplementationOnce(() => new Promise(resolve => {
      releaseDispatchRefresh = () => resolve(admission);
    }));
    const delivering = built.audioIngress?.callbacks?.onUtterance('interrupt immediately');
    await vi.waitFor(() => expect(built.webSocket.sent).toContainEqual(
      JSON.stringify({
        schemaVersion: 1,
        type: 'audio.turn.started',
        requestId: 'z02-fast-interrupt',
      }),
    ));
    expect(built.execute).not.toHaveBeenCalled();

    built.webSocket.emit('message', Buffer.from(JSON.stringify({
      schemaVersion: 1,
      type: 'audio.interrupt',
      requestId: 'z02-fast-interrupt',
    })), false);
    await vi.waitFor(() => expect(built.cancelAudioInteraction).toHaveBeenCalledOnce());
    releaseDispatchRefresh();
    await vi.waitFor(() => expect(built.execute).toHaveBeenCalledOnce());
    const input = built.execute.mock.calls[0]?.[0] as { signal?: AbortSignal };
    expect(input.signal?.aborted).toBe(true);
    await delivering;
    await built.adapter.stop();
  });

  it('terminates the socket and cancels the active turn when transcription fails', async () => {
    const built = fixture({ audio: true });
    const candidate = request();
    candidate.headers['x-psfn-satellite-capabilities'] = 'text,audio_input,speech_to_text';
    candidate.rawHeaders = Object.entries(candidate.headers)
      .flatMap(([name, value]) => [name, String(value)]);
    const socket = new FakeSocket();
    built.adapter.handleUpgrade(candidate, socket as unknown as Duplex, Buffer.alloc(0));
    await vi.waitFor(() => expect(built.handleUpgrade).toHaveBeenCalledOnce());
    built.webSocket.emit('message', CONFIGURE, false);
    await vi.waitFor(() => expect(built.webSocket.sent).toHaveLength(1));
    built.webSocket.emit('message', Buffer.from(JSON.stringify({
      schemaVersion: 1,
      type: 'audio.start',
      requestId: 'z02-stream-failure',
    })), false);
    await vi.waitFor(() => expect(built.audioIngress?.start).toHaveBeenCalledOnce());

    let finishAction!: () => void;
    built.execute.mockImplementationOnce(() => new Promise(resolve => {
      finishAction = () => resolve({
        content: '',
        channelId: 'server-owned-channel',
        inputTokens: 1,
        outputTokens: 0,
      });
    }));
    const delivering = built.audioIngress?.callbacks?.onUtterance('cancel this turn');
    await vi.waitFor(() => expect(built.webSocket.sent).toContainEqual(
      JSON.stringify({
        schemaVersion: 1,
        type: 'audio.turn.started',
        requestId: 'z02-stream-failure',
      }),
    ));

    built.audioIngress?.callbacks?.onError(new Error('provider disconnected'));

    await vi.waitFor(() => expect(built.cancelAudioInteraction).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(built.audioIngress?.cancel)
      .toHaveBeenCalledWith('STT stream failed'));
    expect(built.webSocket.closeArgs[0]).toBe(4403);
    expect(built.webSocket.closeArgs[1]).toBe('audio relay failed');
    finishAction();
    await delivering;
    await built.adapter.stop();
  });

  it('reserves audio startup synchronously so concurrent starts cannot orphan an STT session', async () => {
    const built = fixture({ audio: true });
    const candidate = request();
    candidate.headers['x-psfn-satellite-capabilities'] = 'text,audio_input,speech_to_text';
    candidate.rawHeaders = Object.entries(candidate.headers)
      .flatMap(([name, value]) => [name, String(value)]);
    let releaseStart!: () => void;
    built.audioIngress?.start.mockImplementationOnce(() => new Promise(resolve => {
      releaseStart = () => resolve({
        writePcm: built.audioIngress!.writePcm,
        stop: built.audioIngress!.stop,
        cancel: built.audioIngress!.cancel,
      });
    }));
    const socket = new FakeSocket();
    built.adapter.handleUpgrade(candidate, socket as unknown as Duplex, Buffer.alloc(0));
    await vi.waitFor(() => expect(built.handleUpgrade).toHaveBeenCalledOnce());
    built.webSocket.emit('message', CONFIGURE, false);
    await vi.waitFor(() => expect(built.webSocket.sent).toHaveLength(1));

    built.webSocket.emit('message', Buffer.from(JSON.stringify({
      schemaVersion: 1,
      type: 'audio.start',
      requestId: 'z02-start-a',
    })), false);
    await vi.waitFor(() => expect(built.audioIngress?.start).toHaveBeenCalledOnce());
    built.webSocket.emit('message', Buffer.from(JSON.stringify({
      schemaVersion: 1,
      type: 'audio.start',
      requestId: 'z02-start-b',
    })), false);

    await vi.waitFor(() => expect(built.webSocket.readyState).toBe(WebSocket.CLOSED));
    releaseStart();
    await vi.waitFor(() => expect(built.audioIngress?.cancel).toHaveBeenCalled());
    expect(built.webSocket.sent).not.toContainEqual(expect.stringContaining('"type":"audio.ready"'));
    await built.adapter.stop();
  });
});
