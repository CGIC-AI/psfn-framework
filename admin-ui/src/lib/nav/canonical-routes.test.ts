import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  canonicalContactsPath,
  canonicalConversationsPath,
  canonicalGardenDestination,
  canonicalIdentityPath,
  canonicalInboxPath,
  canonicalKnowledgePath,
  canonicalMemoryPath,
  canonicalPlacesPath,
  resolveContactsTab,
  resolveConversationsTab,
  resolveIdentityTab,
  resolveInboxTab,
  resolveKnowledgeTab,
  resolveMemoryTab,
  resolvePlacesTab,
} from './canonical-routes';

const COMPANION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('Inbox tabs have canonical, directly addressable URLs', () => {
  assert.equal(resolveInboxTab(new URLSearchParams()), 'confirmations');
  assert.equal(resolveInboxTab(new URLSearchParams('tab=confirmations')), 'confirmations');
  assert.equal(resolveInboxTab(new URLSearchParams('tab=escalations')), 'escalations');
  assert.equal(resolveInboxTab(new URLSearchParams('tab=contacts')), 'contacts');
  assert.equal(resolveInboxTab(new URLSearchParams('tab=graph')), 'graph');
  assert.equal(resolveInboxTab(new URLSearchParams('tab=cogsec')), 'cogsec');
  assert.equal(resolveInboxTab(new URLSearchParams('tab=remediation')), 'remediation');
  assert.equal(resolveInboxTab(new URLSearchParams('tab=unknown')), 'confirmations');
  assert.equal(canonicalInboxPath('confirmations'), '/inbox');
  assert.equal(canonicalInboxPath('escalations'), '/inbox?tab=escalations');
  assert.equal(canonicalInboxPath('contacts'), '/inbox?tab=contacts');
  assert.equal(canonicalInboxPath('graph'), '/inbox?tab=graph');
  assert.equal(canonicalInboxPath('cogsec'), '/inbox?tab=cogsec');
  assert.equal(canonicalInboxPath('remediation'), '/inbox?tab=remediation');
});

test('legacy approval, remediation, and retired queue links redirect to canonical destinations', () => {
  assert.equal(canonicalGardenDestination('/confirmations', '', ''), '/inbox');
  assert.equal(canonicalGardenDestination('/escalations', '', ''), '/inbox?tab=escalations');
  assert.equal(canonicalGardenDestination('/contact-approvals', '', ''), '/inbox?tab=contacts');
  assert.equal(canonicalGardenDestination('/graph-proposals', '', ''), '/inbox?tab=graph');
  assert.equal(canonicalGardenDestination('/cognitive-security/approvals', '', ''), '/inbox?tab=cogsec');
  assert.equal(canonicalGardenDestination('/cognitive-security/remediation', '', ''), '/inbox?tab=remediation');
  assert.equal(canonicalGardenDestination('/letters', '', ''), '/chat');
  assert.equal(canonicalGardenDestination('/doing-mirror', '', ''), '/wiki?tab=wishlist');
  assert.equal(
    canonicalGardenDestination(`/companions/${COMPANION_ID}/garden/escalations`, '', ''),
    `/companions/${COMPANION_ID}/garden/inbox?tab=escalations`,
  );
  assert.equal(
    canonicalGardenDestination(`/companions/${COMPANION_ID}/garden/cognitive-security/approvals`, '', ''),
    `/companions/${COMPANION_ID}/garden/inbox?tab=cogsec`,
  );
  assert.equal(canonicalGardenDestination('/inbox', '', ''), null);
  assert.equal(canonicalGardenDestination('/inbox', '?tab=cogsec', ''), null);
});

test('Conversations tabs have canonical, directly addressable URLs', () => {
  assert.equal(resolveConversationsTab(new URLSearchParams()), 'live');
  assert.equal(resolveConversationsTab(new URLSearchParams('tab=live')), 'live');
  assert.equal(resolveConversationsTab(new URLSearchParams('tab=sessions')), 'sessions');
  assert.equal(resolveConversationsTab(new URLSearchParams('tab=recovery')), 'recovery');
  assert.equal(resolveConversationsTab(new URLSearchParams('tab=unknown')), 'live');
  assert.equal(canonicalConversationsPath('live'), '/chat');
  assert.equal(canonicalConversationsPath('sessions'), '/chat?tab=sessions');
  assert.equal(canonicalConversationsPath('recovery'), '/chat?tab=recovery');
});

