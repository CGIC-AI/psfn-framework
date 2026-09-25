import { afterEach, describe, expect, it } from 'vitest';
import { Tiktoken } from 'js-tiktoken/lite';
import cl100kBase from 'js-tiktoken/ranks/cl100k_base';
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

describe('countTokens on long whitespace-free runs (jrki1)', () => {
  const exact = new Tiktoken(cl100kBase);

  it('counts a runaway whitespace-free reply in bounded, linear time', () => {
    // Shape of the runaway reply that stalled every turn for ~29.5 s.
    const runaway = `A reply that loops. ${'\u547d\u4ee4STARK'.repeat(2540)}`;
    const started = performance.now();
    const count = countTokens(runaway);
    const elapsedMs = performance.now() - started;

    // Unsliced, this input takes tens of seconds; sliced it is well under 1 s.
    expect(elapsedMs).toBeLessThan(1500);
    const unit = '\u547d\u4ee4STARK'.repeat(18);
    const reference = exact.encode(unit).length * (runaway.length / unit.length);
    expect(Math.abs(count - reference) / reference).toBeLessThan(0.05);
  });

  it('stays within one token per slice of the exact count', () => {
    const run = 'x'.repeat(40) + '\u547d\u4ee4STARK'.repeat(60) + '\u{1F600}'.repeat(70);
    const text = `before ${run} after`;
    const slices = Math.ceil(run.length / 128);
    expect(Math.abs(countTokens(text) - exact.encode(text).length)).toBeLessThanOrEqual(slices + 1);
  });

  it('never splits a surrogate pair', () => {
    const emoji = '\u{1F600}'.repeat(300);
    expect(countTokens(emoji)).toBeGreaterThan(0);
    // An isolated surrogate would encode as a replacement character; a clean
    // slice keeps the count close to the exact encode.
    expect(Math.abs(countTokens(emoji) - exact.encode(emoji).length)).toBeLessThanOrEqual(4);
  });

  it('counts ordinary prose exactly as before', () => {
    const prose = 'The quick brown fox jumps over the lazy dog.\n\n'.repeat(300)
      + 'https://example.com/a/short/path?query=1 and some code: const value = compute(a, b);';
    expect(countTokens(prose)).toBe(exact.encode(prose).length);
  });
});

describe('countTokens content-hash cache (z9rkr)', () => {
  function countingTokenizer() {
    const encoded: string[] = [];
    const real = new Tiktoken(cl100kBase);
    tokenTestUtils.setTokenizerFactory(() => ({
      encode: (text: string) => {
        encoded.push(text);
        return real.encode(text);
      },
    }));
    return encoded;
  }

  it('counts a long text once and reuses the count until its content changes', () => {
    const encoded = countingTokenizer();
    const entry = 'A long history entry that is recounted every turn. '.repeat(10);
    const first = countTokens(entry);
    const callsAfterFirst = encoded.length;
    expect(countTokens(entry)).toBe(first);
    expect(encoded.length).toBe(callsAfterFirst);

    const edited = `${entry}One more sentence.`;
    countTokens(edited);
    expect(encoded.length).toBeGreaterThan(callsAfterFirst);
  });

  it('stays within its bound', () => {
    tokenTestUtils.setTokenizerFactory(() => ({ encode: (text: string) => ({ length: text.length }) }));
    const bound = tokenTestUtils.tokenCountCacheBound();
    for (let index = 0; index < bound + 50; index += 1) {
      countTokens(`${'x '.repeat(130)}${index}`);
    }
    expect(tokenTestUtils.tokenCountCacheSize()).toBe(bound);
  });
});
