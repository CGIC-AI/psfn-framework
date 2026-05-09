// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALL_TOOL_FILTERS,
  countInventoryTools,
  defaultToolInventoryFilters,
  deriveToolInventoryFilterOptions,
  filterInventoryGroups,
  hasActiveToolInventoryFilters,
} from './filter-tools';

function tool(name, overrides = {}) {
  return {
    name,
    description: `${name} description`,
    scope: 'extended',
    health: {
      status: 'healthy',
      detail: 'ready',
    },
    contexts: {
      chat: {
        status: 'available',
        detail: 'chat ready',
      },
      internalHeartbeat: {
        status: 'available',
        detail: 'heartbeat ready',
      },
    },
    ...overrides,
  };
}

const groups = [
  {
    key: 'control_surface',
    title: 'Control Surface',
    detail: 'Core selector tools',
    accent: 'bg-moss-400',
    tools: [
      tool('tool_search', {
        description: 'Search for deferred runtime tools',
        scope: 'core',
        contexts: {
          chat: { status: 'active', detail: 'active in chat' },
          internalHeartbeat: { status: 'available', detail: 'heartbeat ready' },
        },
      }),
      tool('toolset', {
        description: 'Activate managed tool groups',
        scope: 'core',
        health: { status: 'degraded', detail: 'gateway slow' },
      }),
    ],
  },
  {
    key: 'managed_toolset',
    title: 'Managed Toolset',
    detail: 'Loaded extended tools',
    accent: 'bg-gold-400',
    tools: [
      tool('repo_status', {
        description: 'Inspect git working tree status',
        contexts: {
          chat: { status: 'available', detail: 'chat ready' },
          internalHeartbeat: { status: 'not_applicable', detail: 'not used by heartbeat' },
        },
      }),
      tool('notify', {
        description: 'Send operator notifications',
        health: { status: 'unavailable', detail: 'ntfy missing' },
        contexts: {
          chat: { status: 'unavailable', detail: 'ntfy missing' },
          internalHeartbeat: { status: 'unavailable', detail: 'ntfy missing' },
        },
      }),
    ],
  },
];

test('filters inventory groups by tool name and description terms', () => {
  const filtered = filterInventoryGroups(groups, {
    ...defaultToolInventoryFilters(),
    query: 'git status',
  });

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].key, 'managed_toolset');
  assert.deepEqual(filtered[0].tools.map(item => item.name), ['repo_status']);
});

test('combines group, scope, health, chat, and heartbeat filters', () => {
  const filtered = filterInventoryGroups(groups, {
    query: '',
    groupKey: 'managed_toolset',
    scope: 'extended',
    healthStatus: 'unavailable',
    chatStatus: 'unavailable',
    heartbeatStatus: 'unavailable',
  });

  assert.equal(countInventoryTools(filtered), 1);
  assert.equal(filtered[0].tools[0].name, 'notify');
});

test('derives filter options from values present in inventory data', () => {
  const options = deriveToolInventoryFilterOptions(groups);

  assert.deepEqual(options.groups.map(option => [option.value, option.count]), [
    ['control_surface', 2],
    ['managed_toolset', 2],
  ]);
  assert.deepEqual(options.scopes.map(option => [option.value, option.count]), [
    ['core', 2],
    ['extended', 2],
  ]);
  assert.deepEqual(options.healthStatuses.map(option => option.value), [
    'healthy',
    'degraded',
    'unavailable',
  ]);
  assert.deepEqual(options.chatStatuses.map(option => option.value), [
    'active',
    'available',
    'unavailable',
  ]);
  assert.deepEqual(options.heartbeatStatuses.map(option => option.value), [
    'available',
    'unavailable',
    'not_applicable',
  ]);
});

test('detects when inventory filters are active', () => {
  assert.equal(hasActiveToolInventoryFilters(defaultToolInventoryFilters()), false);
  assert.equal(hasActiveToolInventoryFilters({
    ...defaultToolInventoryFilters(),
    groupKey: ALL_TOOL_FILTERS,
    query: '   ',
  }), false);
  assert.equal(hasActiveToolInventoryFilters({
    ...defaultToolInventoryFilters(),
    scope: 'core',
  }), true);
});
