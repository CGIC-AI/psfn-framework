import gardenPackJson from './packs/garden.json';
import genericLightPackJson from './packs/generic-light.json';
import genericDarkPackJson from './packs/generic-dark.json';
import { type ThemePackDefinition, validateThemePack } from './schema';

export const DEFAULT_THEME_PACK_ID = 'garden';

const BUILTIN_PACK_SOURCES = [
  ['garden.json', gardenPackJson],
  ['generic-light.json', genericLightPackJson],
  ['generic-dark.json', genericDarkPackJson],
] as const;

const BUILTIN_THEME_PACKS: ThemePackDefinition[] = BUILTIN_PACK_SOURCES
  .map(([sourceName, pack]) => validateThemePack(pack, sourceName));

const THEME_PACK_BY_ID = new Map<string, ThemePackDefinition>();
for (const pack of BUILTIN_THEME_PACKS) {
  if (THEME_PACK_BY_ID.has(pack.id)) {
    throw new Error(`Duplicate theme id "${pack.id}" in built-in theme packs`);
  }
  THEME_PACK_BY_ID.set(pack.id, pack);
}
if (!THEME_PACK_BY_ID.has(DEFAULT_THEME_PACK_ID)) {
  throw new Error(`Missing default theme pack "${DEFAULT_THEME_PACK_ID}"`);
}

const TEMPLATE_TOKEN_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;
let appliedCssVariableKeys = new Set<string>();

export interface ThemeTemplateContext {
  companionName: string;
}

export interface ResolvedThemeMenuLabel {
  primaryLabel: string;
  secondaryLabel: string | null;
}

export function listThemePacks(): readonly ThemePackDefinition[] {
  return BUILTIN_THEME_PACKS;
}

export function resolveThemePackId(themeId: unknown): string {
  if (typeof themeId !== 'string') return DEFAULT_THEME_PACK_ID;
  const trimmed = themeId.trim();
  if (!trimmed) return DEFAULT_THEME_PACK_ID;
  return THEME_PACK_BY_ID.has(trimmed) ? trimmed : DEFAULT_THEME_PACK_ID;
}

export function resolveThemePack(themeId: unknown): ThemePackDefinition {
  const resolvedId = resolveThemePackId(themeId);
  return THEME_PACK_BY_ID.get(resolvedId) ?? THEME_PACK_BY_ID.get(DEFAULT_THEME_PACK_ID)!;
}

export function resolveThemeTemplate(
  template: string,
  context: ThemeTemplateContext,
): string {
  return template.replace(
    TEMPLATE_TOKEN_PATTERN,
    (_fullToken, tokenName: keyof ThemeTemplateContext) => context[tokenName] ?? '',
  ).trim();
}

export function resolveThemeMenuLabel(
  theme: ThemePackDefinition,
  menuKey: string,
  fallbackLabel: string,
  context: ThemeTemplateContext,
): ResolvedThemeMenuLabel {
  const rawLabel = theme.ui.menuLabels?.[menuKey];
  if (!rawLabel) {
    return {
      primaryLabel: fallbackLabel,
      secondaryLabel: null,
    };
  }

  const resolvedLabel = resolveThemeTemplate(rawLabel, context);
  if (!resolvedLabel || resolvedLabel === fallbackLabel) {
    return {
      primaryLabel: fallbackLabel,
      secondaryLabel: null,
    };
  }

  return {
    primaryLabel: resolvedLabel,
    secondaryLabel: fallbackLabel,
  };
}

export function applyThemeCssVariables(
  theme: ThemePackDefinition,
  target: HTMLElement | null | undefined = typeof document === 'undefined'
    ? null
    : document.documentElement,
): void {
  if (!target) return;

  for (const key of appliedCssVariableKeys) {
    if (!(key in theme.cssVariables)) {
      target.style.removeProperty(key);
    }
  }

  for (const [key, value] of Object.entries(theme.cssVariables)) {
    target.style.setProperty(key, value);
  }

  target.dataset.themeId = theme.id;
  appliedCssVariableKeys = new Set(Object.keys(theme.cssVariables));
}
