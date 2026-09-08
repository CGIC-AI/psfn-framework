import { describe, expect, it } from 'vitest';
import { parseSatelliteRegistryConfig } from '../src/channels/backplane/satellite-registry.js';
import {
  assertHubSessionReady,
  companionUiSessionReadyDivergence,
  relayEventsUrl,
} from './compose-hub-verification.js';
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
      { companionId: SMOKE_COMPANION_ID, scopes: ['approvals', 'artifacts', 'tool_activity'] },
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
});
