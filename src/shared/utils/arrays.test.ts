import { describe, expect, it } from 'vitest';
import { chunk } from './arrays.js';

describe('chunk', () => {
  it('partitions a list into fixed-size pieces', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns one chunk when size equals length', () => {
    expect(chunk([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
  });

  it('returns an empty array for empty input', () => {
    expect(chunk([], 3)).toEqual([]);
  });

});
