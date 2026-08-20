import { describe, expect, it } from 'vitest';
import { resolveWikiDeepLink } from './wiki-navigation';

const sharedSiteIds = ['home', 'studio'];

describe('resolveWikiDeepLink', () => {
  it('keeps personal Wiki canonical', () => {
    expect(resolveWikiDeepLink('?scope=personal', sharedSiteIds)).toEqual({
      scopeKey: 'personal',
      canonicalSearch: '?scope=personal',
    });
  });

  it('redirects a legacy site-as-scope link into the shared Wiki surface', () => {
    expect(resolveWikiDeepLink('?scope=studio', sharedSiteIds)).toEqual({
      scopeKey: 'studio',
      canonicalSearch: '?scope=shared&site=studio',
    });
  });

  it('fails safely to the first shared site when an old shared link omits a site', () => {
    expect(resolveWikiDeepLink('?scope=shared', sharedSiteIds)).toEqual({
      scopeKey: 'home',
      canonicalSearch: '?scope=shared&site=home',
    });
  });
});
