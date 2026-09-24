import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { parse as parseYaml } from 'yaml';
import { buildSatelliteHello, MOBILE_CHAT_APP_CAPABILITIES } from '../companion-ui/src/lib/api/auth.js';
import { createHubDeviceAssertionIssuer } from '../apps/satellite-hub/src/ts/hub/device-assertion.js';
import {
  authenticateHubDevice,
  createHubDeviceRegistryAuthority,
  intersectCapabilities,
  type HubDeviceRegistry,
} from '../apps/satellite-hub/src/ts/hub/device-registry.js';
import { parseSatelliteRegistryConfig } from '../src/channels/backplane/satellite-registry.js';
import {
  assertHubSessionReady,
  companionUiSessionReadyDivergence,
  buildEnrolledDeviceHello,
  collectHubHandshake,
  judgeRelayedEmotionSnapshot,
  openEmotionRelaySession,
  probeUnauthenticatedHello,
  relayEventsUrl,
} from './compose-hub-verification.js';
import {
  buildSmokeHubDeviceRegistry,
  generateSmokeHubDeviceAssertionKey,
  SMOKE_HUB_DEVICE_ID,
} from './ops/psfn-compose-smoke-hub-device.mjs';
import {
  buildSmokeSatelliteRegistry,
  deriveApiKeyPrincipalId,
} from './ops/psfn-compose-smoke-satellites.mjs';

const SMOKE_KEY = 'psfn-smoke-satellite-key-please-rotate';
const SMOKE_COMPANION_ID = '11111111-1111-4111-8111-111111111111';

function registry(): unknown {
  return buildSmokeSatelliteRegistry({
    apiKey: SMOKE_KEY,
    satelliteId: 'smoke-hub',
    endpointId: 'smoke-hub-endpoint',
    claimType: 'satellite.endpoint',
    companionId: SMOKE_COMPANION_ID,
  });
}

describe('Compose smoke satellite registry', () => {
  it('derives the gateway principal from the satellite bearer without exposing it', () => {
    const principal = deriveApiKeyPrincipalId(SMOKE_KEY);
    expect(principal).toMatch(/^api-key-[0-9a-f]{24}$/u);
    expect(principal).not.toContain(SMOKE_KEY);
  });

  it('produces a registry the framework parser accepts', () => {
    const parsed = parseSatelliteRegistryConfig(registry(), 'satellites.json');
    expect(parsed.enabled).toBe(true);
    const endpoint = parsed.satellites[0]?.endpoints[0];
    expect(endpoint?.endpointId).toBe('smoke-hub-endpoint');
    expect(endpoint?.auth.apiKeyPrincipalIds).toEqual([deriveApiKeyPrincipalId(SMOKE_KEY)]);
    expect(endpoint?.claimTypes).toEqual(['satellite.endpoint']);
  });

  it('binds the hub credential so a different key is not admitted', () => {
    const parsed = parseSatelliteRegistryConfig(registry(), 'satellites.json');
    expect(parsed.satellites[0]?.endpoints[0]?.auth.apiKeyPrincipalIds)
      .not.toContain(deriveApiKeyPrincipalId('psfn-smoke-api-key-please-rotate'));
  });

  it('refuses a credential the gateway would reject', () => {
    expect(() => buildSmokeSatelliteRegistry({
      apiKey: 'too-short',
      satelliteId: 'smoke-hub',
      endpointId: 'smoke-hub-endpoint',
      claimType: 'satellite.endpoint',
      companionId: SMOKE_COMPANION_ID,
    })).toThrow(/at least 16 characters/u);
  });

  // A fleet deployment refuses an ungoverned satellite, and every PSFN
  // deployment is a fleet (psfn-framework-e5aoa).
  it('declares shared-device authority naming the deployment companion', () => {
    const parsed = parseSatelliteRegistryConfig(registry(), 'satellites.json');
    const sharedDevice = parsed.satellites[0]?.sharedDevice;
    expect(sharedDevice?.primaryCompanionId).toBe(SMOKE_COMPANION_ID);
    expect(sharedDevice?.emanationMemberIds).toEqual([SMOKE_COMPANION_ID]);
    expect(sharedDevice?.observationRecipients).toEqual([
      { companionId: SMOKE_COMPANION_ID, scopes: ['approvals', 'artifacts', 'tool_activity', 'emotion'] },
    ]);
  });

  it('refuses a registry with no shared-device companion', () => {
    expect(() => buildSmokeSatelliteRegistry({
      apiKey: SMOKE_KEY,
      satelliteId: 'smoke-hub',
      endpointId: 'smoke-hub-endpoint',
      claimType: 'satellite.endpoint',
    })).toThrow(/companionId is required/u);
  });
});

