import { describe, expect, it } from 'vitest';
import {
  isPersonalScope,
  isSharedWorldScope,
  normalizeWikiScope,
  PERSONAL_WIKI_SCOPE,
  resolveReadableWikiScopes,
  resolveWikiScope,
  sharedWorldScope,
  sharedWorldScopeSiteId,
} from './scope.js';

describe('normalizeWikiScope', () => {
  it('defaults absent/empty/personal to personal (byte-identical default)', () => {
    expect(normalizeWikiScope(undefined)).toBe('personal');
    expect(normalizeWikiScope(null)).toBe('personal');
    expect(normalizeWikiScope('')).toBe('personal');
    expect(normalizeWikiScope('   ')).toBe('personal');
    expect(normalizeWikiScope('personal')).toBe('personal');
  });

  it('accepts a shared_world scope with a valid siteId', () => {
    expect(normalizeWikiScope('shared_world:studio')).toBe('shared_world:studio');
    expect(normalizeWikiScope('shared_world:site.a-1:zone')).toBe('shared_world:site.a-1:zone');
  });

  it('rejects a bare shared_world prefix with no siteId', () => {
    expect(() => normalizeWikiScope('shared_world:')).toThrow(/valid siteId/);
  });

  it('rejects a shared_world scope with an invalid siteId token', () => {
    expect(() => normalizeWikiScope('shared_world:bad site!')).toThrow(/valid siteId/);
  });

  it('rejects unknown scope shapes and non-strings (fail closed)', () => {
    expect(() => normalizeWikiScope('world')).toThrow(/must be 'personal'/);
    expect(() => normalizeWikiScope(42 as unknown)).toThrow(/must be a string/);
  });
});

describe('scope predicates + helpers', () => {
  it('classifies personal vs shared', () => {
    expect(isPersonalScope('personal')).toBe(true);
    expect(isSharedWorldScope('personal')).toBe(false);
    expect(isSharedWorldScope('shared_world:studio')).toBe(true);
  });

  it('round-trips siteId through compose/extract', () => {
    const scope = sharedWorldScope('studio');
    expect(scope).toBe('shared_world:studio');
    expect(sharedWorldScopeSiteId(scope)).toBe('studio');
    expect(sharedWorldScopeSiteId('personal')).toBeUndefined();
  });

  it('resolveWikiScope mirrors normalizeWikiScope for absent values', () => {
    expect(resolveWikiScope(undefined)).toBe(PERSONAL_WIKI_SCOPE);
  });
});

describe('resolveReadableWikiScopes', () => {
  it('returns undefined (unrestricted) when the flag is off', () => {
    expect(resolveReadableWikiScopes({ multiCompanion: false, currentSiteId: 'studio' })).toBeUndefined();
  });

  it('returns personal + the site shared scope under the flag when situated', () => {
    expect(resolveReadableWikiScopes({ multiCompanion: true, currentSiteId: 'studio' }))
      .toEqual(['personal', 'shared_world:studio']);
  });

  it('returns personal-only under the flag when unsited', () => {
    expect(resolveReadableWikiScopes({ multiCompanion: true })).toEqual(['personal']);
  });

  it('drops an invalid siteId under the flag (personal-only, fail closed)', () => {
    expect(resolveReadableWikiScopes({ multiCompanion: true, currentSiteId: 'bad site!' }))
      .toEqual(['personal']);
  });
});