test('Places tabs have canonical, directly addressable URLs', () => {
  assert.equal(resolvePlacesTab(new URLSearchParams()), 'physical');
  assert.equal(resolvePlacesTab(new URLSearchParams('tab=virtual')), 'virtual');
  assert.equal(resolvePlacesTab(new URLSearchParams('tab=satellites')), 'satellites');
  assert.equal(resolvePlacesTab(new URLSearchParams('tab=arbiter')), 'arbiter');
  assert.equal(resolvePlacesTab(new URLSearchParams('tab=unknown')), 'physical');
  assert.equal(canonicalPlacesPath('physical'), '/places');
  assert.equal(canonicalPlacesPath('virtual'), '/places?tab=virtual');
  assert.equal(canonicalPlacesPath('satellites'), '/places?tab=satellites');
  assert.equal(canonicalPlacesPath('arbiter'), '/places?tab=arbiter');
});

test('legacy location pages redirect to their corresponding Places tab', () => {
  assert.equal(canonicalGardenDestination('/rooms', '', ''), '/places?tab=virtual');
  assert.equal(canonicalGardenDestination('/satellites', '', ''), '/places?tab=satellites');
  assert.equal(canonicalGardenDestination('/room-arbiter', '', ''), '/places?tab=arbiter');
  assert.equal(
    canonicalGardenDestination(`/companions/${COMPANION_ID}/garden/rooms`, '', ''),
    `/companions/${COMPANION_ID}/garden/places?tab=virtual`,
  );
  assert.equal(
    canonicalGardenDestination(`/companions/${COMPANION_ID}/garden/satellites`, '', ''),
    `/companions/${COMPANION_ID}/garden/places?tab=satellites`,
  );
  assert.equal(
    canonicalGardenDestination(`/companions/${COMPANION_ID}/garden/room-arbiter`, '', ''),
    `/companions/${COMPANION_ID}/garden/places?tab=arbiter`,
  );
});

test('Mind & Memory and Contacts hubs resolve canonical tabs and legacy redirects', () => {
  assert.equal(resolveMemoryTab(new URLSearchParams()), 'memories');
  assert.equal(resolveMemoryTab(new URLSearchParams('tab=episodes')), 'episodes');
  assert.equal(resolveMemoryTab(new URLSearchParams('tab=biography')), 'biography');
  assert.equal(resolveMemoryTab(new URLSearchParams('tab=bad')), 'memories');
  assert.equal(canonicalMemoryPath('memories'), '/memory');
  assert.equal(canonicalMemoryPath('episodes'), '/memory?tab=episodes');
  assert.equal(canonicalMemoryPath('biography'), '/memory?tab=biography');

  assert.equal(resolveIdentityTab(new URLSearchParams()), 'card');
  assert.equal(resolveIdentityTab(new URLSearchParams('tab=prompts')), 'prompts');
  assert.equal(resolveIdentityTab(new URLSearchParams('tab=monitor')), 'monitor');
  assert.equal(resolveIdentityTab(new URLSearchParams('tab=values')), 'values');
  assert.equal(resolveIdentityTab(new URLSearchParams('tab=bad')), 'card');
  assert.equal(canonicalIdentityPath('card'), '/identity');
  assert.equal(canonicalIdentityPath('prompts'), '/identity?tab=prompts');
  assert.equal(canonicalIdentityPath('monitor'), '/identity?tab=monitor');
  assert.equal(canonicalIdentityPath('values'), '/identity?tab=values');

  assert.equal(resolveKnowledgeTab(new URLSearchParams()), 'wiki');
  assert.equal(resolveKnowledgeTab(new URLSearchParams('tab=concerns')), 'concerns');
  assert.equal(resolveKnowledgeTab(new URLSearchParams('tab=wishlist')), 'wishlist');
  assert.equal(resolveKnowledgeTab(new URLSearchParams('tab=images')), 'images');
  assert.equal(resolveKnowledgeTab(new URLSearchParams('tab=bad')), 'wiki');
  assert.equal(canonicalKnowledgePath('wiki'), '/wiki');
  assert.equal(canonicalKnowledgePath('concerns'), '/wiki?tab=concerns');
  assert.equal(canonicalKnowledgePath('wishlist'), '/wiki?tab=wishlist');
  assert.equal(canonicalKnowledgePath('images'), '/wiki?tab=images');

  assert.equal(resolveContactsTab(new URLSearchParams()), 'contacts');
  assert.equal(resolveContactsTab(new URLSearchParams('tab=enrollment')), 'enrollment');
  assert.equal(resolveContactsTab(new URLSearchParams('tab=bad')), 'contacts');
  assert.equal(canonicalContactsPath('contacts'), '/contacts');
  assert.equal(canonicalContactsPath('enrollment'), '/contacts?tab=enrollment');

  assert.equal(canonicalGardenDestination('/episodic-memory', '', ''), '/memory?tab=episodes');
  assert.equal(canonicalGardenDestination('/biographical-profile', '', ''), '/memory?tab=biography');
  assert.equal(canonicalGardenDestination('/prompts', '', ''), '/identity?tab=prompts');
  assert.equal(canonicalGardenDestination('/prompt-monitor', '', ''), '/identity?tab=monitor');
  assert.equal(canonicalGardenDestination('/values', '', ''), '/identity?tab=values');
  assert.equal(canonicalGardenDestination('/concerns', '', ''), '/wiki?tab=concerns');
  assert.equal(canonicalGardenDestination('/wishlist', '', ''), '/wiki?tab=wishlist');
  assert.equal(canonicalGardenDestination('/images', '', ''), '/wiki?tab=images');
  assert.equal(canonicalGardenDestination('/enrollment', '', ''), '/contacts?tab=enrollment');
  assert.equal(
    canonicalGardenDestination(`/companions/${COMPANION_ID}/garden/prompts`, '', ''),
    `/companions/${COMPANION_ID}/garden/identity?tab=prompts`,
  );
  assert.equal(
    canonicalGardenDestination(`/companions/${COMPANION_ID}/garden/enrollment`, '', ''),
    `/companions/${COMPANION_ID}/garden/contacts?tab=enrollment`,
  );
});