describe('Compose hub verification helpers', () => {
  it('builds the companion relay subscription URL from the claim identity', () => {
    expect(relayEventsUrl({
      gatewayApiBase: 'http://127.0.0.1:13000/v1',
      satelliteId: 'smoke-hub',
      endpointId: 'smoke-hub-endpoint',
      claimType: 'satellite.endpoint',
    })).toBe(
      'http://127.0.0.1:13000/v1/companion/events'
      + '?satelliteId=smoke-hub&endpointId=smoke-hub-endpoint&claimType=satellite.endpoint',
    );
  });

  it('accepts the hub session.ready declaration and rejects a truncated one', () => {
    const frame = {
      type: 'session.ready',
      sessionId: 'realtime:client-abcd1234',
      channelId: 'satellite.endpoint:smoke-hub',
      deviceId: 'client-abcd1234',
      deviceName: 'Opanhome TS Client',
      satelliteId: 'client-abcd1234',
      audioFormat: 'text_only',
      capabilities: { input: ['text'], output: ['text'], control: [], safety: [] },
    };
    expect(() => assertHubSessionReady(frame)).not.toThrow();
    expect(() => assertHubSessionReady({ ...frame, channelId: '' })).toThrow(/missing channelId/u);
    expect(() => assertHubSessionReady({ type: 'pong' })).toThrow(/not session\.ready/u);
  });

  it('names the exact keys companion-ui refuses on a hub session.ready', () => {
    expect(companionUiSessionReadyDivergence({
      type: 'session.ready',
      sessionId: 's',
      channelId: 'c',
      deviceId: 'd',
      deviceName: 'n',
      satelliteId: 'sat',
      audioFormat: 'text_only',
      capabilities: {},
    })).toEqual(['capabilities']);
    expect(companionUiSessionReadyDivergence({
      type: 'session.ready',
      sessionId: 's',
      channelId: 'c',
      deviceId: 'd',
      deviceName: 'n',
      satelliteId: 'sat',
      audioFormat: 'text_only',
    })).toEqual([]);
  });

  it('accepts only a post_turn emotion.snapshot that companion-ui decodes', () => {
    const frame = {
      type: 'emotion.snapshot',
      data: {
        trigger: 'post_turn',
        vad: { valence: 0.1, arousal: -0.2, dominance: 0 },
        mood: { valence: 0, arousal: 0, dominance: 0 },
        discrete: [{ label: 'joy', score: 0.4 }],
        confidence: 0.5,
        timestamp: '2026-09-24T05:00:00.000Z',
      },
    };
    expect(judgeRelayedEmotionSnapshot(frame)).toMatchObject({ ok: true });
    expect(judgeRelayedEmotionSnapshot({ ...frame, data: { ...frame.data, trigger: 'vad_shift' } }))
      .toMatchObject({ ok: false, detail: expect.stringContaining('trigger=vad_shift') });
    expect(judgeRelayedEmotionSnapshot({ ...frame, data: { ...frame.data, confidence: 2 } }))
      .toMatchObject({ ok: false });
    expect(judgeRelayedEmotionSnapshot({ type: 'pong', sentAt: 1 }))
      .toMatchObject({ ok: false, detail: 'decoded pong, expected emotion.snapshot' });
  });
});

const TEST_DEVICE = { deviceId: SMOKE_HUB_DEVICE_ID, credential: 'a'.repeat(64) };
const EMOTION_GRANT = { input: ['text'], output: ['text', 'emotion'], control: [], safety: [] };

