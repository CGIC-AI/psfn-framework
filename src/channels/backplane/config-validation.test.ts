import { describe, expect, it } from 'vitest';
import { assertNoUnknownKeys } from './config-validation.js';

describe('assertNoUnknownKeys (backplane fail-closed config validation)', () => {
  it('accepts an object whose keys are all in the allow-list', () => {
    expect(() => assertNoUnknownKeys({ a: 1, b: 2 }, ['a', 'b', 'c'], 'ctx')).not.toThrow();
  });

  it('accepts an empty object', () => {
    expect(() => assertNoUnknownKeys({}, ['a', 'b'], 'ctx')).not.toThrow();
  });

  it('throws naming the offending key and the context', () => {
    expect(() => assertNoUnknownKeys({ a: 1, privicy: 'private' }, ['a', 'privacy'], 'places[0]'))
      .toThrow(/places\[0\] has unknown key\(s\): "privicy"/);
  });

  it('names every unknown key when several are present', () => {
    expect(() => assertNoUnknownKeys({ a: 1, x: 2, y: 3 }, ['a'], 'ctx'))
      .toThrow(/unknown key\(s\): "x", "y"/);
  });
});
