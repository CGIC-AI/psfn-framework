import { describe, it, expect } from 'vitest';
import {
  search, grep, grep_v,
  between, head, tail,
  word_frequency, diff, text_similarity,
  dedupe, group_by, partition,
} from './helpers.js';

// ── Text Search ──

describe('search', () => {
  const sample = 'line one\nline two\nline three\nline four\nline five';

  it('finds matching lines', () => {
    const results = search(sample, 'two');
    expect(results).toEqual(['line two']);
  });

  it('returns context lines around matches', () => {
    const results = search(sample, 'three', 1);
    expect(results).toEqual(['line two\nline three\nline four']);
  });

  it('clamps context at file boundaries', () => {
    const results = search(sample, 'one', 2);
    // start clamps to 0, end goes to idx 2
    expect(results).toEqual(['line one\nline two\nline three']);
  });

  it('returns empty array for no match', () => {
    expect(search(sample, 'missing')).toEqual([]);
  });

  it('returns empty array for invalid regex', () => {
    expect(search(sample, '[invalid')).toEqual([]);
  });

  it('handles multiple matches', () => {
    const results = search('a\nb\na\nc', 'a');
    expect(results).toHaveLength(2);
    expect(results[0]).toBe('a');
    expect(results[1]).toBe('a');
  });
});

describe('grep', () => {
  const sample = 'apple\nbanana\napricot\ncherry';

  it('filters matching lines', () => {
    expect(grep(sample, '^ap')).toBe('apple\napricot');
  });

  it('returns empty string for no match', () => {
    expect(grep(sample, 'zzz')).toBe('');
  });

  it('returns empty string for invalid regex', () => {
    expect(grep(sample, '[bad')).toBe('');
  });
});

describe('grep_v', () => {
  const sample = 'apple\nbanana\napricot\ncherry';

  it('filters non-matching lines', () => {
    expect(grep_v(sample, '^ap')).toBe('banana\ncherry');
  });

  it('returns empty string for no match (all lines match)', () => {
    // Every line matches '.', so inverse is nothing
    expect(grep_v(sample, '.')).toBe('');
  });

  it('returns empty string for invalid regex', () => {
    expect(grep_v(sample, '[bad')).toBe('');
  });
});

// ── Text Extraction ──

describe('between', () => {
  it('extracts text between markers', () => {
    expect(between('hello [start]middle[end] world', '[start]', '[end]')).toBe('middle');
  });

  it('returns empty string when start marker not found', () => {
    expect(between('no markers here', '[start]', '[end]')).toBe('');
  });

  it('returns empty string when end marker not found', () => {
    expect(between('only [start] here', '[start]', '[end]')).toBe('');
  });

  it('handles adjacent markers', () => {
    expect(between('<a></a>', '<a>', '</a>')).toBe('');
  });
});

describe('head', () => {
  const sample = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');

  it('returns first 10 lines by default', () => {
    const result = head(sample);
    expect(result.split('\n')).toHaveLength(10);
    expect(result).toContain('line 1');
    expect(result).toContain('line 10');
    expect(result).not.toContain('line 11');
  });

  it('returns first n lines', () => {
    expect(head(sample, 3)).toBe('line 1\nline 2\nline 3');
  });

  it('returns all lines when n exceeds line count', () => {
    const short = 'a\nb\nc';
    expect(head(short, 100)).toBe('a\nb\nc');
  });
});

describe('tail', () => {
  const sample = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');

  it('returns last 10 lines by default', () => {
    const result = tail(sample);
    expect(result.split('\n')).toHaveLength(10);
    expect(result).toContain('line 11');
    expect(result).toContain('line 20');
    expect(result).not.toContain('line 10');
  });

  it('returns last n lines', () => {
    expect(tail(sample, 3)).toBe('line 18\nline 19\nline 20');
  });

  it('returns all lines when n exceeds line count', () => {
    const short = 'a\nb\nc';
    expect(tail(short, 100)).toBe('a\nb\nc');
  });
});

// ── Analysis ──

