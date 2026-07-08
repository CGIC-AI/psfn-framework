import { isRecord } from '../../../../src/shared/utils/types.js';
export interface ThemePackUiConfig {
  appTitleTemplate: string;
  sidebarTitleTemplate: string;
  sidebarSubtitleTemplate: string;
  menuLabels?: Record<string, string>;
}

export interface ThemePackDefinition {
  id: string;
  name: string;
  description: string;
  ui: ThemePackUiConfig;
  cssVariables: Record<string, string>;
}


function requireTrimmedString(
  value: unknown,
  fieldName: string,
  sourceName: string,
): string {
  if (typeof value !== 'string') {
    throw new Error(`Theme pack "${sourceName}" field "${fieldName}" must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Theme pack "${sourceName}" field "${fieldName}" cannot be empty`);
  }
  return trimmed;
}

export function validateThemePack(
  raw: unknown,
  sourceName: string,
): ThemePackDefinition {
  if (!isRecord(raw)) {
    throw new Error(`Theme pack "${sourceName}" must be an object`);
  }

  const id = requireTrimmedString(raw.id, 'id', sourceName);
  const name = requireTrimmedString(raw.name, 'name', sourceName);
  const description = requireTrimmedString(raw.description, 'description', sourceName);

  if (!isRecord(raw.ui)) {
    throw new Error(`Theme pack "${sourceName}" field "ui" must be an object`);
  }
  const ui: ThemePackUiConfig = {
    appTitleTemplate: requireTrimmedString(raw.ui.appTitleTemplate, 'ui.appTitleTemplate', sourceName),
    sidebarTitleTemplate: requireTrimmedString(raw.ui.sidebarTitleTemplate, 'ui.sidebarTitleTemplate', sourceName),
    sidebarSubtitleTemplate: requireTrimmedString(raw.ui.sidebarSubtitleTemplate, 'ui.sidebarSubtitleTemplate', sourceName),
  };

  if (raw.ui.menuLabels !== undefined) {
    if (!isRecord(raw.ui.menuLabels)) {
      throw new Error(`Theme pack "${sourceName}" field "ui.menuLabels" must be an object`);
    }
    const menuLabels: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.ui.menuLabels)) {
      const label = requireTrimmedString(value, `ui.menuLabels.${key}`, sourceName);
      menuLabels[key] = label;
    }
    ui.menuLabels = menuLabels;
  }

  if (!isRecord(raw.cssVariables)) {
    throw new Error(`Theme pack "${sourceName}" field "cssVariables" must be an object`);
  }
  const cssVariables: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw.cssVariables)) {
    if (!key.startsWith('--')) {
      throw new Error(`Theme pack "${sourceName}" css variable "${key}" must start with "--"`);
    }
    cssVariables[key] = requireTrimmedString(value, `cssVariables.${key}`, sourceName);
  }
  if (Object.keys(cssVariables).length === 0) {
    throw new Error(`Theme pack "${sourceName}" must define at least one css variable`);
  }

  return {
    id,
    name,
    description,
    ui,
    cssVariables,
  };
}
