import { describe, expect, it } from 'vitest';
import { abortError, toError, toErrorMessage } from './errors.js';

describe('error helpers', () => {
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
});