describe('word_frequency', () => {
  it('counts word occurrences', () => {
    const freq = word_frequency('cat dog cat bird cat dog');
    expect(freq.cat).toBe(3);
    expect(freq.dog).toBe(2);
    expect(freq.bird).toBe(1);
  });

  it('filters stopwords', () => {
    const freq = word_frequency('the cat is on the mat');
    expect(freq.cat).toBe(1);
    expect(freq.mat).toBe(1);
    expect(freq.the).toBeUndefined();
    expect(freq.is).toBeUndefined();
    expect(freq.on).toBeUndefined();
  });

  it('normalizes to lowercase', () => {
    const freq = word_frequency('Cat CAT cat');
    expect(freq.cat).toBe(3);
  });

  it('returns empty for empty input', () => {
    expect(word_frequency('')).toEqual({});
  });
});

describe('diff', () => {
  it('returns empty for identical texts', () => {
    expect(diff('a\nb\nc', 'a\nb\nc')).toBe('');
  });

  it('shows additions only', () => {
    const result = diff('a\nb', 'a\nb\nc');
    expect(result).toBe('+c');
  });

  it('shows removals only', () => {
    const result = diff('a\nb\nc', 'a\nb');
    expect(result).toBe('-c');
  });

  it('shows mixed changes', () => {
    const result = diff('a\nb\nc', 'a\nd\nc');
    expect(result).toContain('-b');
    expect(result).toContain('+d');
  });
});

describe('text_similarity', () => {
  it('returns 1.0 for identical texts', () => {
    expect(text_similarity('hello world', 'hello world')).toBe(1.0);
  });

  it('returns 0.0 for completely different texts', () => {
    expect(text_similarity('hello world', 'foo bar')).toBe(0.0);
  });

  it('returns value between 0 and 1 for partial overlap', () => {
    const sim = text_similarity('hello world foo', 'hello world bar');
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
    // intersection = {hello, world} = 2, union = {hello, world, foo, bar} = 4
    expect(sim).toBeCloseTo(0.5);
  });

  it('returns 0 for empty inputs', () => {
    expect(text_similarity('', '')).toBe(0);
    expect(text_similarity('', 'hello')).toBe(0);
  });

  it('is case insensitive', () => {
    expect(text_similarity('Hello World', 'hello world')).toBe(1.0);
  });
});

// ── Collections ──

describe('dedupe', () => {
  it('removes duplicates keeping first occurrence', () => {
    const items = [
      { id: 'a', val: 1 },
      { id: 'b', val: 2 },
      { id: 'a', val: 3 },
    ];
    const result = dedupe(items, x => x.id);
    expect(result).toHaveLength(2);
    expect(result[0].val).toBe(1);
    expect(result[1].val).toBe(2);
  });

  it('handles empty array', () => {
    expect(dedupe([], x => String(x))).toEqual([]);
  });
});

describe('group_by', () => {
  it('groups items by key', () => {
    const items = [
      { type: 'fruit', name: 'apple' },
      { type: 'veggie', name: 'carrot' },
      { type: 'fruit', name: 'banana' },
    ];
    const groups = group_by(items, x => x.type);
    expect(groups.fruit).toHaveLength(2);
    expect(groups.veggie).toHaveLength(1);
    expect(groups.fruit[0].name).toBe('apple');
    expect(groups.fruit[1].name).toBe('banana');
  });

  it('handles empty array', () => {
    expect(group_by([], () => 'key')).toEqual({});
  });
});

describe('partition', () => {
  it('splits array by predicate', () => {
    const [evens, odds] = partition([1, 2, 3, 4, 5], x => x % 2 === 0);
    expect(evens).toEqual([2, 4]);
    expect(odds).toEqual([1, 3, 5]);
  });

  it('handles all matching', () => {
    const [t, f] = partition([2, 4, 6], x => x % 2 === 0);
    expect(t).toEqual([2, 4, 6]);
    expect(f).toEqual([]);
  });

  it('handles none matching', () => {
    const [t, f] = partition([1, 3, 5], x => x % 2 === 0);
    expect(t).toEqual([]);
    expect(f).toEqual([1, 3, 5]);
  });

  it('handles empty array', () => {
    const [t, f] = partition([], () => true);
    expect(t).toEqual([]);
    expect(f).toEqual([]);
  });
});
