import { describe, expect, it } from 'vitest';
import {
  abortError,
  formatErrorCauseChain,
  formatErrorSummary,
  toError,
  toErrorMessage,
} from './errors.js';

describe('error helpers', () => {
  it('formats a wrapper error with its root cause chain', () => {
    const root = new Error('duplicate key value violates unique constraint');
    const middle = new Error('episode claim conflict', { cause: root });
    const wrapper = new Error('Extraction orchestration failed', { cause: middle });

    expect(formatErrorCauseChain(wrapper)).toBe(
      'Extraction orchestration failed <- caused by: episode claim conflict'
        + ' <- caused by: duplicate key value violates unique constraint',
    );
    expect(formatErrorCauseChain('plain')).toBe('plain');
  });

  it('stops at a cyclic cause chain and keeps aggregate inner errors visible', () => {
    const cyclic = new Error('outer');
    const inner = new Error('inner', { cause: cyclic });
    Object.defineProperty(cyclic, 'cause', { value: inner });
    expect(formatErrorCauseChain(cyclic)).toBe('outer <- caused by: inner');

    const aggregate = new AggregateError([new Error('provider 503')], 'drain failed');
    expect(formatErrorCauseChain(new Error('wrapper', { cause: aggregate })))
      .toBe('wrapper <- caused by: drain failed [provider 503]');
  });

  it('preserves Error instances and normalizes non-Error values', () => {
    const existing = new TypeError('typed failure');

    expect(toError(existing)).toBe(existing);
    expect(toError('plain failure')).toEqual(new Error('plain failure'));
    expect(toErrorMessage(existing)).toBe('typed failure');
    expect(toErrorMessage(42)).toBe('42');
  });

  it('creates AbortError instances from messages and preserves Error reasons', () => {
    const created = abortError('request cancelled');
    expect(created).toMatchObject({
      name: 'AbortError',
      message: 'request cancelled',
    });

    const reason = new Error('upstream cancelled');
    reason.name = '';
    expect(abortError(reason)).toBe(reason);
    expect(reason.name).toBe('AbortError');
  });

  it('returns a getter-only-name DOMException reason untouched instead of throwing', () => {
    const reason = new DOMException('This operation was aborted', 'AbortError');
    expect(abortError(reason)).toBe(reason);
    expect(reason.name).toBe('AbortError');
  });

  it('wraps a frozen empty-name Error reason instead of mutating it', () => {
    const reason = new Error('upstream cancelled');
    reason.name = '';
    Object.freeze(reason);
    const result = abortError(reason);
    expect(result).not.toBe(reason);
    expect(result).toMatchObject({ name: 'AbortError', message: 'upstream cancelled' });
    expect(reason.name).toBe('');
  });

  it('wraps an extensible error whose empty name comes from a getter-only prototype', () => {
    class InheritedNameError extends Error {}
    Object.defineProperty(InheritedNameError.prototype, 'name', {
      get: () => '',
      configurable: true,
    });
    const reason = new InheritedNameError('upstream cancelled');
    expect(Object.isExtensible(reason)).toBe(true);
    const result = abortError(reason);
    expect(result).not.toBe(reason);
    expect(result).toMatchObject({ name: 'AbortError', message: 'upstream cancelled' });
  });

  it('uses the caller fallback for empty abort reasons', () => {
    expect(abortError(undefined, 'model call cancelled')).toMatchObject({
      name: 'AbortError',
      message: 'model call cancelled',
    });
  });

  it('can preserve an explicitly empty provider cancellation message', () => {
    expect(abortError('', 'Request aborted', true)).toMatchObject({
      name: 'AbortError',
      message: '',
    });
  });

  it('expands AggregateError inner messages in toErrorMessage and formatErrorSummary (d5e0p.4)', () => {
    const first = Object.assign(new Error('provider timed out'), {
      logicalSessionId: 'discord:session-alpha',
      stage: 'episode_synthesis',
    });
    const second = new Error('discord:session-beta/orientation_review: invalid plan JSON');
    const aggregate = new AggregateError(
      [first, second],
      'Sleeptime workset has 2 session failure(s)',
    );

    const message = toErrorMessage(aggregate);
    expect(message).toContain('Sleeptime workset has 2 session failure(s)');
    expect(message).toContain('discord:session-alpha/episode_synthesis: provider timed out');
    expect(message).toContain('discord:session-beta/orientation_review: invalid plan JSON');

    const summary = formatErrorSummary(aggregate);
    expect(summary).toContain('AggregateError:');
    expect(summary).toContain('discord:session-alpha/episode_synthesis: provider timed out');
    expect(summary).toContain('discord:session-beta/orientation_review: invalid plan JSON');

    // Preserves String(error) format for ordinary Error instances.
    expect(formatErrorSummary(new Error('plain fault'))).toBe('Error: plain fault');
  });

  it('bounds AggregateError inner count and total serialized length', () => {
    const many = Array.from({ length: 12 }, (_, idx) => new Error(`s-${idx}: ${'x'.repeat(400)}`));
    const aggregate = new AggregateError(many, 'Batch failed');

    const message = toErrorMessage(aggregate);
    expect(message.length).toBeLessThanOrEqual(1024);
    expect(message).toContain('s-0:');
  });
});
