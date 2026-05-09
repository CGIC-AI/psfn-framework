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

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.trim().replace(/^#/, '');
  assert.equal(normalized.length, 6, `Expected 6-digit hex color, got "${hex}"`);
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const toLinear = (channel: number): number => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  return (0.2126 * lr) + (0.7152 * lg) + (0.0722 * lb);
}

function contrastRatio(foregroundHex: string, backgroundHex: string): number {
  const fg = relativeLuminance(foregroundHex);
  const bg = relativeLuminance(backgroundHex);
  const [lighter, darker] = fg >= bg ? [fg, bg] : [bg, fg];
  return (lighter + 0.05) / (darker + 0.05);
}

function assertContrastAtLeast(
  foregroundHex: string,
  backgroundHex: string,
  minRatio: number,
  context: string,
): void {
  const ratio = contrastRatio(foregroundHex, backgroundHex);
  assert.ok(
    ratio >= minRatio,
    `${context} contrast ${ratio.toFixed(2)} is below minimum ${minRatio.toFixed(2)}`,
  );
}

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

test('keeps technical menu labels primary when a theme provides cute labels', () => {
  const garden = resolveThemePack('garden');
  const resolved = resolveThemeMenuLabel(
    garden,
    'tools',
    'Tools',
    { companionName: 'Orchid' },
  );
  assert.deepEqual(resolved, {
    primaryLabel: 'Tools',
    secondaryLabel: 'The Shed',
  });
});

test('supports companion-name template substitution', () => {
  const garden = resolveThemePack('garden');
  assert.equal(
    resolveThemeTemplate(garden.ui.sidebarTitleTemplate, { companionName: 'Aimi' }),
    "Aimi's Garden",
  );
});

test('generic-dark keeps page-level class pairings readable', () => {
  const dark = resolveThemePack('generic-dark');
  const css = dark.cssVariables;

  const bark50 = css['--color-bark-50'];
  const bark100 = css['--color-bark-100'];
  const bark700 = css['--color-bark-700'];
  const bark900 = css['--color-bark-900'];
  const shadow50 = css['--color-shadow-50'];
  const shadow200 = css['--color-shadow-200'];
  const shadow600 = css['--color-shadow-600'];
  const shadow700 = css['--color-shadow-700'];
  const shadow800 = css['--color-shadow-800'];
  const shadow900 = css['--color-shadow-900'];
  const gold50 = css['--color-gold-50'];
  const gold600 = css['--color-gold-600'];
  const gold700 = css['--color-gold-700'];
  const moss50 = css['--color-moss-50'];
  const moss600 = css['--color-moss-600'];
  const moss700 = css['--color-moss-700'];
  const wilt600 = css['--color-wilt-600'];

  assert.ok(bark50 && bark100 && bark700 && bark900);
  assert.ok(shadow50 && shadow200 && shadow600 && shadow700 && shadow800 && shadow900);
  assert.ok(gold50 && gold600 && gold700);
  assert.ok(moss50 && moss600 && moss700 && wilt600);

  // Dashboard/chat/settings/theme: bark text hierarchy on core dark surfaces.
  assertContrastAtLeast(bark900, bark100, 7, 'Dashboard/chat/settings/theme primary text');
  assertContrastAtLeast(bark700, bark100, 4.5, 'Dashboard/chat/settings/theme secondary text');
  assertContrastAtLeast(bark700, bark50, 4.5, 'Sidebar secondary text');

  // text-shadow-* pairings used directly by dashboard/chat/settings/theme pages.
  assertContrastAtLeast(shadow900, bark100, 4.5, 'Dashboard stat values: text-shadow-900 on bg-bark-100');
  assertContrastAtLeast(shadow700, bark100, 4, 'Dashboard/settings labels: text-shadow-700 on bg-bark-100');
  assertContrastAtLeast(shadow800, bark50, 4, 'Theme preview title: text-shadow-800 on bg-bark-50');
  assertContrastAtLeast(shadow600, bark50, 3, 'Theme preview subtitle: text-shadow-600 on bg-bark-50');
  assertContrastAtLeast(shadow900, '#ffffff', 4, 'Chat/settings inputs: text-shadow-900 on bg-white');
  assertContrastAtLeast(shadow800, '#ffffff', 4, 'Card body text: text-shadow-800 on bg-white');
  assertContrastAtLeast(shadow700, shadow50, 3.5, 'Dashboard reflection badge: text-shadow-700 on bg-shadow-50');
  assertContrastAtLeast(shadow200, shadow50, 1.2, 'Dashboard reflection badge border: border-shadow-200 on bg-shadow-50');

  // Accent and state tokens used by primary actions and status chips.
  assertContrastAtLeast(gold700, gold50, 4.5, 'Active navigation text');
  assertContrastAtLeast('#ffffff', gold600, 4.5, 'Primary action text');
  assertContrastAtLeast('#ffffff', gold700, 4.5, 'Primary action hover text');
  assertContrastAtLeast(moss700, moss50, 4.5, 'Success chip text');
  assertContrastAtLeast('#ffffff', moss600, 4.5, 'Success action text');
  assertContrastAtLeast('#ffffff', wilt600, 4.5, 'Destructive action text');
});
