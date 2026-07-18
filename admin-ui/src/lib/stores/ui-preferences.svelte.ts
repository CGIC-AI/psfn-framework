import { getSettings, updateSettings } from '$lib/api/endpoints/settings';
import {
  DEFAULT_THEME_PACK_ID,
  applyThemeCssVariables,
  listThemePacks,
  resolveThemePack,
  resolveThemePackId,
} from '$lib/theme/loader';
import type { ThemePackDefinition } from '$lib/theme/schema';
import { onCompanionScopeChange } from '$lib/fleet/companion-scope';

let selectedThemeId = $state(DEFAULT_THEME_PACK_ID);
let resolvedFromServer = $state(false);
let loadPromise: Promise<string> | null = null;
let scopeGeneration = 0;

function applyResolvedTheme(themeId: unknown): string {
  selectedThemeId = resolveThemePackId(themeId);
  applyThemeCssVariables(resolveThemePack(selectedThemeId));
  return selectedThemeId;
}

applyResolvedTheme(DEFAULT_THEME_PACK_ID);

onCompanionScopeChange(() => {
  scopeGeneration += 1;
  resolvedFromServer = false;
  loadPromise = null;
  applyResolvedTheme(DEFAULT_THEME_PACK_ID);
});

export function getSelectedThemeId(): string {
  return selectedThemeId;
}

export function getActiveThemePack(): ThemePackDefinition {
  return resolveThemePack(selectedThemeId);
}

export function getAvailableThemePacks(): readonly ThemePackDefinition[] {
  return listThemePacks();
}

export function hasResolvedUiPreferences(): boolean {
  return resolvedFromServer;
}

export async function ensureUiPreferencesLoaded(forceRefresh = false): Promise<string> {
  if (resolvedFromServer && !forceRefresh) return selectedThemeId;
  if (loadPromise && !forceRefresh) return loadPromise;

  const generation = scopeGeneration;
  const current = (async () => {
    try {
      const settings = await getSettings();
      if (generation === scopeGeneration) applyResolvedTheme(settings.config.uiThemeId);
    } catch {
      if (generation === scopeGeneration) applyResolvedTheme(selectedThemeId);
    } finally {
      if (generation === scopeGeneration) resolvedFromServer = true;
    }
    return selectedThemeId;
  })();
  loadPromise = current;
  void current.finally(() => {
    if (loadPromise === current) loadPromise = null;
  });

  return loadPromise;
}

export async function saveSelectedTheme(themeId: unknown): Promise<{
  ok: boolean;
  message: string;
  validationErrors?: Array<{ field: string; message: string; code?: string }>;
}> {
  const nextThemeId = resolveThemePackId(themeId);
  const result = await updateSettings({ uiThemeId: nextThemeId });
  if (!result.ok) return result;
  applyResolvedTheme(nextThemeId);
  return result;
}
