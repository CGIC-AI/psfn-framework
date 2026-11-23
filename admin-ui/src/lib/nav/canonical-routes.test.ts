import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  canonicalAutonomyPath,
  canonicalContactsPath,
  canonicalConversationsPath,
  canonicalGardenDestination,
  canonicalIdentityPath,
  canonicalInboxPath,
  canonicalKnowledgePath,
  canonicalMemoryPath,
  canonicalModelsPath,
  canonicalPlacesPath,
  canonicalSafetyPath,
  canonicalToolsPath,
  resolveAutonomyTab,
  resolveContactsTab,
  resolveConversationsTab,
  resolveIdentityTab,
  resolveInboxTab,
  resolveKnowledgeTab,
  resolveMemoryTab,
  resolveModelsTab,
  resolvePlacesTab,
  resolveSafetyTab,
  resolveToolsTab,
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

test('Runtime & Safety hubs resolve canonical tabs and legacy redirects', () => {
  assert.equal(resolveAutonomyTab(new URLSearchParams()), 'autonomy');
  assert.equal(resolveAutonomyTab(new URLSearchParams('tab=scheduler')), 'scheduler');
  assert.equal(resolveAutonomyTab(new URLSearchParams('tab=action-pipe')), 'action-pipe');
  assert.equal(resolveAutonomyTab(new URLSearchParams('tab=automata')), 'automata');
  assert.equal(resolveAutonomyTab(new URLSearchParams('tab=bad')), 'autonomy');
  assert.equal(canonicalAutonomyPath('autonomy'), '/autonomy');
  assert.equal(canonicalAutonomyPath('scheduler'), '/autonomy?tab=scheduler');
  assert.equal(canonicalAutonomyPath('action-pipe'), '/autonomy?tab=action-pipe');
  assert.equal(canonicalAutonomyPath('automata'), '/autonomy?tab=automata');

  assert.equal(resolveToolsTab(new URLSearchParams()), 'tools');
  assert.equal(resolveToolsTab(new URLSearchParams('tab=skills')), 'skills');
  assert.equal(resolveToolsTab(new URLSearchParams('tab=workbench')), 'workbench');
  assert.equal(resolveToolsTab(new URLSearchParams('tab=shards')), 'shards');
  assert.equal(resolveToolsTab(new URLSearchParams('tab=bad')), 'tools');
  assert.equal(canonicalToolsPath('tools'), '/tools');
  assert.equal(canonicalToolsPath('skills'), '/tools?tab=skills');
  assert.equal(canonicalToolsPath('workbench'), '/tools?tab=workbench');
  assert.equal(canonicalToolsPath('shards'), '/tools?tab=shards');

  assert.equal(resolveModelsTab(new URLSearchParams()), 'models');
  assert.equal(resolveModelsTab(new URLSearchParams('tab=charges')), 'charges');
  assert.equal(resolveModelsTab(new URLSearchParams('tab=token-usage')), 'token-usage');
  assert.equal(resolveModelsTab(new URLSearchParams('tab=fleet-costs')), 'fleet-costs');
  assert.equal(resolveModelsTab(new URLSearchParams('tab=bad')), 'models');
  assert.equal(canonicalModelsPath('models'), '/models');
  assert.equal(canonicalModelsPath('charges'), '/models?tab=charges');
  assert.equal(canonicalModelsPath('token-usage'), '/models?tab=token-usage');
  assert.equal(canonicalModelsPath('fleet-costs'), '/models?tab=fleet-costs');

  assert.equal(resolveSafetyTab(new URLSearchParams()), 'health');
  assert.equal(resolveSafetyTab(new URLSearchParams('tab=events')), 'events');
  assert.equal(resolveSafetyTab(new URLSearchParams('tab=firewall')), 'firewall');
  assert.equal(resolveSafetyTab(new URLSearchParams('tab=drift')), 'drift');
  assert.equal(resolveSafetyTab(new URLSearchParams('tab=custody')), 'custody');
  assert.equal(resolveSafetyTab(new URLSearchParams('tab=evals')), 'evals');
  assert.equal(resolveSafetyTab(new URLSearchParams('tab=bad')), 'health');
  assert.equal(canonicalSafetyPath('health'), '/subsystem-health');
  assert.equal(canonicalSafetyPath('events'), '/subsystem-health?tab=events');
  assert.equal(canonicalSafetyPath('firewall'), '/subsystem-health?tab=firewall');
  assert.equal(canonicalSafetyPath('drift'), '/subsystem-health?tab=drift');
  assert.equal(canonicalSafetyPath('custody'), '/subsystem-health?tab=custody');
  assert.equal(canonicalSafetyPath('evals'), '/subsystem-health?tab=evals');

  assert.equal(canonicalGardenDestination('/scheduler', '', ''), '/autonomy?tab=scheduler');
  assert.equal(canonicalGardenDestination('/action-pipe', '', ''), '/autonomy?tab=action-pipe');
  assert.equal(canonicalGardenDestination('/automata', '', ''), '/autonomy?tab=automata');
  assert.equal(canonicalGardenDestination('/skills', '', ''), '/tools?tab=skills');
  assert.equal(canonicalGardenDestination('/analysis-workbench', '', ''), '/tools?tab=workbench');
  assert.equal(canonicalGardenDestination('/shards', '', ''), '/tools?tab=shards');
  assert.equal(canonicalGardenDestination('/shards/shard-123', '', ''), null);
  assert.equal(canonicalGardenDestination('/charge-budget', '', ''), '/models?tab=charges');
  assert.equal(
    canonicalGardenDestination('/charge-budget', '?tab=token-usage&range=today', ''),
    '/models?tab=token-usage&range=today',
  );
  assert.equal(canonicalGardenDestination('/fleet-costs', '', ''), '/models?tab=fleet-costs');
  assert.equal(canonicalGardenDestination('/telemetry', '', ''), '/subsystem-health?tab=events');
  assert.equal(
    canonicalGardenDestination('/cognitive-security/firewall', '', ''),
    '/subsystem-health?tab=firewall',
  );
  assert.equal(
    canonicalGardenDestination('/cognitive-security/drift', '', ''),
    '/subsystem-health?tab=drift',
  );
  assert.equal(
    canonicalGardenDestination('/cognitive-security/custody', '', ''),
    '/subsystem-health?tab=custody',
  );
  assert.equal(
    canonicalGardenDestination('/evals/emotion-sidecar', '', ''),
    '/subsystem-health?tab=evals',
  );
  assert.equal(
    canonicalGardenDestination(`/companions/${COMPANION_ID}/garden/telemetry`, '', ''),
    `/companions/${COMPANION_ID}/garden/subsystem-health?tab=events`,
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
