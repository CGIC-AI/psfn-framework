import { describe, expect, it } from 'vitest';
import { toIsoInstant } from './timing.js';

describe('timing utils', () => {
  it('formats millisecond timestamps as ISO instants', () => {
    expect(toIsoInstant(0)).toBe('1970-01-01T00:00:00.000Z');
  });
});
