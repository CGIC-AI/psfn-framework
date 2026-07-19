import { describe, expect, it } from 'vitest';
import { uniqueStrings } from './strings.js';

describe('uniqueStrings', () => {
  it('trims, removes empty values, and preserves first-seen order', () => {
    expect(uniqueStrings([' beta ', '', 'alpha', 'beta', '  ', 'alpha ']))
      .toEqual(['beta', 'alpha']);
  });

  it('accepts non-array iterables', () => {
    expect(uniqueStrings(new Set([' one ', 'two', 'one']))).toEqual(['one', 'two']);
  });
});
