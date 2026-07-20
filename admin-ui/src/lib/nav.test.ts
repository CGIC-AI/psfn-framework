import assert from 'node:assert/strict';
import { test } from 'vitest';
import { resolveThemeMenuLabel, resolveThemePack } from './theme/loader';
import { navItems } from './nav';

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
