// @ts-nocheck
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_THEME_PACK_ID,
  listThemePacks,
  resolveThemeMenuLabel,
  resolveThemePack,
  resolveThemePackId,
  resolveThemeTemplate,
} from './loader';

test('defaults to garden theme pack', () => {
  assert.equal(DEFAULT_THEME_PACK_ID, 'garden');
  assert.equal(resolveThemePackId(undefined), 'garden');
  assert.equal(resolveThemePack('missing-theme').id, 'garden');
});

test('built-in generic light and dark packs are selectable', () => {
  const ids = listThemePacks().map(pack => pack.id);
  assert.deepEqual(ids, ['garden', 'generic-light', 'generic-dark']);
  assert.equal(resolveThemePackId('generic-light'), 'generic-light');
  assert.equal(resolveThemePackId('generic-dark'), 'generic-dark');
});

test('falls back to standard menu labels when a theme has no cute labels', () => {
  const light = resolveThemePack('generic-light');
  const resolved = resolveThemeMenuLabel(
    light,
    'dashboard',
    'Dashboard',
    { companionName: 'Orchid' },
  );
  assert.deepEqual(resolved, {
    primaryLabel: 'Dashboard',
    secondaryLabel: null,
  });
});

test('supports companion-name template substitution', () => {
  const garden = resolveThemePack('garden');
  assert.equal(
    resolveThemeTemplate(garden.ui.sidebarTitleTemplate, { companionName: 'Aimi' }),
    "Aimi's Garden",
  );
});
