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

  it('accepts authenticated openhome claims', () => {
    const result = resolveApiTurnIdentity({
      headers: {
        'x-psfn-channel-type': 'openhome',
        'x-psfn-channel-id': 'openhome:lab:pi5-display',
        'x-psfn-author-id': 'openhome-user:owner',
        'x-psfn-author-name': 'Lab Satellite',
      },
      principal: principalFromApiKeyToken('test-secret-key'),
      defaultChannelId: 'api:principal:session-1',
      defaultAuthorId: 'principal',
      defaultAuthorName: 'API Principal',
    });

    expect(result).toEqual({
      ok: true,
      value: {
        channelId: 'openhome:lab:pi5-display',
        channelType: 'openhome',
        authorId: 'openhome-user:owner',
        authorName: 'Lab Satellite',
        source: 'openhome',
      },
    });
  });

  it('rejects incomplete claims', () => {
    const result = resolveApiTurnIdentity({
      headers: {
        'x-psfn-channel-type': 'openhome',
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

  it('rejects external claims for insecure local principals', () => {
    const result = resolveApiTurnIdentity({
      headers: {
        'x-psfn-channel-type': 'openhome',
        'x-psfn-channel-id': 'openhome:lab:pi5-display',
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
