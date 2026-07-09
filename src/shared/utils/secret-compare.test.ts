import { describe, expect, it } from 'vitest';
import { timingSafeStringEqual } from './secret-compare.js';

describe('timingSafeStringEqual', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeStringEqual('admin-token:phase4', 'admin-token:phase4')).toBe(true);
  });

  it('returns false for differing strings of equal length', () => {
    expect(timingSafeStringEqual('admin-token:aaaa', 'admin-token:bbbb')).toBe(false);
  });

  it('returns false for differing lengths without throwing', () => {
    expect(timingSafeStringEqual('short', 'a-much-longer-secret-value')).toBe(false);
    expect(timingSafeStringEqual('a-much-longer-secret-value', 'short')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(timingSafeStringEqual('', '')).toBe(true);
    expect(timingSafeStringEqual('', 'x')).toBe(false);
  });

  it('is unicode-safe', () => {
    expect(timingSafeStringEqual('tökén-🔑', 'tökén-🔑')).toBe(true);
    expect(timingSafeStringEqual('tökén-🔑', 'token-key')).toBe(false);
  });
});
