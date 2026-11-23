import { parseCompanionGardenScope } from '$lib/fleet/companion-scope';

export const INBOX_TABS = [
  { id: 'confirmations', label: 'Confirmations' },
  { id: 'escalations', label: 'Escalations' },
  { id: 'contacts', label: 'Contacts' },
  { id: 'graph', label: 'Graph Proposals' },
  { id: 'cogsec', label: 'CogSec Quarantine' },
  { id: 'remediation', label: 'Integrity Remediation' },
] as const;

export type InboxTabId = (typeof INBOX_TABS)[number]['id'];

const INBOX_TAB_IDS = new Set<InboxTabId>(INBOX_TABS.map(tab => tab.id));

export function resolveInboxTab(searchParams: URLSearchParams): InboxTabId {
  const tab = searchParams.get('tab') ?? 'confirmations';
  return INBOX_TAB_IDS.has(tab as InboxTabId) ? tab as InboxTabId : 'confirmations';
}

export function canonicalInboxPath(tab: InboxTabId): string {
  return tab === 'confirmations' ? '/inbox' : `/inbox?tab=${tab}`;
}

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

export const MEMORY_TABS = [
  { id: 'memories', label: 'L2 Memories' },
  { id: 'episodes', label: 'L0.1 Episodes' },
  { id: 'biography', label: 'Stable Biography' },
] as const;

export type MemoryTabId = (typeof MEMORY_TABS)[number]['id'];

const MEMORY_TAB_IDS = new Set<MemoryTabId>(MEMORY_TABS.map(tab => tab.id));

export function resolveMemoryTab(searchParams: URLSearchParams): MemoryTabId {
  const tab = searchParams.get('tab') ?? 'memories';
  return MEMORY_TAB_IDS.has(tab as MemoryTabId) ? tab as MemoryTabId : 'memories';
}

export function canonicalMemoryPath(tab: MemoryTabId): string {
  return tab === 'memories' ? '/memory' : `/memory?tab=${tab}`;
}

export const IDENTITY_TABS = [
  { id: 'card', label: 'Character Card' },
  { id: 'prompts', label: 'Prompt Layers' },
  { id: 'monitor', label: 'Prompt Monitor' },
  { id: 'values', label: 'Values & Journal' },
] as const;

export type IdentityTabId = (typeof IDENTITY_TABS)[number]['id'];

const IDENTITY_TAB_IDS = new Set<IdentityTabId>(IDENTITY_TABS.map(tab => tab.id));

export function resolveIdentityTab(searchParams: URLSearchParams): IdentityTabId {
  const tab = searchParams.get('tab') ?? 'card';
  return IDENTITY_TAB_IDS.has(tab as IdentityTabId) ? tab as IdentityTabId : 'card';
}

export function canonicalIdentityPath(tab: IdentityTabId): string {
  return tab === 'card' ? '/identity' : `/identity?tab=${tab}`;
}

export const KNOWLEDGE_TABS = [
  { id: 'wiki', label: 'Wiki' },
  { id: 'concerns', label: 'Concerns' },
  { id: 'wishlist', label: 'Wishlist' },
  { id: 'images', label: 'Images' },
] as const;

export type KnowledgeTabId = (typeof KNOWLEDGE_TABS)[number]['id'];

const KNOWLEDGE_TAB_IDS = new Set<KnowledgeTabId>(KNOWLEDGE_TABS.map(tab => tab.id));

export function resolveKnowledgeTab(searchParams: URLSearchParams): KnowledgeTabId {
  const tab = searchParams.get('tab') ?? 'wiki';
  return KNOWLEDGE_TAB_IDS.has(tab as KnowledgeTabId) ? tab as KnowledgeTabId : 'wiki';
}

export function canonicalKnowledgePath(tab: KnowledgeTabId): string {
  return tab === 'wiki' ? '/wiki' : `/wiki?tab=${tab}`;
}

export const CONTACTS_TABS = [
  { id: 'contacts', label: 'Contacts' },
  { id: 'enrollment', label: 'Enrollment' },
] as const;

export type ContactsTabId = (typeof CONTACTS_TABS)[number]['id'];

const CONTACTS_TAB_IDS = new Set<ContactsTabId>(CONTACTS_TABS.map(tab => tab.id));

export function resolveContactsTab(searchParams: URLSearchParams): ContactsTabId {
  const tab = searchParams.get('tab') ?? 'contacts';
  return CONTACTS_TAB_IDS.has(tab as ContactsTabId) ? tab as ContactsTabId : 'contacts';
}

export function canonicalContactsPath(tab: ContactsTabId): string {
  return tab === 'contacts' ? '/contacts' : `/contacts?tab=${tab}`;
}

export const PLACES_TABS = [
  { id: 'physical', label: 'Physical' },
  { id: 'virtual', label: 'Virtual' },
  { id: 'satellites', label: 'Satellites' },
  { id: 'arbiter', label: 'Cluster Rooms' },
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
  if (innerPath === '/room-arbiter') {
    return scopedDestination(pathname, canonicalPlacesPath('arbiter'));
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
  if (innerPath === '/confirmations') {
    return scopedDestination(pathname, canonicalInboxPath('confirmations'));
  }
  if (innerPath === '/escalations') {
    return scopedDestination(pathname, canonicalInboxPath('escalations'));
  }
  if (innerPath === '/contact-approvals') {
    return scopedDestination(pathname, canonicalInboxPath('contacts'));
  }
  if (innerPath === '/graph-proposals') {
    return scopedDestination(pathname, canonicalInboxPath('graph'));
  }
  if (innerPath === '/cognitive-security/approvals') {
    return scopedDestination(pathname, canonicalInboxPath('cogsec'));
  }
  if (innerPath === '/cognitive-security/remediation') {
    return scopedDestination(pathname, canonicalInboxPath('remediation'));
  }
  if (innerPath === '/episodic-memory') {
    return scopedDestination(pathname, canonicalMemoryPath('episodes'));
  }
  if (innerPath === '/biographical-profile') {
    return scopedDestination(pathname, canonicalMemoryPath('biography'));
  }
  if (innerPath === '/prompts') {
    return scopedDestination(pathname, canonicalIdentityPath('prompts'));
  }
  if (innerPath === '/prompt-monitor') {
    return scopedDestination(pathname, canonicalIdentityPath('monitor'));
  }
  if (innerPath === '/values') {
    return scopedDestination(pathname, canonicalIdentityPath('values'));
  }
  if (innerPath === '/concerns') {
    return scopedDestination(pathname, canonicalKnowledgePath('concerns'));
  }
  if (innerPath === '/wishlist' || innerPath === '/doing-mirror') {
    return scopedDestination(pathname, canonicalKnowledgePath('wishlist'));
  }
  if (innerPath === '/images') {
    return scopedDestination(pathname, canonicalKnowledgePath('images'));
  }
  if (innerPath === '/enrollment') {
    return scopedDestination(pathname, canonicalContactsPath('enrollment'));
  }
  if (innerPath === '/letters') {
    return scopedDestination(pathname, canonicalConversationsPath('live'));
  }
  if (innerPath === '/chat') {
    const requestedTab = new URLSearchParams(search).get('tab');
    if (requestedTab === 'transcripts' || hash === '#transcripts') {
      return scopedDestination(pathname, canonicalConversationsPath('sessions'));
    }
  }
  return null;
}
