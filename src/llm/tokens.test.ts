import { describe, it, expect } from 'vitest';
import { estimateTokens } from './tokens.js';

describe('estimateTokens', () => {
  it('estimates ~1 token per 4 characters', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('rounds up partial tokens', () => {
    expect(estimateTokens('abc')).toBe(1); // 3/4 = 0.75, ceil = 1
    expect(estimateTokens('abcde')).toBe(2); // 5/4 = 1.25, ceil = 2
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('handles long text', () => {
    const text = 'a'.repeat(1000);
    expect(estimateTokens(text)).toBe(250);
  });
});
