import { describe, expect, it } from 'vitest';
import {
  INSECURE_LOCAL_API_PRINCIPAL,
  principalFromApiKeyToken,
  principalFromSatelliteApiKeyToken,
} from '../backplane/http/auth.js';
import { parseSatelliteRegistryConfig } from '../backplane/satellite-registry.js';
import { resolveApiTurnIdentity } from './external-channel-claim.js';

const satelliteRegistry = parseSatelliteRegistryConfig({
  schemaVersion: 1,
  enabled: true,
  satellites: [
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
          ],
          telemetryScopes: ['presence'],
        },
      ],
    },
  ],
});

describe('resolveApiTurnIdentity', () => {
  it('returns the default API identity when no external claim headers are present', () => {
    const result = resolveApiTurnIdentity({
      headers: {},
      principal: principalFromApiKeyToken('test-secret-key'),
      defaultChannelId: 'api:principal:session-1',
      defaultAuthorId: 'principal',
      defaultAuthorName: 'API Principal',
    });

    expect(result).toEqual({
      ok: true,
      value: {
        channelId: 'api:principal:session-1',
        channelType: 'api',
        authorId: 'principal',
        authorName: 'API Principal',
        source: 'api',
      },
    });
  });

  it('accepts authenticated registry-backed satellite claims without adding a channel type constant', () => {
    const result = resolveApiTurnIdentity({
      headers: {
        'x-psfn-satellite-claim-type': 'android-mobile',
        'x-psfn-satellite-id': 'android-phone',
        'x-psfn-satellite-endpoint-id': 'companion-app',
        'x-psfn-satellite-session-id': 'weekend-walk',
        'x-psfn-satellite-capabilities': 'text,audio_input,speech_to_text,audio_output,text_to_speech,vision',
      },
      principal: principalFromApiKeyToken('test-secret-key'),
      defaultChannelId: 'api:principal:session-1',
      defaultAuthorId: 'principal',
      defaultAuthorName: 'API Principal',
      satelliteRegistry,
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        channelId: 'satellite:android-mobile:weekend-walk',
        channelType: 'api',
        authorId: 'primary-user',
        authorName: 'Primary User',
        source: 'satellite',
        canonicalContactId: 'contact-primary-user',
        channelPrivacy: 'private',
      },
    });
    expect(result.ok && result.value.satellite?.capabilities.effective).toEqual([
      'text',
      'audio_input',
      'speech_to_text',
      'audio_output',
      'text_to_speech',
      'vision',
    ]);
  });

  it('fails closed for unregistered satellite claims', () => {
    const result = resolveApiTurnIdentity({
      headers: {
        'x-psfn-satellite-claim-type': 'android-mobile',
        'x-psfn-satellite-id': 'android-phone',
        'x-psfn-satellite-endpoint-id': 'missing',
        'x-psfn-satellite-session-id': 'weekend-walk',
      },
      principal: principalFromApiKeyToken('test-secret-key'),
      defaultChannelId: 'api:principal:session-1',
      defaultAuthorId: 'principal',
      defaultAuthorName: 'API Principal',
      satelliteRegistry,
    });

    expect(result).toEqual({
      ok: false,
      status: 403,
      type: 'satellite_claim_not_registered',
      message: 'Satellite claim is not registered for this satellite endpoint',
    });
  });

  it('accepts authenticated psfn-amica claims', () => {
    const result = resolveApiTurnIdentity({
      headers: {
        'x-psfn-channel-type': 'psfn-amica',
        'x-psfn-channel-id': 'psfn-amica:test:display',
        'x-psfn-author-id': 'primary-user',
        'x-psfn-author-name': 'Primary User',
      },
      principal: principalFromApiKeyToken('test-secret-key'),
      defaultChannelId: 'api:principal:session-1',
      defaultAuthorId: 'principal',
      defaultAuthorName: 'API Principal',
    });

    expect(result).toEqual({
      ok: true,
      value: {
        channelId: 'psfn-amica:test:display',
        channelType: 'psfn-amica',
        authorId: 'primary-user',
        authorName: 'Primary User',
        source: 'psfn-amica',
      },
    });
  });

  it('applies psfn-amica default identity metadata when the claim omits user headers', () => {
    const result = resolveApiTurnIdentity({
      headers: {
        'x-psfn-channel-type': 'psfn-amica',
        'x-psfn-channel-id': 'psfn-amica:test:display',
      },
      principal: principalFromApiKeyToken('test-secret-key'),
      defaultChannelId: 'api:principal:session-1',
      defaultAuthorId: 'principal',
      defaultAuthorName: 'API Principal',
      externalChannelProfiles: {
        'psfn-amica': {
          authorId: 'primary-user',
          authorName: 'Primary User',
          canonicalContactId: 'contact-primary-user',
          channelPrivacy: 'invite_only',
        },
      },
    });

    expect(result).toEqual({
      ok: true,
      value: {
        channelId: 'psfn-amica:test:display',
        channelType: 'psfn-amica',
        authorId: 'primary-user',
        authorName: 'Primary User',
        source: 'psfn-amica',
        canonicalContactId: 'contact-primary-user',
        channelPrivacy: 'invite_only',
      },
    });
  });

  it('rejects incomplete claims', () => {
    const result = resolveApiTurnIdentity({
      headers: {
        'x-psfn-channel-type': 'psfn-amica',
      },
      principal: principalFromApiKeyToken('test-secret-key'),
      defaultChannelId: 'api:principal:session-1',
      defaultAuthorId: 'principal',
      defaultAuthorName: 'API Principal',
    });

    expect(result).toEqual({
      ok: false,
      status: 400,
      type: 'invalid_request',
      message: 'X-PSFN-Channel-ID and X-PSFN-Channel-Type must be provided together',
    });
  });

  it('rejects psfn-amica claims without configured identity metadata or explicit author headers', () => {
    const result = resolveApiTurnIdentity({
      headers: {
        'x-psfn-channel-type': 'psfn-amica',
        'x-psfn-channel-id': 'psfn-amica:test:display',
      },
      principal: principalFromApiKeyToken('test-secret-key'),
      defaultChannelId: 'api:principal:session-1',
      defaultAuthorId: 'principal',
      defaultAuthorName: 'API Principal',
    });

    expect(result).toEqual({
      ok: false,
      status: 503,
      type: 'external_channel_not_configured',
      message: 'PSFN Amica claims require configured identity metadata or explicit author headers',
    });
  });

  it('rejects external claims for insecure local principals', () => {
    const result = resolveApiTurnIdentity({
      headers: {
        'x-psfn-channel-type': 'psfn-amica',
        'x-psfn-channel-id': 'psfn-amica:test:display',
      },
      principal: INSECURE_LOCAL_API_PRINCIPAL,
      defaultChannelId: 'api:local-insecure:session-1',
      defaultAuthorId: 'local-insecure',
      defaultAuthorName: 'Local API Principal',
    });

    expect(result).toEqual({
      ok: false,
      status: 403,
      type: 'external_channel_claim_requires_api_key',
      message: 'External channel claims require API key authentication',
    });
  });
});

describe('satellite-scoped principals (Sprint-10 H4)', () => {
  it('rejects satellite-scoped principals that do not present a satellite claim', () => {
    const result = resolveApiTurnIdentity({
      headers: {},
      principal: principalFromSatelliteApiKeyToken('satellite-key-alpha-0001'),
      defaultChannelId: 'api:default',
      defaultAuthorId: 'api-user',
      defaultAuthorName: 'API User',
      satelliteRegistry,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.status).toBe(403);
    expect(!result.ok && result.type).toBe('satellite_scoped_principal_requires_satellite_claim');
  });

  it('rejects satellite-scoped principals presenting an external channel claim instead of a satellite claim', () => {
    const result = resolveApiTurnIdentity({
      headers: {
        'x-psfn-channel-type': 'psfn-amica',
        'x-psfn-channel-id': 'psfn-amica:test:display',
      },
      principal: principalFromSatelliteApiKeyToken('satellite-key-alpha-0001'),
      defaultChannelId: 'api:default',
      defaultAuthorId: 'api-user',
      defaultAuthorName: 'API User',
      satelliteRegistry,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.type).toBe('satellite_scoped_principal_requires_satellite_claim');
  });
});