function smokeDeviceRegistry(credential = TEST_DEVICE.credential): HubDeviceRegistry {
  return buildSmokeHubDeviceRegistry({
    credential,
    companionId: SMOKE_COMPANION_ID,
    satelliteId: 'smoke-hub',
    endpointId: 'smoke-hub-endpoint',
    claimType: 'satellite.endpoint',
  }) as HubDeviceRegistry;
}

describe('Compose smoke Hub device enrollment', () => {
  it('produces a registry the Hub accepts, enrolling only the credential digest', () => {
    const registry = smokeDeviceRegistry();
    const authority = createHubDeviceRegistryAuthority(() => registry);
    const [device] = authority.readCurrent().devices;
    expect(device).toMatchObject({
      deviceId: SMOKE_HUB_DEVICE_ID,
      companionId: SMOKE_COMPANION_ID,
      satelliteId: 'smoke-hub',
      endpointId: 'smoke-hub-endpoint',
      claimType: 'satellite.endpoint',
      enrollmentStatus: 'active',
    });
    expect(JSON.stringify(registry)).not.toContain(TEST_DEVICE.credential);
  });

  it('authenticates only the generated credential', () => {
    const registry = smokeDeviceRegistry();
    expect(authenticateHubDevice(registry, TEST_DEVICE.credential)?.deviceId).toBe(SMOKE_HUB_DEVICE_ID);
    expect(authenticateHubDevice(registry, 'b'.repeat(64))).toBeNull();
    expect(authenticateHubDevice(registry, undefined)).toBeNull();
  });

  it('grants exactly companion-ui\'s hello capabilities, emotion included', () => {
    const device = authenticateHubDevice(smokeDeviceRegistry(), TEST_DEVICE.credential)!;
    expect(device.maxCapabilities).toEqual(MOBILE_CHAT_APP_CAPABILITIES);
    const granted = intersectCapabilities(buildSatelliteHello().capabilities, device.maxCapabilities);
    expect(granted.output).toContain('emotion');
  });

  it('refuses a short credential and a missing companion', () => {
    expect(() => smokeDeviceRegistry('short')).toThrow(/at least 32 characters/u);
    expect(() => buildSmokeHubDeviceRegistry({
      credential: TEST_DEVICE.credential,
      satelliteId: 'smoke-hub',
      endpointId: 'smoke-hub-endpoint',
      claimType: 'satellite.endpoint',
    })).toThrow(/companionId/u);
  });

  it('wires a registry-mode Hub whose assertion signing config the Hub accepts, with no committed credential', () => {
    const repoRoot = resolve(import.meta.dirname, '..');
    const composeText = readFileSync(join(repoRoot, 'docker/docker-compose.smoke.yml'), 'utf8');
    const compose = parseYaml(composeText) as {
      services: Record<string, {
        environment?: Record<string, string>;
        volumes?: string[];
        depends_on?: Record<string, { condition: string }>;
      }>;
    };
    const hub = compose.services['satellite-hub']!;
    const seed = compose.services.seed!;
    const env = hub.environment!;
    expect(hub.volumes).toContain('hub-device:/app/hub-device:ro');
    expect(hub.depends_on?.seed).toEqual({ condition: 'service_completed_successfully' });
    expect(seed.volumes).toContain('hub-device:/run/psfn-hub-device');
    expect(env.HUB_DEVICE_REGISTRY_PATH).toBe('/app/hub-device/devices.json');
    expect(env.HUB_DEVICE_ASSERTION_PRIVATE_KEY_PATH).toBe('/app/hub-device/device-assertion-key.pem');
    expect(seed.environment?.PSFN_SMOKE_HUB_DEVICE_CREDENTIAL).toBe('${PSFN_SMOKE_HUB_DEVICE_CREDENTIAL:-}');
    const issuer = createHubDeviceAssertionIssuer({
      issuer: env.HUB_DEVICE_ASSERTION_ISSUER!,
      kid: env.HUB_DEVICE_ASSERTION_KID!,
      audience: env.HUB_DEVICE_ASSERTION_AUDIENCE!,
      privateKeyPem: generateSmokeHubDeviceAssertionKey(),
      ttlSeconds: Number(env.HUB_DEVICE_ASSERTION_TTL_SECONDS),
    });
    const device = authenticateHubDevice(smokeDeviceRegistry(), TEST_DEVICE.credential)!;
    expect(issuer.issue({ device, sessionId: 'realtime:smoke' }).split('.')).toHaveLength(3);
  });
});

