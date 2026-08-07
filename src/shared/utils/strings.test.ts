import { describe, expect, it } from 'vitest';
import { nonEmptyStringOrUndefined, requireNonEmptyString, uniqueStrings } from './strings.js';

describe('uniqueStrings', () => {
  it('trims, removes empty values, and preserves first-seen order', () => {
    expect(uniqueStrings([' beta ', '', 'alpha', 'beta', '  ', 'alpha ']))
      .toEqual(['beta', 'alpha']);
  });

  it('accepts non-array iterables', () => {
    expect(uniqueStrings(new Set([' one ', 'two', 'one']))).toEqual(['one', 'two']);
  });
});

describe('requireNonEmptyString', () => {
  it('returns the trimmed value for non-empty strings', () => {
    expect(requireNonEmptyString('  hello  ', 'name')).toBe('hello');
    expect(requireNonEmptyString('x', 'name')).toBe('x');
  });

  it('throws for empty or non-string values', () => {
    expect(() => requireNonEmptyString('', 'name')).toThrow('name must be a non-empty string');
    expect(() => requireNonEmptyString('   ', 'name')).toThrow('name must be a non-empty string');
    expect(() => requireNonEmptyString(null, 'name')).toThrow('name must be a non-empty string');
    expect(() => requireNonEmptyString(undefined, 'name')).toThrow('name must be a non-empty string');
    expect(() => requireNonEmptyString(123, 'name')).toThrow('name must be a non-empty string');
  });
});

describe('nonEmptyStringOrUndefined', () => {
  it('returns trimmed non-empty strings', () => {
    expect(nonEmptyStringOrUndefined('  hello  ')).toBe('hello');
  });

  it('returns undefined for empty or non-string values', () => {
    expect(nonEmptyStringOrUndefined('')).toBeUndefined();
    expect(nonEmptyStringOrUndefined('   ')).toBeUndefined();
    expect(nonEmptyStringOrUndefined(null)).toBeUndefined();
    expect(nonEmptyStringOrUndefined(undefined)).toBeUndefined();
  });
});
