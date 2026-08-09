import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  filterConsoleNavigation,
  resolveActiveNavigationGroup,
  type ConsoleNavigationGroup,
} from './presentation';

const groups: ConsoleNavigationGroup[] = [
  {
    id: 'operate',
    label: 'Live Operations',
    attention: 2,
    items: [
      {
        id: 'dashboard',
        path: '/',
        href: '/garden/companion/dashboard',
        primaryLabel: 'Dashboard',
        secondaryLabel: 'The Trunk',
        icon: '🌳',
        attention: 0,
        active: true,
      },
      {
        id: 'sessions',
        path: '/sessions',
        href: '/garden/companion/sessions',
        primaryLabel: 'Sessions',
        secondaryLabel: 'The Branches',
        icon: '🌲',
        attention: 2,
        active: false,
      },
    ],
  },
  {
    id: 'runtime',
    label: 'Runtime & Tools',
    attention: 0,
    items: [
      {
        id: 'models',
        path: '/models',
        href: '/garden/companion/models',
        primaryLabel: 'Models',
        secondaryLabel: 'The Conservatory',
        icon: '🧪',
        attention: 0,
        active: false,
      },
    ],
  },
];

test('resolves the rail group containing the active destination', () => {
  assert.equal(resolveActiveNavigationGroup(groups), 'operate');
});

test('filters command navigation by primary, secondary, and group labels', () => {
  assert.deepEqual(
    filterConsoleNavigation(groups, 'branches').map(group => group.items.map(item => item.id)),
    [['sessions']],
  );
  assert.deepEqual(
    filterConsoleNavigation(groups, 'runtime').map(group => group.items.map(item => item.id)),
    [['models']],
  );
  assert.deepEqual(
    filterConsoleNavigation(groups, 'dashboard').map(group => group.items.map(item => item.id)),
    [['dashboard']],
  );
});

test('returns all groups for an empty command query without mutating input', () => {
  const result = filterConsoleNavigation(groups, '   ');

  assert.deepEqual(result, groups);
  assert.notEqual(result, groups);
});