/** A registry-mode Hub double: refuses non-hello and credential-less hellos. */
async function withRegistryHub(
  grant: Record<string, string[]>,
  run: (url: string, received: unknown[]) => Promise<void>,
): Promise<void> {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const received: unknown[] = [];
  server.on('connection', (socket: WsSocket) => {
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>;
      received.push(frame);
      if (frame.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', sentAt: frame.sentAt }));
        return;
      }
      if (frame.type !== 'hello' || frame.credential !== TEST_DEVICE.credential) {
        socket.send(JSON.stringify({ type: 'error-event', data: { message: 'Satellite device authentication failed' } }));
        socket.close(1008, 'device authentication failed');
        return;
      }
      socket.send(JSON.stringify({ type: 'session.ready', capabilities: grant }));
      socket.send(JSON.stringify({ type: 'hello.ack', capabilities: grant }));
    });
  });
  await new Promise<void>(resolvePromise => server.once('listening', () => resolvePromise()));
  try {
    const { port } = server.address() as AddressInfo;
    await run(`ws://127.0.0.1:${port}/`, received);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
  }
}

describe('Compose smoke emotion relay probe', () => {
  it('authenticates as the enrolled device with companion-ui\'s own hello capabilities', async () => {
    await withRegistryHub(EMOTION_GRANT, async (url, received) => {
      const session = await openEmotionRelaySession(url, 2_000, TEST_DEVICE);
      session.close();
      expect(received).toEqual([{ ...buildSatelliteHello(), ...TEST_DEVICE }]);
      expect(JSON.parse(buildEnrolledDeviceHello(TEST_DEVICE)).capabilities.output).toContain('emotion');
    });
  });

  it('fails the relay probe when the hub does not grant the emotion output', async () => {
    await withRegistryHub({ ...EMOTION_GRANT, output: ['text'] }, async (url) => {
      await expect(openEmotionRelaySession(url, 2_000, TEST_DEVICE)).rejects.toThrow(/did not grant the emotion output/u);
    });
  });

  it('completes the authenticated handshake before ping/pong', async () => {
    await withRegistryHub(EMOTION_GRANT, async (url) => {
      const handshake = await collectHubHandshake(url, 2_000, TEST_DEVICE);
      expect(handshake.sessionReady).toMatchObject({ type: 'session.ready' });
      expect(handshake.helloAck).toMatchObject({ type: 'hello.ack' });
      expect(handshake.pong).toMatchObject({ type: 'pong' });
    });
  });

  it('reports a registry hub refusing a credential-less companion-ui hello', async () => {
    await withRegistryHub(EMOTION_GRANT, async (url, received) => {
      const probe = await probeUnauthenticatedHello(url, 2_000);
      expect(probe.refused).toBe(true);
      expect(received).toEqual([buildSatelliteHello()]);
    });
  });

  it('does not report a refusal when the hub admits a credential-less hello', async () => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    server.on('connection', (socket: WsSocket) => {
      socket.on('message', () => socket.send(JSON.stringify({ type: 'hello.ack', capabilities: EMOTION_GRANT })));
    });
    await new Promise<void>(resolvePromise => server.once('listening', () => resolvePromise()));
    try {
      const { port } = server.address() as AddressInfo;
      const probe = await probeUnauthenticatedHello(`ws://127.0.0.1:${port}/`, 300);
      expect(probe.refused).toBe(false);
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise<void>(resolvePromise => server.close(() => resolvePromise()));
    }
  });
});
