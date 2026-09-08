import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { CompanionUiWebSocketAdapter } from './companion-ui-websocket.js';
import { parseSatelliteRegistryConfig } from '../backplane/satellite-registry.js';
import { deriveApiKeyPrincipalId } from '../backplane/http/auth.js';
import { CompanionEventRelay } from '../backplane/companion-relay/relay.js';
import { CompanionUiAudioOutputRelay } from '../backplane/companion-ui-audio-output-relay.js';
import { EventBus } from '../../shared/event-bus.js';
import { GatewayHubDeviceIngressService } from '../../boundary/fleet-auth/hub-device-ingress.js';
import { verifyAndConsumeHubDeviceAssertion } from '../../boundary/fleet-auth/hub-device-assertion.js';
import { CompanionBrowserBridge } from '../../../apps/satellite-hub/src/ts/hub/companion-browser-bridge.js';
import { createHubDeviceAssertionIssuer } from '../../../apps/satellite-hub/src/ts/hub/device-assertion.js';
import { createHubDeviceRegistryAuthority, type HubDeviceIdentity } from '../../../apps/satellite-hub/src/ts/hub/device-registry.js';
import { normalizeSatelliteClaimConfig } from '../../../apps/satellite-hub/src/ts/hub/satellite-claim.js';
import type { HubDeviceHumanAttachmentPort } from '../../boundary/fleet-auth/hub-device-ingress.js';
import { encodeCompanionUiAudioChunk } from '../../shared/contracts/companion-ui-audio.js';
import type { CompanionUiAudioIngressCallbacks } from '../../boundary/gateway/companion-ui-audio-ingress.js';

const companionId = '11111111-1111-4111-8111-111111111111';
const canonicalOrigin = 'https://fleet.example.test';
const cookie = `__Host-psfn_session=${'s'.repeat(43)}`;
const credential = 'server-held-display-enrollment-credential';
const apiKey = 'server-held-hub-api-key-for-testing';
const proxyToken = 'synthetic-proxy-token-for-local-test-only';
const certDigest = 'a'.repeat(64);

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test socket');
  return `http://127.0.0.1:${address.port}`;
}

