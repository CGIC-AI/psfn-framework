import { describe, expect, it } from 'vitest';
import {
  buildStructuredToolErrorDetails,
  classifyToolError,
  CompanionVisibleOperationalError,
  INTERNAL_TOOL_FAILURE_NOTICE,
  internalToolFailureResult,
  sanitizeToolErrorDiagnostic,
  textResultFromError,
  textResultWithError,
  type ToolErrorClass,
} from './results.js';
import { classifyExecutedToolCallOutcome } from '../../shared/contracts/tool-call-outcome.js';

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
      classSource: 'declared',
      retryHint: 'retry_after_delay',
      retryable: true,
      companionMessage: 'Provider rate limit reached.',
      rawDiagnostic: 'HTTP 429 too many requests',
    });
  });

  it('preserves a gateway JSON-RPC code as structured non-secret evidence', () => {
    const details = buildStructuredToolErrorDetails({
      cause: { code: -32000, message: 'approval required' },
    });

    expect(details).toMatchObject({
      isError: true,
      errorClass: 'permission_denied',
      gatewayErrorCode: -32000,
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

  it('shows allowlisted capacity, health, rate-limit, and capability blocks but withholds invariants', () => {
    const visibleFailures = [
      new CompanionVisibleOperationalError({
        companionMessage: 'Shard limit reached (3 concurrent). Wait for active shards to complete.',
        errorClass: 'unavailable',
        retryHint: 'retry_after_delay',
      }),
      new CompanionVisibleOperationalError({
        companionMessage: 'Shard routing denied: "research" is offline.',
        errorClass: 'unavailable',
        retryHint: 'retry_after_delay',
      }),
      new CompanionVisibleOperationalError({
        companionMessage:
          'Shard routing denied: "research" is missing required capability tokens (web.read).',
        errorClass: 'policy_blocked',
        retryHint: 'try_alternative_input',
      }),
      new CompanionVisibleOperationalError({
        companionMessage: 'Shard launch denied: the parent capability grant lacks shard.spawn.',
        errorClass: 'policy_blocked',
        retryHint: 'try_alternative_input',
      }),
    ];

    for (const error of visibleFailures) {
      expect(internalToolFailureResult(error).content[0]?.text).toContain(error.companionMessage);
    }

    const rateLimit = internalToolFailureResult({
      status: 429,
      message: 'HTTP 429 for alice@example.test while processing private-correlation-id',
    });
    expect(rateLimit.content[0]?.text).toContain('Provider rate limit reached');
    expect(rateLimit.content[0]?.text).not.toContain('alice@example.test');

    for (const message of [
      'SessionManager captured owner mismatch at /home/operator/private',
      'SessionManager owner invariant failed for partner record 429: alice@example.test',
      'Shard routing denied: "research" is offline (private-correlation-id alice@example.test).',
    ]) {
      const invariant = internalToolFailureResult(new Error(message));
      expect(invariant.content[0]?.text).toBe(INTERNAL_TOOL_FAILURE_NOTICE);
      expect(invariant.content[0]?.text).not.toContain('alice@example.test');
    }
  });

  it('marks free-text-derived error classes as inferred and structured ones as declared (bead sqsz)', () => {
    // Returned runtime failure whose text merely contains a validation keyword.
    const inferred = buildStructuredToolErrorDetails({ cause: new Error('Missing required field: target') });
    expect(inferred).toMatchObject({ errorClass: 'invalid_input', classSource: 'inferred' });

    // Free-text policy keyword on a returned upstream error is still inferred.
    const inferredPolicy = buildStructuredToolErrorDetails({ cause: new Error('403 Forbidden from upstream') });
    expect(inferredPolicy).toMatchObject({ errorClass: 'policy_blocked', classSource: 'inferred' });

    // Explicit caller-supplied class is declared.
    const declared = buildStructuredToolErrorDetails({ errorClass: 'policy_blocked', cause: new Error('nope') });
    expect(declared).toMatchObject({ errorClass: 'policy_blocked', classSource: 'declared' });

    // A structured gateway policy-denied code is declared.
    const gateway = buildStructuredToolErrorDetails({ cause: { code: -32002, message: 'URL blocked by policy' } });
    expect(gateway).toMatchObject({ errorClass: 'policy_blocked', classSource: 'declared' });
  });

  it('redacts sensitive diagnostics and bounds rawDiagnostic length', () => {
    const longSecret = 'a'.repeat(80);
    const raw = [
      'failed reading /home/user/psfn-framework/.env',
      'OPENAI_API_KEY=sk-secret',
      `Authorization: Bearer ${longSecret}`,
      'url=https://user:password@example.com/callback?api_key=secret&q=ok#token=secret',
      `jwt=eyJ${'b'.repeat(20)}.${'c'.repeat(20)}.${'d'.repeat(20)}`,
      'tail '.repeat(200),
    ].join(' | ');

    const diagnostic = sanitizeToolErrorDiagnostic(raw);

    expect(diagnostic).toBeDefined();
    expect(diagnostic?.length).toBeLessThanOrEqual(512);
    expect(diagnostic).not.toContain('/home/user');
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

describe('classifyExecutedToolCallOutcome — inferred vs declared classes (bead sqsz)', () => {
  it('keeps a returned failure with an inferred invalid_input class as an execution failure', () => {
    expect(classifyExecutedToolCallOutcome({
      details: { isError: true, errorClass: 'invalid_input', classSource: 'inferred' },
      isError: true,
    })).toBe('execution_failure');
  });

  it('keeps a returned failure with an inferred policy_blocked class as an execution failure', () => {
    expect(classifyExecutedToolCallOutcome({
      details: { isError: true, errorClass: 'policy_blocked', classSource: 'inferred' },
      isError: true,
    })).toBe('execution_failure');
  });

  it('classifies a declared validation rejection as validation_rejection', () => {
    expect(classifyExecutedToolCallOutcome({
      details: { isError: true, errorClass: 'invalid_input', classSource: 'declared' },
      isError: true,
    })).toBe('validation_rejection');
  });

  it('classifies a declared policy denial as policy_denial', () => {
    expect(classifyExecutedToolCallOutcome({
      details: { isError: true, errorClass: 'policy_blocked', classSource: 'declared' },
      isError: true,
    })).toBe('policy_denial');
  });

  it('treats an absent classSource as declared so legacy/explicit denials are unaffected', () => {
    expect(classifyExecutedToolCallOutcome({
      details: { isError: true, errorClass: 'policy_blocked' },
      isError: true,
    })).toBe('policy_denial');
    expect(classifyExecutedToolCallOutcome({
      details: { isError: true, errorClass: 'invalid_input' },
      isError: true,
    })).toBe('validation_rejection');
  });

  it('honors explicit structured denial flags regardless of classSource', () => {
    expect(classifyExecutedToolCallOutcome({
      details: { isError: true, capabilityDenied: true, errorClass: 'invalid_input', classSource: 'inferred' },
      isError: true,
    })).toBe('policy_denial');
  });
});
