import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { principalFromApiKeyToken, principalFromSatelliteApiKeyToken } from './http/auth.js';
import {
  loadSatelliteRegistryConfig,
  parseSatelliteRegistryConfig,
  resolveSatelliteConfigPull,
  resolveSatelliteClaim,
  saveSatelliteRegistryConfig,
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
        placeId: 'living_room',
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
            runtime: {
              schemaVersion: 1,
              transport: {
                mode: 'openhome_bridge',
              },
              audio: {
                inputDevice: 'plughw:1,0',
                outputDevice: 'default',
                sampleRateHz: 16000,
                channelCount: 1,
                frameMs: 20,
              },
              refresh: {
                intervalMs: 300000,
                jitterMs: 30000,
                restartPolicy: 'restart_on_runtime_change',
                restartGraceMs: 5000,
              },
            },
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
              channelPrivacy: 'invite_only',
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
              channelPrivacy: 'invite_only',
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
    expect(registry.satellites[0]?.endpoints[0]?.runtime).toMatchObject({
      schemaVersion: 1,
      transport: { mode: 'openhome_bridge' },
      audio: {
        inputDevice: 'plughw:1,0',
        sampleRateHz: 16000,
      },
      refresh: {
        intervalMs: 300000,
        restartPolicy: 'restart_on_runtime_change',
      },
    });
  });

  it('parses a static placeId binding and threads it onto routing metadata', () => {
    const registry = exampleRegistry();
    expect(registry.satellites[0]?.placeId).toBe('living_room');
    expect(registry.satellites[1]?.placeId).toBeUndefined();

    const result = resolveSatelliteClaim({
      registry,
      principal,
      headers: {
        'x-psfn-satellite-claim-type': 'voice-pi',
        'x-psfn-satellite-id': 'pi-voice',
        'x-psfn-satellite-endpoint-id': 'wyoming-voice',
        'x-psfn-satellite-session-id': 'kitchen',
        'x-psfn-satellite-capabilities': 'text,audio_input,speech_to_text,audio_output,text_to_speech',
      },
    });

    expect(result.ok && result.value.satellite.placeId).toBe('living_room');
    expect(result.ok && result.value.satellite.staticLocationLabel).toBe('kitchen');
  });

  it('omits placeId from routing metadata when the satellite declares no binding', () => {
    const result = resolveSatelliteClaim({
      registry: exampleRegistry(),
      principal,
      headers: {
        'x-psfn-satellite-claim-type': 'avatar-vision',
        'x-psfn-satellite-id': 'voxta-avatar',
        'x-psfn-satellite-endpoint-id': 'avatar-display',
        'x-psfn-satellite-session-id': 'lounge',
      },
    });

    expect(result.ok && 'placeId' in result.value.satellite).toBe(false);
  });

  it('rejects a malformed satellite placeId token', () => {
    expect(() => parseSatelliteRegistryConfig({
      schemaVersion: 1,
      enabled: true,
      satellites: [
        {
          satelliteId: 'bad-place',
          displayName: 'Bad Place Satellite',
          mobility: 'static',
          placeId: 'living room',
          endpoints: [
            {
              endpointId: 'voice',
              displayName: 'Voice Endpoint',
              claimTypes: ['voice-pi'],
              promptChannelType: 'voice_satellite',
              auth: { mode: 'api_key' },
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
    })).toThrow('placeId');
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

  it('rejects malformed runtime pull config', () => {
    expect(() => parseSatelliteRegistryConfig({
      schemaVersion: 1,
      enabled: true,
      satellites: [
        {
          satelliteId: 'bad-runtime',
          displayName: 'Bad Runtime Satellite',
          mobility: 'static',
          endpoints: [
            {
              endpointId: 'voice',
              displayName: 'Voice Endpoint',
              claimTypes: ['voice-pi'],
              promptChannelType: 'voice_satellite',
              auth: { mode: 'api_key' },
              defaultIdentity: {
                authorId: 'primary-user',
                authorName: 'Primary User',
                canonicalContactId: 'contact-primary-user',
                channelPrivacy: 'private',
              },
              maxCapabilities: ['text'],
              runtime: {
                schemaVersion: 1,
                transport: {
                  mode: 'http_chat_completions',
                },
                refresh: {
                  intervalMs: 300000,
                  jitterMs: 300000,
                  restartPolicy: 'manual',
                },
              },
            },
          ],
        },
      ],
    })).toThrow('chatCompletionsPath must be configured');
  });

  it('builds sanitized satellite config pulls from registered runtime config', () => {
    const registry = exampleRegistry();
    const result = resolveSatelliteConfigPull({
      registry,
      principal,
      headers: {},
      satelliteId: 'pi-voice',
      endpointId: 'wyoming-voice',
      claimType: 'voice-pi',
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        object: 'companion.satellite_config',
        schemaVersion: 1,
        satellite: {
          satelliteId: 'pi-voice',
          displayName: 'Kitchen Voice Pi',
          mobility: 'static',
          staticLocationLabel: 'kitchen',
        },
        endpoint: {
          endpointId: 'wyoming-voice',
          claimType: 'voice-pi',
          claimTypes: ['voice-pi'],
        },
        identity: {
          authorId: 'primary-user',
          canonicalContactId: 'contact-primary-user',
        },
        session: {
          channelType: 'api',
          routingSource: 'satellite',
          channelIdTemplate: 'satellite:voice-pi:{sessionId}',
          fixedHeaders: {
            claimType: 'voice-pi',
            satelliteId: 'pi-voice',
            endpointId: 'wyoming-voice',
          },
        },
        capabilities: {
          registryMax: ['text', 'audio_input', 'speech_to_text', 'audio_output', 'text_to_speech'],
          runtimeEnabled: ['text', 'audio_input', 'speech_to_text', 'audio_output', 'text_to_speech'],
          policyDenied: [],
        },
        auth: {
          mode: 'api_key',
          principalId: principal.id,
          certBound: false,
        },
        runtime: {
          transport: { mode: 'openhome_bridge' },
          audio: {
            inputDevice: 'plughw:1,0',
            outputDevice: 'default',
          },
          refresh: {
            intervalMs: 300000,
            restartPolicy: 'restart_on_runtime_change',
          },
        },
      },
    });
    expect(result.ok && result.value.configVersion).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(result)).not.toContain('clientCertFingerprintSha256');
    expect(JSON.stringify(result)).not.toContain('apiKeyPrincipalIds');
  });

  it('fails closed for unauthorized and unconfigured config pulls', () => {
    const restrictedRegistry = exampleRegistry({
      satellites: [
        {
          satelliteId: 'restricted',
          displayName: 'Restricted Satellite',
          mobility: 'static',
          endpoints: [
            {
              endpointId: 'voice',
              displayName: 'Voice Endpoint',
              claimTypes: ['voice-pi'],
              promptChannelType: 'voice_satellite',
              auth: { mode: 'api_key', apiKeyPrincipalIds: ['api-key-other'] },
              defaultIdentity: {
                authorId: 'primary-user',
                authorName: 'Primary User',
                canonicalContactId: 'contact-primary-user',
                channelPrivacy: 'private',
              },
              maxCapabilities: ['text'],
              runtime: {
                schemaVersion: 1,
                transport: { mode: 'openhome_bridge' },
                refresh: {
                  intervalMs: 300000,
                  restartPolicy: 'manual',
                },
              },
            },
            {
              endpointId: 'missing-runtime',
              displayName: 'Missing Runtime Endpoint',
              claimTypes: ['missing-runtime'],
              promptChannelType: 'voice_satellite',
              auth: { mode: 'api_key' },
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
    });

    expect(resolveSatelliteConfigPull({
      registry: restrictedRegistry,
      principal,
      headers: {},
      satelliteId: 'restricted',
      endpointId: 'voice',
      claimType: 'voice-pi',
    })).toMatchObject({
      ok: false,
      status: 403,
      type: 'satellite_principal_not_allowed',
    });

    expect(resolveSatelliteConfigPull({
      registry: restrictedRegistry,
      principal,
      headers: {},
      satelliteId: 'restricted',
      endpointId: 'missing-runtime',
      claimType: 'missing-runtime',
    })).toMatchObject({
      ok: false,
      status: 503,
      type: 'satellite_runtime_config_not_configured',
    });
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

describe('saveSatelliteRegistryConfig', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'psfn-sat-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('round-trips a registry through save then load', () => {
    const registry = exampleRegistry();
    saveSatelliteRegistryConfig(dataDir, registry);
    const reloaded = loadSatelliteRegistryConfig(dataDir);
    expect(reloaded).toEqual(registry);
  });

  it('re-loads cleanly even when an endpoint has no telemetry scopes', () => {
    const registry = exampleRegistry({
      satellites: [
        {
          satelliteId: 'pi-min',
          displayName: 'Minimal Pi',
          mobility: 'static',
          endpoints: [
            {
              endpointId: 'ep-min',
              displayName: 'Minimal Endpoint',
              claimTypes: ['voice-min'],
              promptChannelType: 'voice_satellite',
              auth: { mode: 'api_key' },
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
    });
    // A parsed endpoint carries telemetryScopes: [] which the parser rejects on
    // re-parse; the save path must emit a re-loadable wire form.
    expect(() => saveSatelliteRegistryConfig(dataDir, registry)).not.toThrow();
    expect(loadSatelliteRegistryConfig(dataDir)).toEqual(registry);
  });

  it('persists a changed placeId binding', () => {
    const registry = exampleRegistry();
    const next = {
      ...registry,
      satellites: registry.satellites.map(satellite => ({ ...satellite, placeId: 'kitchen' })),
    };
    saveSatelliteRegistryConfig(dataDir, next);
    const reloaded = loadSatelliteRegistryConfig(dataDir);
    expect(reloaded.satellites[0]?.placeId).toBe('kitchen');
  });
});

// ── Sprint-10 C1: mTLS binding must come from an authenticated source ──

describe('satellite mTLS authentication (Sprint-10 C1)', () => {
  const FINGERPRINT = 'a1'.repeat(32);
  const SPKI = 'b2'.repeat(32);
  const SUBJECT = 'CN=pi-voice, O=PSFN';

  function mtlsRegistry(auth: Record<string, unknown>) {
    return parseSatelliteRegistryConfig({
      schemaVersion: 1,
      enabled: true,
      satellites: [
        {
          satelliteId: 'pi-voice',
          displayName: 'Kitchen Voice Pi',
          mobility: 'static',
          endpoints: [
            {
              endpointId: 'wyoming-voice',
              displayName: 'Wyoming Voice Endpoint',
              claimTypes: ['voice-pi'],
              promptChannelType: 'voice_satellite',
              auth: { mode: 'mtls', ...auth },
              defaultIdentity: {
                authorId: 'primary-user',
                authorName: 'Primary User',
                canonicalContactId: 'contact-primary-user',
                channelPrivacy: 'private',
              },
              maxCapabilities: ['text'],
              runtime: {
                schemaVersion: 1,
                transport: { mode: 'openhome_bridge' },
                refresh: { intervalMs: 300000, restartPolicy: 'manual' },
              },
            },
          ],
        },
      ],
    });
  }

  const claimHeaders = {
    'x-psfn-satellite-claim-type': 'voice-pi',
    'x-psfn-satellite-id': 'pi-voice',
    'x-psfn-satellite-endpoint-id': 'wyoming-voice',
    'x-psfn-satellite-session-id': 'kitchen',
  };

  it('REJECTS a claim presenting only X-PSFN-Client-Cert-* request headers (no authenticated cert)', () => {
    const registry = mtlsRegistry({ clientCertFingerprintSha256: FINGERPRINT });
    // Attacker replays the (public) fingerprint as plain headers; no TLS peer
    // cert and no trusted proxy means no clientCert identity is derived.
    const result = resolveSatelliteClaim({
      registry,
      principal,
      headers: {
        ...claimHeaders,
        'x-psfn-client-cert-fingerprint-sha256': FINGERPRINT,
        'x-psfn-client-cert-subject': SUBJECT,
      },
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.status).toBe(403);
    expect(!result.ok && result.type).toBe('satellite_client_certificate_required');
  });

  it('REJECTS config pulls presenting only cert headers', () => {
    const registry = mtlsRegistry({ clientCertFingerprintSha256: FINGERPRINT });
    const result = resolveSatelliteConfigPull({
      registry,
      principal,
      satelliteId: 'pi-voice',
      endpointId: 'wyoming-voice',
      claimType: 'voice-pi',
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.type).toBe('satellite_client_certificate_required');
  });

  it('requires ALL configured cert attributes to match: single-attribute match does not pass', () => {
    const registry = mtlsRegistry({
      clientCertFingerprintSha256: FINGERPRINT,
      clientCertSubject: SUBJECT,
    });

    // Fingerprint matches, subject missing → rejected.
    const missingSubject = resolveSatelliteClaim({
      registry,
      principal,
      headers: claimHeaders,
      clientCert: { source: 'tls_peer', fingerprintSha256: FINGERPRINT },
    });
    expect(missingSubject.ok).toBe(false);
    expect(!missingSubject.ok && missingSubject.type).toBe('satellite_certificate_not_allowed');
    expect(!missingSubject.ok && missingSubject.message).toContain('clientCertSubject');

    // Fingerprint matches, subject mismatched → rejected.
    const wrongSubject = resolveSatelliteClaim({
      registry,
      principal,
      headers: claimHeaders,
      clientCert: { source: 'tls_peer', fingerprintSha256: FINGERPRINT, subject: 'CN=evil' },
    });
    expect(wrongSubject.ok).toBe(false);
    expect(!wrongSubject.ok && wrongSubject.type).toBe('satellite_certificate_not_allowed');

    // All configured attributes match → allowed.
    const allMatch = resolveSatelliteClaim({
      registry,
      principal,
      headers: claimHeaders,
      clientCert: { source: 'tls_peer', fingerprintSha256: FINGERPRINT, subject: SUBJECT },
    });
    expect(allMatch.ok).toBe(true);
    expect(allMatch.ok && allMatch.value.satellite.auth.certBound).toBe(true);
  });

  it('accepts a trusted-proxy-derived identity matching all bindings', () => {
    const registry = mtlsRegistry({
      clientCertFingerprintSha256: FINGERPRINT,
      clientCertSpkiSha256: SPKI,
    });
    const result = resolveSatelliteConfigPull({
      registry,
      principal,
      satelliteId: 'pi-voice',
      endpointId: 'wyoming-voice',
      claimType: 'voice-pi',
      clientCert: { source: 'trusted_proxy', fingerprintSha256: FINGERPRINT, spkiSha256: SPKI },
    });
    expect(result.ok).toBe(true);
  });
});

// ── Sprint-10 H4: per-endpoint credentials must isolate endpoints ──

describe('satellite per-endpoint credential isolation (Sprint-10 H4)', () => {
  const keyA = 'satellite-key-alpha-0001';
  const keyB = 'satellite-key-beta-0002';
  const principalA = principalFromSatelliteApiKeyToken(keyA);
  const principalB = principalFromSatelliteApiKeyToken(keyB);

  function twoEndpointRegistry() {
    return parseSatelliteRegistryConfig({
      schemaVersion: 1,
      enabled: true,
      satellites: [
        {
          satelliteId: 'sat-a',
          displayName: 'Satellite A',
          mobility: 'static',
          endpoints: [
            {
              endpointId: 'endpoint-a',
              displayName: 'Endpoint A',
              claimTypes: ['claim-a'],
              promptChannelType: 'voice_satellite',
              auth: { mode: 'api_key', apiKeyPrincipalIds: [principalA.id] },
              defaultIdentity: {
                authorId: 'user-a',
                authorName: 'User A',
                canonicalContactId: 'contact-a',
                channelPrivacy: 'private',
              },
              maxCapabilities: ['text'],
            },
          ],
        },
        {
          satelliteId: 'sat-b',
          displayName: 'Satellite B',
          mobility: 'static',
          endpoints: [
            {
              endpointId: 'endpoint-b',
              displayName: 'Endpoint B',
              claimTypes: ['claim-b'],
              promptChannelType: 'voice_satellite',
              auth: { mode: 'api_key', apiKeyPrincipalIds: [principalB.id] },
              defaultIdentity: {
                authorId: 'user-b',
                authorName: 'User B',
                canonicalContactId: 'contact-b',
                channelPrivacy: 'private',
              },
              maxCapabilities: ['text'],
            },
          ],
        },
      ],
    });
  }

  function headersFor(satelliteId: string, endpointId: string, claimType: string) {
    return {
      'x-psfn-satellite-claim-type': claimType,
      'x-psfn-satellite-id': satelliteId,
      'x-psfn-satellite-endpoint-id': endpointId,
      'x-psfn-satellite-session-id': 'session-1',
    };
  }

  it('derives DISTINCT principal ids from distinct satellite keys', () => {
    expect(principalA.id).not.toBe(principalB.id);
    expect(principalA.scope).toBe('satellite');
  });

  it('admits each key only on its own endpoint; header swap cannot impersonate the other endpoint', () => {
    const registry = twoEndpointRegistry();

    const ownEndpoint = resolveSatelliteClaim({
      registry,
      principal: principalA,
      headers: headersFor('sat-a', 'endpoint-a', 'claim-a'),
    });
    expect(ownEndpoint.ok).toBe(true);
    expect(ownEndpoint.ok && ownEndpoint.value.authorId).toBe('user-a');

    // Key A holder swaps the satellite headers to claim endpoint B's
    // defaultIdentity → rejected.
    const impersonation = resolveSatelliteClaim({
      registry,
      principal: principalA,
      headers: headersFor('sat-b', 'endpoint-b', 'claim-b'),
    });
    expect(impersonation.ok).toBe(false);
    expect(!impersonation.ok && impersonation.type).toBe('satellite_principal_not_allowed');
  });

  it('never admits satellite-scoped principals on endpoints without an explicit principal allowlist', () => {
    const registry = parseSatelliteRegistryConfig({
      schemaVersion: 1,
      enabled: true,
      satellites: [
        {
          satelliteId: 'open-sat',
          displayName: 'Open Satellite',
          mobility: 'static',
          endpoints: [
            {
              endpointId: 'open-endpoint',
              displayName: 'Open Endpoint',
              claimTypes: ['open-claim'],
              promptChannelType: 'voice_satellite',
              auth: { mode: 'api_key' },
              defaultIdentity: {
                authorId: 'user-open',
                authorName: 'User Open',
                canonicalContactId: 'contact-open',
                channelPrivacy: 'private',
              },
              maxCapabilities: ['text'],
            },
          ],
        },
      ],
    });

    const result = resolveSatelliteClaim({
      registry,
      principal: principalA,
      headers: headersFor('open-sat', 'open-endpoint', 'open-claim'),
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.type).toBe('satellite_principal_not_allowed');

    // The shared operator key (general scope) still passes endpoints without
    // an allowlist — pre-existing behavior for single-key deployments.
    const sharedKey = resolveSatelliteClaim({
      registry,
      principal,
      headers: headersFor('open-sat', 'open-endpoint', 'open-claim'),
    });
    expect(sharedKey.ok).toBe(true);
  });
});
