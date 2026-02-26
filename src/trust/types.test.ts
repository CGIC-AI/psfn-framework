import { describe, expect, it } from 'vitest';
import {
  normalizeConsentFlags,
  resolveConsentRedactionBehavior,
} from './types.js';

describe('trust consent schema helpers', () => {
  it('normalizes known consent keys and drops unknown fields', () => {
    const normalized = normalizeConsentFlags({
      allowRecall: false,
      allowAbstraction: true,
      deleteOnRequest: true,
      redactionBehavior: 'ABSTRACT',
      unknown: 'ignored',
    });

    expect(normalized).toEqual({
      allowRecall: false,
      allowAbstraction: true,
      deleteOnRequest: true,
      redactionBehavior: 'abstract',
    });
  });

  it('resolves auto redaction behavior from consent flags', () => {
    expect(resolveConsentRedactionBehavior({
      deleteOnRequest: true,
      allowAbstraction: true,
    }, 'auto')).toBe('abstract');

    expect(resolveConsentRedactionBehavior({
      allowRecall: false,
      allowAbstraction: false,
    }, 'auto')).toBe('delete');
  });

  it('respects explicit requested operation with consent safety fallback', () => {
    expect(resolveConsentRedactionBehavior({
      allowAbstraction: true,
    }, 'abstract')).toBe('abstract');

    expect(resolveConsentRedactionBehavior({
      allowAbstraction: false,
    }, 'abstract')).toBe('delete');

    expect(resolveConsentRedactionBehavior({}, 'delete')).toBe('delete');
  });
});
