import { describe, expect, it } from 'vitest';
import { backoffMs, sleep, toIsoInstant } from './timing.js';

describe('timing utils', () => {
  it('formats millisecond timestamps as ISO instants', () => {
    expect(toIsoInstant(0)).toBe('1970-01-01T00:00:00.000Z');
  });

  it('sleep returns a promise', () => {
    expect(sleep(0)).toBeInstanceOf(Promise);
  });
});

describe('backoffMs', () => {
  it('computes exponential delays from attempt 0', () => {
    expect(backoffMs(100, 0)).toBe(100);
    expect(backoffMs(100, 1)).toBe(200);
    expect(backoffMs(100, 2)).toBe(400);
  });

  it('caps at maxMs when provided', () => {
    expect(backoffMs(100, 10, 5000)).toBe(5000);
    expect(backoffMs(100, 1, 150)).toBe(150);
  });

  it('ignores maxMs when it is Infinity', () => {
    expect(backoffMs(100, 10, Number.POSITIVE_INFINITY)).toBe(100 * (2 ** 10));
  });

  it('treats negative attempt indices as attempt 0', () => {
    expect(backoffMs(100, -3)).toBe(100);
  });
});