async function fixture(options: { microphone?: boolean; spokenAudio?: boolean } = {}) {
  const keys = generateKeyPairSync('ed25519');
  let nowSeconds = Math.floor(Date.now() / 1000);
  const initialTime = nowSeconds;
  const issuer = createHubDeviceAssertionIssuer({
    issuer: 'hub', kid: 'key', audience: canonicalOrigin, ttlSeconds: 5,
    privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  });
  const assertions: string[] = [];
  const device: HubDeviceIdentity = {
    deviceId: 'display', deviceName: 'Shared display', satelliteId: 'browser-display',
    satelliteName: 'Shared display', endpointId: 'app', claimType: 'hub-device',
    credentialSha256: createHash('sha256').update(credential).digest('hex'),
    enrollmentVersion: 1, enrollmentAssurance: 'device_credential', enrollmentStatus: 'active',
    companionId, maxCapabilities: { input: ['text', ...(options.microphone ? ['microphone_pcm', 'final_transcript'] as const : [])],
      output: ['text', ...(options.spokenAudio === false ? [] : ['streamed_audio'] as const)], control: [], safety: [] },
    homeAssistantEntityIds: [],
  };
  const peerCredential = 'server-held-peer-display-credential';
  const peer: HubDeviceIdentity = { ...device, deviceId: 'peer-display', satelliteId: 'peer-display',
    companionId: '66666666-6666-4666-8666-666666666666',
    credentialSha256: createHash('sha256').update(peerCredential).digest('hex') };
  const registry = createHubDeviceRegistryAuthority(() => ({ schemaVersion: 1, devices: [device, peer] }));
  const consumed = new Map<string, string>();
  const receipts = new Map<string, string>();
  const attach: HubDeviceHumanAttachmentPort['attach'] = async input => {
    const attachmentId = receipts.get(input.assertionDigest) ?? randomUUID();
    receipts.set(input.assertionDigest, attachmentId);
    if (input.human.kind !== 'fleet_browser_session' || input.human.sessionToken !== 's'.repeat(43)) throw new Error('Human denied');
    return {
      attachmentId, disposition: 'created',
      deviceActor: { kind: 'hub_device', principal: input.devicePrincipal, connectionId: input.connection.connectionId },
      actor: { kind: 'human', companionId, principalId: '22222222-2222-4222-8222-222222222222',
        providerSubject: { provider: 'discord', subjectId: '123456789012345678' },
        contact: { bindingId: '33333333-3333-4333-8333-333333333333', contactId: 'partner', bindingVersion: 1 },
        operator: { grantId: '44444444-4444-4444-8444-444444444444', role: 'member', grantVersion: 1 },
        session: { recordId: '55555555-5555-4555-8555-555555555555', authorityGeneration: 1, globalAuthEpoch: 1 } },
      channel: { source: 'server', id: `hub-device:${'b'.repeat(64)}`, companionId },
    };
  };
  const ingress = new GatewayHubDeviceIngressService({
    verifyAndConsume: (token, expected) => verifyAndConsumeHubDeviceAssertion({
      token, expected, nowSeconds, sessionPepper: 'test-session-pepper-of-sufficient-length',
      config: { issuer: 'hub', audience: canonicalOrigin, maxTtlSeconds: 5, clockSkewSeconds: 0,
        keys: [{ kid: 'key', publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2099-01-01T00:00:00.000Z', status: 'active' }] },
      replayStore: { consume: async input => {
        const prior = consumed.get(input.jti);
        consumed.set(input.jti, input.assertionDigest);
        return { outcome: prior ? prior === input.assertionDigest ? 'replayed' : 'mismatch' : 'consumed' };
      } },
    }),
    enrollmentAuthority: { resolve: async input => input.authenticatedConnection },
    attachments: { attach, fenceDevice: async () => undefined },
  });
  let adapter: CompanionUiWebSocketAdapter;
  const gateway = createServer();
  gateway.on('upgrade', (request, socket, head) => adapter.handleUpgrade(request, socket, head));
  const gatewayOrigin = await listen(gateway);
  const spoken: string[] = [];
  const bridge = new CompanionBrowserBridge({
    canonicalOrigin, gatewayOrigin: canonicalOrigin, guestMode: 'disabled', deviceCredentials: [credential, peerCredential],
    maxFrameBytes: 1_048_576, maxBufferedBytes: 2_097_152, maxConnections: 4,
    handshakeTimeoutMs: 1000, enrollmentPollMs: 20,
  }, {
    model: 'psfn', baseUrl: `${gatewayOrigin}/v1`, apiKey,
    channelType: 'satellite.endpoint', satelliteClaim: normalizeSatelliteClaimConfig({}),
    voiceReplyDeadlineMs: 8000, voiceAttemptTimeoutMs: 8000,
    textReplyDeadlineMs: 8000, textAttemptTimeoutMs: 8000,
    deviceAssertionIssuer: { issue: input => {
      if (assertions.length > 0) nowSeconds = initialTime + 6;
      const token = issuer.issue({ ...input, issuedAtSeconds: nowSeconds });
      assertions.push(token);
      return token;
    } },
  }, registry, {
    async *streamText(text) { for await (const value of text) spoken.push(value); yield Buffer.from('test-mp3'); },
    async close() {},
  }, (_url, options) => new WebSocket(`${gatewayOrigin.replace('http:', 'ws:')}/companion-ui/companions/${companionId}/ws`, {
    ...options, headers: { ...options.headers, 'x-psfn-trusted-proxy-token': proxyToken,
      'x-psfn-client-cert-fingerprint-sha256': certDigest },
  }));
  const hub = createServer();
  hub.on('upgrade', (request, socket, head) => bridge.handleUpgrade(request, socket, head));
  const hubOrigin = await listen(hub);
  const execute = vi.fn(async () => ({ content: 'Hello from the companion.', channelId: 'chat', inputTokens: 1, outputTokens: 3 }));
  const capturedPcm: Uint8Array[] = [];
  let audioCallbacks: CompanionUiAudioIngressCallbacks | undefined;
  adapter = new CompanionUiWebSocketAdapter({
    canonicalOrigin, browserHubOrigin: hubOrigin, browserHubTimeoutMs: 1000,
    satelliteApiKeys: [apiKey], trustedProxyClientCertToken: proxyToken,
    satelliteRegistry: parseSatelliteRegistryConfig({ schemaVersion: 1, enabled: true, satellites: [{
      satelliteId: 'browser-display', displayName: 'Browser display', mobility: 'portable', endpoints: [{
        endpointId: 'app', displayName: 'Shared display', claimTypes: ['hub-device'], promptChannelType: 'satellite_hub',
        auth: { mode: 'mtls', apiKeyPrincipalIds: [deriveApiKeyPrincipalId(apiKey)], clientCertFingerprintSha256: certDigest },
        defaultIdentity: { authorId: 'unused', authorName: 'Unused', canonicalContactId: 'unused', channelPrivacy: 'private' },
        maxCapabilities: ['text', 'audio_output', 'text_to_speech',
          ...(options.microphone ? ['audio_input', 'speech_to_text'] : [])], telemetryScopes: ['status'],
        hubDeviceEnrollment: { deviceId: 'display', enrollmentVersion: 1, enrollmentStatus: 'active' },
      }],
    }] }),
    hubDeviceIngress: ingress, actionBroker: { execute } as never,
    eventRelay: new CompanionEventRelay({ eventBus: new EventBus(), defaultCompanionId: companionId, approvalBindingOf: () => ({ companionId }) }),
    audioOutputRelay: new CompanionUiAudioOutputRelay(1_048_576), authorityPollMs: 10_000,
    ...(options.microphone ? {
      audioIngress: { start: async (callbacks: CompanionUiAudioIngressCallbacks) => {
        audioCallbacks = callbacks;
        return { writePcm: async (pcm: Uint8Array) => { capturedPcm.push(pcm); },
          stop: async () => undefined, cancel: async () => undefined };
      } },
      screenAudioTranscript: async (input: { transcript: string }) => input.transcript,
      cancelAudioInteraction: async () => undefined,
    } : {}),
  });
  const socket = new WebSocket(`${gatewayOrigin.replace('http:', 'ws:')}/companion-ui/companions/${companionId}/ws`, {
    headers: { Host: new URL(canonicalOrigin).host, Origin: canonicalOrigin, Cookie: cookie },
  });
  const messages: Array<Record<string, unknown>> = [];
  socket.on('message', data => messages.push(JSON.parse(data.toString()) as Record<string, unknown>));
  await once(socket, 'open');
  socket.send(JSON.stringify({ schemaVersion: 1, type: 'session.configure', eventCapabilities: ['approvals.v2'] }));
  await vi.waitFor(() => expect(messages[0]?.type).toBe('session.ready'));
  return { socket, messages, execute, assertions, spoken, device, peer, capturedPcm,
    utterance: (text: string) => audioCallbacks!.onUtterance(text),
    close: async () => {
      socket.close();
      if (socket.readyState !== WebSocket.CLOSED) await once(socket, 'close');
      await bridge.close();
      await adapter.stop();
      await Promise.all([new Promise<void>(resolve => gateway.close(() => resolve())), new Promise<void>(resolve => hub.close(() => resolve()))]);
    } };
}

describe('Companion browser through Hub and gateway sockets', () => {
  it('routes cookie-only chat, synthesizes replies and renews beyond the original assertion lifetime without leaking authority', async () => {
    const f = await fixture();
    try {
      f.socket.send(JSON.stringify({ schemaVersion: 1, requestId: 'chat-1', action: 'companion.interact', resource: 'conversation.interact', body: { content: 'Hello' } }));
      await vi.waitFor(() => expect(f.messages.some(value => JSON.stringify(value).includes('audio-end'))).toBe(true));
      expect(f.spoken).toEqual(['Hello from the companion.']);
      await vi.waitFor(() => expect(f.assertions.length).toBe(2), { timeout: 3500 });
      f.peer.enrollmentStatus = 'revoked';
      f.socket.send(JSON.stringify({ schemaVersion: 1, requestId: 'chat-2', action: 'companion.interact', resource: 'conversation.interact', body: { content: 'Still here' } }));
      await vi.waitFor(() => expect(f.messages.some(value => value.requestId === 'chat-2' && value.ok === true)).toBe(true));
      expect(f.execute).toHaveBeenCalledTimes(2);
      const browserTraffic = JSON.stringify(f.messages);
      for (const secret of [apiKey, credential, cookie, ...f.assertions, 'hub.session.renew']) expect(browserTraffic).not.toContain(secret);
      f.device.enrollmentStatus = 'revoked';
      await vi.waitFor(() => expect(f.socket.readyState).toBe(WebSocket.CLOSED));
    } finally { await f.close(); }
  });

  it('rejects browser-injected renewal before it can reach gateway authority', async () => {
    const f = await fixture();
    try {
      f.socket.send(JSON.stringify({ schemaVersion: 1, type: 'hub.session.renew', requestId: 'spoof', assertion: 'stolen-token' }));
      await vi.waitFor(() => expect(f.socket.readyState).toBe(WebSocket.CLOSED));
      expect(f.assertions).toHaveLength(1);
      expect(f.execute).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it('carries PSZA PCM and stops spoken output after the authoritative audio turn has finalized', async () => {
    const f = await fixture({ microphone: true });
    try {
      f.socket.send(JSON.stringify({ schemaVersion: 1, type: 'audio.start', requestId: 'mic-1' }));
      await vi.waitFor(() => expect(f.messages.some(value => value.type === 'audio.ready')).toBe(true));
      const pcm = Uint8Array.of(1, 2, 3, 4);
      f.socket.send(encodeCompanionUiAudioChunk(0, pcm));
      await vi.waitFor(() => expect(f.capturedPcm).toEqual([pcm]));
      expect(f.messages.some(value => value.type === 'audio.ack' && value.sequence === 0)).toBe(true);
      await f.utterance('Hello by microphone');
      await vi.waitFor(() => expect(f.messages.some(value => value.type === 'audio.turn.ended')).toBe(true));
      const before = f.messages.length;
      f.socket.send(JSON.stringify({ schemaVersion: 1, type: 'audio.interrupt', requestId: 'mic-1' }));
      await vi.waitFor(() => expect(JSON.stringify(f.messages.slice(before))).toContain('pause-audio'));
      expect(f.spoken).toEqual(['Hello from the companion.']);
    } finally { await f.close(); }
  });

  it('never invokes TTS for an enrolled text-only endpoint', async () => {
    const f = await fixture({ spokenAudio: false });
    try {
      f.socket.send(JSON.stringify({ schemaVersion: 1, requestId: 'text-only', action: 'companion.interact', resource: 'conversation.interact', body: { content: 'Hello' } }));
      await vi.waitFor(() => expect(f.messages.some(value => value.requestId === 'text-only')).toBe(true));
      expect(f.spoken).toEqual([]);
      expect(JSON.stringify(f.messages)).not.toContain('audio-init');
    } finally { await f.close(); }
  });
});
