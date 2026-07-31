import { describe, expect, it } from 'vitest';
import {
  isDiagnosticSecretKey,
  redactSecretsInText,
  redactSecretsInValue,
} from './redaction.js';

describe('shared secret redaction', () => {
  it('recognizes compound diagnostic keys without broadening generic diagnostics', () => {
    expect(isDiagnosticSecretKey('openaiApiKey')).toBe(true);
    expect(isDiagnosticSecretKey('db_password_file')).toBe(true);
    expect(isDiagnosticSecretKey('initiation_permit')).toBe(true);
    expect(isDiagnosticSecretKey('roleGrantId')).toBe(true);
    expect(isDiagnosticSecretKey('grant_digest')).toBe(true);
    expect(isDiagnosticSecretKey('csrfToken')).toBe(true);
    expect(isDiagnosticSecretKey('x-psfn-csrf')).toBe(true);
    expect(isDiagnosticSecretKey('x-psfn-escalation-grant')).toBe(true);
    expect(isDiagnosticSecretKey('code')).toBe(false);
    expect(isDiagnosticSecretKey('sessionId')).toBe(false);
    expect(isDiagnosticSecretKey('permitOutcome')).toBe(false);
    expect(isDiagnosticSecretKey('permittedDestinations')).toBe(false);
    expect(isDiagnosticSecretKey('escalationDecision')).toBe(false);
  });

  it('redacts secret-shaped text without truncating safe forensic content', () => {
    const safe = 'x'.repeat(400);
    expect(redactSecretsInText(safe)).toBe(safe);
    expect(redactSecretsInText('Bearer abc.def.ghi')).toBe('Bearer [REDACTED_SECRET]');
    expect(redactSecretsInText('ghp_1234567890abcdef')).toBe('[REDACTED_SECRET]');
  });

  it('recursively redacts secret keys and secret-shaped generic values', () => {
    expect(redactSecretsInValue({
      action: 'connect',
      openaiApiKey: 'sk-live-compound-secret',
      code: 'oauth-secret-code',
      nested: {
        header: 'Bearer nested-value-secret',
        value: 'ghp_1234567890abcdef',
        safe: 'keep-me',
      },
    })).toEqual({
      action: 'connect',
      openaiApiKey: '[REDACTED_SECRET]',
      code: '[REDACTED_SECRET]',
      nested: {
        header: 'Bearer [REDACTED_SECRET]',
        value: '[REDACTED_SECRET]',
        safe: 'keep-me',
      },
    });
  });
});
