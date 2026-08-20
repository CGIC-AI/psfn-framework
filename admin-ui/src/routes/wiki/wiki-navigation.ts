export interface WikiDeepLinkSelection {
  scopeKey: string;
  canonicalSearch: string;
}

export function resolveWikiDeepLink(
  search: string,
  sharedSiteIds: readonly string[],
): WikiDeepLinkSelection {
  const params = new URLSearchParams(search);
  const requestedScope = params.get('scope')?.trim() || 'personal';
  if (requestedScope === 'personal' || sharedSiteIds.length === 0) {
    return { scopeKey: 'personal', canonicalSearch: '?scope=personal' };
  }

  const requestedSite = params.get('site')?.trim();
  const legacySite = sharedSiteIds.includes(requestedScope) ? requestedScope : undefined;
  const siteId = requestedSite && sharedSiteIds.includes(requestedSite)
    ? requestedSite
    : (legacySite ?? sharedSiteIds[0]!);
  return {
    scopeKey: siteId,
    canonicalSearch: `?scope=shared&site=${encodeURIComponent(siteId)}`,
  };
}
