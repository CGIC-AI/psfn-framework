import { parseCompanionGardenScope } from '$lib/fleet/companion-scope';

export const CONVERSATIONS_TABS = [
  { id: 'live', label: 'Live Chat' },
  { id: 'sessions', label: 'Sessions & Debug' },
  { id: 'recovery', label: 'Session Recovery' },
] as const;

export type ConversationsTabId = (typeof CONVERSATIONS_TABS)[number]['id'];

const CONVERSATIONS_TAB_IDS = new Set<ConversationsTabId>(
  CONVERSATIONS_TABS.map(tab => tab.id),
);

export function resolveConversationsTab(searchParams: URLSearchParams): ConversationsTabId {
  const tab = searchParams.get('tab') ?? 'live';
  return CONVERSATIONS_TAB_IDS.has(tab as ConversationsTabId)
    ? tab as ConversationsTabId
    : 'live';
}

export function canonicalConversationsPath(tab: ConversationsTabId): string {
  return tab === 'live' ? '/chat' : `/chat?tab=${tab}`;
}

export const PLACES_TABS = [
  { id: 'physical', label: 'Physical' },
  { id: 'virtual', label: 'Virtual' },
  { id: 'satellites', label: 'Satellites' },
] as const;

export type PlacesTabId = (typeof PLACES_TABS)[number]['id'];

const PLACES_TAB_IDS = new Set<PlacesTabId>(PLACES_TABS.map(tab => tab.id));

export function resolvePlacesTab(searchParams: URLSearchParams): PlacesTabId {
  const tab = searchParams.get('tab') ?? 'physical';
  return PLACES_TAB_IDS.has(tab as PlacesTabId) ? tab as PlacesTabId : 'physical';
}

export function canonicalPlacesPath(tab: PlacesTabId): string {
  return tab === 'physical' ? '/places' : `/places?tab=${tab}`;
}

function scopedDestination(pathname: string, destination: string): string {
  const scope = parseCompanionGardenScope(pathname);
  return scope ? `${scope.publicPrefix}${destination}` : destination;
}

export function canonicalGardenDestination(
  pathname: string,
  search: string,
  hash: string,
): string | null {
  const scope = parseCompanionGardenScope(pathname);
  const innerPath = scope?.innerPath ?? pathname;

  if (innerPath === '/rooms') {
    return scopedDestination(pathname, canonicalPlacesPath('virtual'));
  }
  if (innerPath === '/satellites') {
    return scopedDestination(pathname, canonicalPlacesPath('satellites'));
  }
  if (innerPath === '/model-room') {
    return scopedDestination(pathname, canonicalConversationsPath('live'));
  }
  if (innerPath === '/sessions' || innerPath === '/transcripts') {
    return scopedDestination(pathname, canonicalConversationsPath('sessions'));
  }
  if (innerPath === '/session-recovery') {
    return scopedDestination(pathname, canonicalConversationsPath('recovery'));
  }
  if (innerPath === '/chat') {
    const requestedTab = new URLSearchParams(search).get('tab');
    if (requestedTab === 'transcripts' || hash === '#transcripts') {
      return scopedDestination(pathname, canonicalConversationsPath('sessions'));
    }
  }
  return null;
}
