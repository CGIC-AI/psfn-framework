import { describe, expect, it } from 'vitest';
import { principalFromApiKeyToken } from './http/auth.js';
import {
  parseSatelliteRegistryConfig,
  resolveSatelliteClaim,
} from './satellite-registry.js';

const principal = principalFromApiKeyToken('test-secret-key');

function exampleRegistry(overrides: Record<string, unknown> = {}) {
  return parseSatelliteRegistryConfig({
    schemaVersion: 1,
    enabled: true,
    satellites: [
      {
        satelliteId: 'pi-voice',
        displayName: 'Kitchen Voice Pi',
        mobility: 'static',
        staticLocationLabel: 'kitchen',
        endpoints: [
          {
            endpointId: 'wyoming-voice',
            displayName: 'Wyoming Voice Endpoint',
            claimTypes: ['voice-pi'],
            promptChannelType: 'voice_satellite',
            auth: { mode: 'api_key' },
            defaultIdentity: {
              authorId: 'primary-user',
              authorName: 'Primary User',
              canonicalContactId: 'contact-primary-user',
              channelPrivacy: 'private',
            },
            maxCapabilities: ['text', 'audio_input', 'speech_to_text', 'audio_output', 'text_to_speech'],
            telemetryScopes: ['presence', 'health'],
          },
        ],
      },
      {
        satelliteId: 'voxta-avatar',
        displayName: 'Voxta Avatar',
        mobility: 'portable',
        endpoints: [
          {
            endpointId: 'avatar-display',
            displayName: 'Avatar Display',
            claimTypes: ['avatar-vision'],
            promptChannelType: 'avatar_satellite',
            auth: { mode: 'api_key' },
            defaultIdentity: {
              authorId: 'primary-user',
              authorName: 'Primary User',
              canonicalContactId: 'contact-primary-user',
              channelPrivacy: 'semi_private',
            },
            maxCapabilities: ['text', 'vision', 'image_upload', 'avatar', 'avatar_expression', 'avatar_action'],
            telemetryScopes: ['presence'],
          },
        ],
      },
      {
        satelliteId: 'hall-sensor',
        displayName: 'Hallway Sensor',
        mobility: 'static',
        endpoints: [
          {
            endpointId: 'telemetry',
            displayName: 'Telemetry Endpoint',
            claimTypes: ['sensor-telemetry'],
            promptChannelType: 'telemetry_satellite',
            auth: { mode: 'api_key' },
            defaultIdentity: {
              authorId: 'home-sensor',
              authorName: 'Home Sensor',
              canonicalContactId: 'contact-home',
              channelPrivacy: 'semi_private',
            },
            maxCapabilities: ['telemetry', 'presence', 'health', 'battery'],
            telemetryScopes: ['presence', 'health', 'battery'],
          },
        ],
      },
      {
        satelliteId: 'android-phone',
        displayName: 'Android Mobile Satellite',
        mobility: 'mobile',
        endpoints: [
          {
            endpointId: 'companion-app',
            displayName: 'Companion App',
            claimTypes: ['android-mobile'],
            promptChannelType: 'mobile_satellite',
            auth: { mode: 'api_key' },
            defaultIdentity: {
              authorId: 'primary-user',
              authorName: 'Primary User',
              canonicalContactId: 'contact-primary-user',
              channelPrivacy: 'private',
            },
            maxCapabilities: [
              'text',
              'audio_input',
              'speech_to_text',
              'audio_output',
              'text_to_speech',
              'vision',
              'image_upload',
              'location',
              'timezone',
              'presence',
              'battery',
              'telemetry',
              'outbound_delivery',
            ],
            telemetryScopes: ['location', 'timezone', 'presence', 'battery', 'health', 'device'],
          },
        ],
      },
    ],
    ...overrides,
  });
}

