import { describe, expect, it } from 'vitest';
import {
  INSECURE_LOCAL_API_PRINCIPAL,
  principalFromApiKeyToken,
} from '../http/auth.js';
import { resolveApiTurnIdentity } from './external-channel-claim.js';

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
          channelPrivacy: 'semi_private',
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
        channelPrivacy: 'semi_private',
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
