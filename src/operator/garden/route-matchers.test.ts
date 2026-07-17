import { describe, expect, it } from 'vitest';
import {
  nestedParamPath,
  paramWithSuffix,
  prefixedParamPath,
} from './route-matchers.js';

describe('Garden route matchers', () => {
  it('exposes the canonical capability pattern', () => {
    expect(paramWithSuffix('/api/admin/memory/', 'id', '/reveal').capabilityPattern)
      .toBe('/api/admin/memory/:id/reveal');
    expect(nestedParamPath('/sessions/', '/turns/', 'channelId', 'turnId').capabilityPattern)
      .toBe('/sessions/:channelId/turns/:turnId');
  });

  it.each([
    '/api/admin/memory/a/b',
    '/api/admin/memory/%2F',
    '/api/admin/memory/%5C',
    '/api/admin/memory/%2E%2E',
    '/api/admin/memory/%GG',
  ])('rejects non-canonical parameter path %s', (path) => {
    expect(prefixedParamPath('/api/admin/memory/', 'id')(path)).toBeNull();
  });

  it('decodes one canonical encoded segment', () => {
    expect(prefixedParamPath('/api/admin/memory/', 'id')('/api/admin/memory/hello%20world'))
      .toEqual({ id: 'hello world' });
  });
});