describe('satellite registry', () => {
  it('parses valid voice, avatar/vision, telemetry, and mobile satellite examples', () => {
    const registry = exampleRegistry();

    expect(registry.enabled).toBe(true);
    expect(registry.satellites.map(satellite => satellite.satelliteId)).toEqual([
      'pi-voice',
      'voxta-avatar',
      'hall-sensor',
      'android-phone',
    ]);
  });

  it('rejects unknown capabilities and empty mTLS bindings', () => {
    expect(() => parseSatelliteRegistryConfig({
      schemaVersion: 1,
      enabled: true,
      satellites: [
        {
          satelliteId: 'bad',
          displayName: 'Bad Satellite',
          mobility: 'mobile',
          endpoints: [
            {
              endpointId: 'bad-endpoint',
              displayName: 'Bad Endpoint',
              claimTypes: ['bad-mobile'],
              promptChannelType: 'bad_satellite',
              auth: { mode: 'api_key' },
              defaultIdentity: {
                authorId: 'primary-user',
                authorName: 'Primary User',
                canonicalContactId: 'contact-primary-user',
                channelPrivacy: 'private',
              },
              maxCapabilities: ['mind_reading'],
            },
          ],
        },
      ],
    })).toThrow('unknown capability');

    expect(() => parseSatelliteRegistryConfig({
      schemaVersion: 1,
      enabled: true,
      satellites: [
        {
          satelliteId: 'bad',
          displayName: 'Bad Satellite',
          mobility: 'mobile',
          endpoints: [
            {
              endpointId: 'bad-endpoint',
              displayName: 'Bad Endpoint',
              claimTypes: ['bad-mobile'],
              promptChannelType: 'bad_satellite',
              auth: { mode: 'mtls' },
              defaultIdentity: {
                authorId: 'primary-user',
                authorName: 'Primary User',
                canonicalContactId: 'contact-primary-user',
                channelPrivacy: 'private',
              },
              maxCapabilities: ['text'],
            },
          ],
        },
      ],
    })).toThrow('mTLS mode requires at least one client certificate binding');
  });

  it('resolves mobile speech and vision capabilities from registered claims', () => {
    const registry = exampleRegistry();
    const result = resolveSatelliteClaim({
      registry,
      principal,
      headers: {
        'x-psfn-satellite-claim-type': 'android-mobile',
        'x-psfn-satellite-id': 'android-phone',
        'x-psfn-satellite-endpoint-id': 'companion-app',
        'x-psfn-satellite-session-id': 'walk-with-artie',
        'x-psfn-satellite-capabilities': 'text,audio_input,speech_to_text,audio_output,text_to_speech,vision,image_upload,location',
        'x-psfn-satellite-telemetry-scopes': 'location,timezone,presence',
      },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        channelId: 'satellite:android-mobile:walk-with-artie',
        authorId: 'primary-user',
        authorName: 'Primary User',
        canonicalContactId: 'contact-primary-user',
        channelPrivacy: 'private',
      },
    });
    expect(result.ok && result.value.satellite.capabilities.effective).toEqual([
      'text',
      'audio_input',
      'speech_to_text',
      'audio_output',
      'text_to_speech',
      'vision',
      'image_upload',
      'location',
    ]);
    expect(result.ok && result.value.satellite.telemetryScopes).toEqual(['location', 'timezone', 'presence']);
  });

  it('fails closed for unknown claims and unauthorized advertised capabilities', () => {
    const registry = exampleRegistry();
    const unknown = resolveSatelliteClaim({
      registry,
      principal,
      headers: {
        'x-psfn-satellite-claim-type': 'android-mobile',
        'x-psfn-satellite-id': 'android-phone',
        'x-psfn-satellite-endpoint-id': 'missing',
        'x-psfn-satellite-session-id': 'walk-with-artie',
      },
    });
    expect(unknown).toMatchObject({
      ok: false,
      status: 403,
      type: 'satellite_claim_not_registered',
    });

    const unauthorized = resolveSatelliteClaim({
      registry,
      principal,
      headers: {
        'x-psfn-satellite-claim-type': 'voice-pi',
        'x-psfn-satellite-id': 'pi-voice',
        'x-psfn-satellite-endpoint-id': 'wyoming-voice',
        'x-psfn-satellite-session-id': 'kitchen',
        'x-psfn-satellite-capabilities': 'text,vision',
      },
    });
    expect(unauthorized).toMatchObject({
      ok: false,
      status: 403,
      type: 'satellite_capability_not_allowed',
    });
  });

  it('does not expand omitted telemetry scopes to the registry maximum', () => {
    const result = resolveSatelliteClaim({
      registry: exampleRegistry(),
      principal,
      headers: {
        'x-psfn-satellite-claim-type': 'voice-pi',
        'x-psfn-satellite-id': 'pi-voice',
        'x-psfn-satellite-endpoint-id': 'wyoming-voice',
        'x-psfn-satellite-session-id': 'kitchen',
        'x-psfn-satellite-capabilities': 'text,audio_input,speech_to_text,audio_output,text_to_speech',
      },
    });

    expect(result.ok && result.value.satellite.telemetryScopes).toEqual([]);
  });

  it('keeps future robotics out of effective capabilities until runtime policy enables it', () => {
    const registry = parseSatelliteRegistryConfig({
      schemaVersion: 1,
      enabled: true,
      satellites: [
        {
          satelliteId: 'future-bot',
          displayName: 'Future Bot',
          mobility: 'mobile',
          endpoints: [
            {
              endpointId: 'robotics',
              displayName: 'Robot Body',
              claimTypes: ['robotics-body'],
              promptChannelType: 'robotics_satellite',
              auth: { mode: 'api_key' },
              defaultIdentity: {
                authorId: 'primary-user',
                authorName: 'Primary User',
                canonicalContactId: 'contact-primary-user',
                channelPrivacy: 'private',
              },
              maxCapabilities: ['text', 'robotics'],
            },
          ],
        },
      ],
    });

    const result = resolveSatelliteClaim({
      registry,
      principal,
      headers: {
        'x-psfn-satellite-claim-type': 'robotics-body',
        'x-psfn-satellite-id': 'future-bot',
        'x-psfn-satellite-endpoint-id': 'robotics',
        'x-psfn-satellite-session-id': 'lab',
        'x-psfn-satellite-capabilities': 'text,robotics',
      },
    });

    expect(result.ok && result.value.satellite.capabilities.effective).toEqual(['text']);
    expect(result.ok && result.value.satellite.capabilities.policyDenied).toEqual(['robotics']);
  });
});
