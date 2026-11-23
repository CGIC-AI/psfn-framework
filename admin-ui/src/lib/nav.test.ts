import assert from 'node:assert/strict';
import { test } from 'vitest';
import { resolveThemeMenuLabel, resolveThemePack } from './theme/loader';
import { navGroups, navItems } from './nav';

test('operator guide replaces the primer without changing its route slot', () => {
  const guide = navItems.find(item => item.id === 'operator-guide');

  assert.ok(guide);
  assert.deepEqual(guide, {
    id: 'operator-guide',
    path: '/primer',
    defaultLabel: 'Operator Guide',
    icon: '\u{1F4DA}',
    groupId: 'configure',
  });
  assert.equal(navItems.some(item => item.id === 'primer'), false);
  assert.deepEqual(
    resolveThemeMenuLabel(resolveThemePack('garden'), guide.id, guide.defaultLabel, {
      companionName: 'Orchid',
    }),
    {
      primaryLabel: 'Operator Guide',
      secondaryLabel: 'The Field Guide',
    },
  );
});

test('Garden sidebar exposes exactly 4 groups and 16 consolidated hub destinations', () => {
  assert.deepEqual(
    navGroups.map(group => ({ id: group.id, count: group.items.length })),
    [
      { id: 'operate', count: 4 },
      { id: 'memory', count: 4 },
      { id: 'runtime', count: 4 },
      { id: 'configure', count: 4 },
    ],
  );
  assert.equal(navItems.length, 16);

  const runtimeHubs = navItems
    .filter(item => item.groupId === 'runtime')
    .map(item => ({ id: item.id, path: item.path, defaultLabel: item.defaultLabel }));
  assert.deepEqual(runtimeHubs, [
    { id: 'autonomy', path: '/autonomy', defaultLabel: 'Autonomy & Schedule' },
    { id: 'tools', path: '/tools', defaultLabel: 'Tools & Skills' },
    { id: 'models', path: '/models', defaultLabel: 'Models & Usage' },
    { id: 'subsystem-health', path: '/subsystem-health', defaultLabel: 'Safety & Health' },
  ]);

  const absorbedRuntimeIds = new Set([
    'scheduler',
    'automata',
    'action-pipe',
    'skills',
    'analysis-workbench',
    'shards',
    'charge-budget',
    'fleet-costs',
    'telemetry',
    'cogsec-firewall',
    'cogsec-drift',
    'cogsec-custody',
    'evals-emotion-sidecar',
  ]);
  assert.equal(navItems.some(item => absorbedRuntimeIds.has(item.id)), false);
});

test('Places is the only world-location destination in the operator navigation', () => {
  const locationItems = navItems.filter(item => (
    item.id === 'places'
    || item.id === 'satellites'
    || item.id === 'rooms'
    || item.id === 'room-arbiter'
  ));

  assert.deepEqual(locationItems, [{
    id: 'places',
    path: '/places',
    defaultLabel: 'Places',
    icon: '\u{1F5FA}\u{FE0F}',
    groupId: 'operate',
  }]);
});

test('Mind & Memory collapses into 4 canonical tabbed hubs without absorbed sub-routes', () => {
  const absorbedIds = new Set([
    'biographical-profile',
    'episodic-memory',
    'prompts',
    'prompt-monitor',
    'values',
    'concerns',
    'wishlist',
    'images',
    'enrollment',
  ]);
  assert.equal(navItems.some(item => absorbedIds.has(item.id)), false);

  const mindMemory = navItems
    .filter(item => item.groupId === 'memory')
    .map(item => ({ id: item.id, path: item.path, defaultLabel: item.defaultLabel }));
  assert.deepEqual(mindMemory, [
    { id: 'memory', path: '/memory', defaultLabel: 'Memory' },
    { id: 'identity', path: '/identity', defaultLabel: 'Identity & Prompts' },
    { id: 'wiki', path: '/wiki', defaultLabel: 'Knowledge & Work' },
    { id: 'contacts', path: '/contacts', defaultLabel: 'Contacts' },
  ]);
});

test('Conversations is the single chat and session destination in the operator navigation', () => {
  const conversationItems = navItems.filter(item => (
    item.id === 'chat' || item.id === 'sessions' || item.id === 'session-recovery'
  ));

  assert.deepEqual(conversationItems, [{
    id: 'chat',
    path: '/chat',
    defaultLabel: 'Conversations',
    icon: '\u{1F4AC}',
    groupId: 'operate',
  }]);
});

test('Inbox unifies operator approval and review queues and drops retired Letters and Doing Mirror nav items', () => {
  const queueIds = new Set([
    'inbox',
    'confirmations',
    'escalations',
    'contact-approvals',
    'graph-proposals',
    'cogsec-approvals',
    'cogsec-remediation',
    'letters',
    'doing-mirror',
  ]);
  const matched = navItems.filter(item => queueIds.has(item.id));

  assert.deepEqual(matched, [{
    id: 'inbox',
    path: '/inbox',
    defaultLabel: 'Inbox',
    icon: '\u{1F4E5}',
    groupId: 'operate',
  }]);
});
