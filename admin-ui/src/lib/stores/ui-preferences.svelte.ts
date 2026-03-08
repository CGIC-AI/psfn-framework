import { getSettings, updateSettings } from '$lib/api/endpoints/settings';
import {
  DEFAULT_THEME_PACK_ID,
  applyThemeCssVariables,
  listThemePacks,
  resolveThemePack,
  resolveThemePackId,
} from '$lib/theme/loader';
import type { ThemePackDefinition } from '$lib/theme/schema';

let selectedThemeId = $state(DEFAULT_THEME_PACK_ID);
let resolvedFromServer = $state(false);
let loadPromise: Promise<string> | null = null;

function applyResolvedTheme(themeId: unknown): string {
  selectedThemeId = resolveThemePackId(themeId);
  applyThemeCssVariables(resolveThemePack(selectedThemeId));
  return selectedThemeId;
}

applyResolvedTheme(DEFAULT_THEME_PACK_ID);

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

  loadPromise = (async () => {
    try {
      const settings = await getSettings();
      applyResolvedTheme(settings.config.uiThemeId);
    } catch {
      applyResolvedTheme(selectedThemeId);
    } finally {
      resolvedFromServer = true;
      loadPromise = null;
    }
    return selectedThemeId;
  })();

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
