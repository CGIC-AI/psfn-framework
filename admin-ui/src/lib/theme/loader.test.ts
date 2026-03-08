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

test('supports companion-name template substitution', () => {
  const garden = resolveThemePack('garden');
  assert.equal(
    resolveThemeTemplate(garden.ui.sidebarTitleTemplate, { companionName: 'Aimi' }),
    "Aimi's Garden",
  );
});

test('generic-dark keeps key text and interactive tokens readable', () => {
  const dark = resolveThemePack('generic-dark');
  const css = dark.cssVariables;

  const bark50 = css['--color-bark-50'];
  const bark100 = css['--color-bark-100'];
  const bark700 = css['--color-bark-700'];
  const bark900 = css['--color-bark-900'];
  const gold50 = css['--color-gold-50'];
  const gold600 = css['--color-gold-600'];
  const gold700 = css['--color-gold-700'];
  const wilt600 = css['--color-wilt-600'];

  assert.ok(bark50 && bark100 && bark700 && bark900);
  assert.ok(gold50 && gold600 && gold700 && wilt600);

  assertContrastAtLeast(bark900, bark100, 7, 'Dashboard/chat/settings/theme primary text');
  assertContrastAtLeast(bark700, bark100, 4.5, 'Dashboard/chat/settings/theme secondary text');
  assertContrastAtLeast(bark700, bark50, 4.5, 'Sidebar secondary text');
  assertContrastAtLeast(gold700, gold50, 4.5, 'Active navigation text');
  assertContrastAtLeast('#ffffff', gold600, 4.5, 'Primary action text');
  assertContrastAtLeast('#ffffff', gold700, 4.5, 'Primary action hover text');
  assertContrastAtLeast('#ffffff', wilt600, 4.5, 'Destructive action text');
});
