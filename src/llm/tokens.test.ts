import { afterEach, describe, expect, it } from 'vitest';
import {
  __test as tokenTestUtils,
  countMessageTokens,
  countTokens,
  estimateTokens,
  formatTokens,
} from './tokens.js';

afterEach(() => {
  tokenTestUtils.resetTokenizerState();
});

describe('countTokens', () => {
  it('uses real tokenizer counts for non-trivial text', () => {
    const fallbackEstimate = Math.ceil('你好世界你好世界'.length / 4);
    const realCount = countTokens('你好世界你好世界');

    expect(realCount).toBeGreaterThan(fallbackEstimate);
  });

  it('falls back to chars/4 when tokenizer init fails', () => {
    tokenTestUtils.setTokenizerFactory(() => {
      throw new Error('boom');
    });

    expect(countTokens('abcd')).toBe(1);
    expect(countTokens('abcde')).toBe(2);
  });

  it('falls back to chars/4 when tokenizer encode throws', () => {
    tokenTestUtils.setTokenizerFactory(() => ({
      encode: () => {
        throw new Error('encode failed');
      },
    }));

    expect(countTokens('abc')).toBe(1);
    expect(countTokens('abcdefgh')).toBe(2);
  });

  it('supports message framing overhead counting', () => {
    tokenTestUtils.setTokenizerFactory(() => ({
      encode: (text: string) => ({ length: text.length }),
    }));

    const tokens = countMessageTokens([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo', name: 'bot' },
    ]);

    expect(tokens).toBe(31);
  });

  it('keeps estimateTokens as compatibility alias', () => {
    tokenTestUtils.setTokenizerFactory(() => ({
      encode: (text: string) => ({ length: text.length }),
    }));

    expect(estimateTokens('abc')).toBe(3);
  });
});

describe('formatTokens', () => {
  it('returns raw numbers below 1k', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });

  it('formats thousands with one decimal place', () => {
    expect(formatTokens(1_000)).toBe('1.0k');
    expect(formatTokens(12_345)).toBe('12.3k');
  });

  it('formats millions with one decimal place', () => {
    expect(formatTokens(1_000_000)).toBe('1.0M');
    expect(formatTokens(2_349_999)).toBe('2.3M');
  });
});
