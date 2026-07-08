import { describe, expect, it } from 'vitest';
import {
  buildStructuredToolErrorDetails,
  classifyToolError,
  sanitizeToolErrorDiagnostic,
  textResultFromError,
  textResultWithError,
  type ToolErrorClass,
} from './results.js';

describe('structured tool error results', () => {
  it('preserves the legacy isError-only shape unless metadata is requested', () => {
    expect(textResultWithError('plain failure', true).details).toEqual({ isError: true });
    expect(textResultWithError('not a failure', false).details).toEqual({ isError: undefined });
  });

  it('returns stable companion-readable metadata when requested', () => {
    const result = textResultWithError('provider failed', true, {
      errorClass: 'rate_limited',
      companionMessage: 'Provider rate limit reached.',
      rawDiagnostic: 'HTTP 429 too many requests',
    });

    expect(result.details).toEqual({
      isError: true,
      errorClass: 'rate_limited',
      retryHint: 'retry_after_delay',
      retryable: true,
      companionMessage: 'Provider rate limit reached.',
      rawDiagnostic: 'HTTP 429 too many requests',
    });
  });

  it.each([
    ['permission_denied', 'operator_escalation', false],
    ['policy_blocked', 'try_alternative_input', false],
    ['rate_limited', 'retry_after_delay', true],
    ['timeout', 'retry_after_delay', true],
    ['invalid_input', 'try_alternative_input', false],
    ['provider_error', 'retry_with_backoff', true],
    ['unavailable', 'retry_with_backoff', true],
  ] as const)('maps %s to retry guidance', (errorClass, retryHint, retryable) => {
    const details = buildStructuredToolErrorDetails({
      errorClass,
      rawDiagnostic: `${errorClass} diagnostic`,
    });

    expect(details).toMatchObject({
      isError: true,
      errorClass,
      retryHint,
      retryable,
    });
  });

  it.each([
    [{ code: -32000, message: 'approval required' }, 'permission_denied'],
    [{ code: -32002, message: 'URL blocked: resolved address is cloud metadata' }, 'policy_blocked'],
    [{ code: -32003, message: 'HTTP 429 too many requests' }, 'rate_limited'],
    [{ code: -32003, message: 'Request timed out after 5000ms' }, 'timeout'],
    [{ code: -32003, message: 'Fetch failed: 503 Service Unavailable' }, 'unavailable'],
    [{ code: -32003, message: 'Fetch failed: bad upstream response' }, 'provider_error'],
    [new Error('target is required.'), 'invalid_input'],
  ] as Array<[unknown, ToolErrorClass]>)('classifies %j as %s', (error, expectedClass) => {
    expect(classifyToolError(error)).toBe(expectedClass);
  });

  it('builds a text result from an unknown error without exposing raw diagnostics in content', () => {
    const result = textResultFromError('web failed', {
      code: -32002,
      message: 'URL blocked: resolved address is cloud metadata for http://169.254.169.254/latest',
    });

    expect(result.content).toEqual([{
      type: 'text',
      text: expect.stringContaining('web failed: Blocked by runtime policy'),
    }]);
    expect(result.details).toMatchObject({
      isError: true,
      errorClass: 'policy_blocked',
      retryHint: 'try_alternative_input',
      retryable: false,
    });
  });

  it('redacts sensitive diagnostics and bounds rawDiagnostic length', () => {
    const longSecret = 'a'.repeat(80);
    const raw = [
      'failed reading /home/ada/psfn-framework/.env',
      'OPENAI_API_KEY=sk-secret',
      `Authorization: Bearer ${longSecret}`,
      'url=https://user:password@example.com/callback?api_key=secret&q=ok#token=secret',
      `jwt=eyJ${'b'.repeat(20)}.${'c'.repeat(20)}.${'d'.repeat(20)}`,
      'tail '.repeat(200),
    ].join(' | ');

    const diagnostic = sanitizeToolErrorDiagnostic(raw);

    expect(diagnostic).toBeDefined();
    expect(diagnostic?.length).toBeLessThanOrEqual(512);
    expect(diagnostic).not.toContain('/home/ada');
    expect(diagnostic).not.toContain('OPENAI_API_KEY');
    expect(diagnostic).not.toContain('sk-secret');
    expect(diagnostic).not.toContain(longSecret);
    expect(diagnostic).not.toContain('user:password');
    expect(diagnostic).not.toContain('api_key=secret');
    expect(diagnostic).not.toContain('jwt=eyJ');
    expect(diagnostic).toContain('[path]');
    expect(diagnostic).toContain('[env]');
    expect(diagnostic).toContain('api_key=[redacted]');
    expect(diagnostic).toContain('[truncated]');
  });
});