test('legacy conversation, session, and model-room links redirect to unified Conversations tabs', () => {
  assert.equal(canonicalGardenDestination('/model-room', '', ''), '/chat');
  assert.equal(canonicalGardenDestination('/sessions', '', ''), '/chat?tab=sessions');
  assert.equal(canonicalGardenDestination('/session-recovery', '', ''), '/chat?tab=recovery');
  assert.equal(canonicalGardenDestination('/transcripts', '', ''), '/chat?tab=sessions');
  assert.equal(canonicalGardenDestination('/chat', '?tab=transcripts', ''), '/chat?tab=sessions');
  assert.equal(canonicalGardenDestination('/chat', '', '#transcripts'), '/chat?tab=sessions');
  assert.equal(
    canonicalGardenDestination(`/companions/${COMPANION_ID}/garden/model-room`, '', ''),
    `/companions/${COMPANION_ID}/garden/chat`,
  );
  assert.equal(
    canonicalGardenDestination(`/companions/${COMPANION_ID}/garden/sessions`, '', ''),
    `/companions/${COMPANION_ID}/garden/chat?tab=sessions`,
  );
  assert.equal(
    canonicalGardenDestination(`/companions/${COMPANION_ID}/garden/session-recovery`, '', ''),
    `/companions/${COMPANION_ID}/garden/chat?tab=recovery`,
  );
  assert.equal(
    canonicalGardenDestination(
      `/companions/${COMPANION_ID}/garden/chat`,
      '?tab=transcripts',
      '',
    ),
    `/companions/${COMPANION_ID}/garden/chat?tab=sessions`,
  );
  assert.equal(canonicalGardenDestination('/chat', '', ''), null);
  assert.equal(canonicalGardenDestination('/chat', '?tab=sessions', ''), null);
  assert.equal(canonicalGardenDestination('/chat', '?tab=recovery', ''), null);
  assert.equal(canonicalGardenDestination('/places', '?tab=virtual', ''), null);
});

test('the shared Garden layout applies canonical redirects before old surfaces can load data', () => {
  const layout = readFileSync(
    fileURLToPath(new URL('../../routes/+layout.svelte', import.meta.url)),
    'utf8',
  );

  assert.match(layout, /canonicalGardenDestination\(\s*gardenPathname,/u);
  assert.match(layout, /window\.location\.replace\(destination\)/u);
});
