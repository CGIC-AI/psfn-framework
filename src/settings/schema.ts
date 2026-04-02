import type { EditableSettings, SettingsDomainSplit } from './contracts.js';
import {
  normalizeCanonicalModelRegistry,
  projectCanonicalModelRegistry,
} from './schema-model-registry.js';
import {
  normalizeContextControlSettings,
  toPromotedToolList,
} from './schema-runtime-normalization.js';

const MODEL_SETTINGS_KEYS: ReadonlyArray<keyof EditableSettings> = [
  'modelRegistry',
];

const LEGACY_MODEL_SETTINGS_KEYS: ReadonlyArray<keyof EditableSettings> = [
  'primaryModel',
  'primaryProvider',
  'primaryMaxTokens',
  'extractionModel',
  'extractionProvider',
  'extractionMaxTokens',
  'modelCatalog',
  'modelRoleAssignments',
  'modelRoster',
];

const NON_RUNTIME_SETTINGS_KEYS: ReadonlyArray<keyof EditableSettings> = [
  ...MODEL_SETTINGS_KEYS,
  ...LEGACY_MODEL_SETTINGS_KEYS,
  'maintenanceIntervalMs',
  'capabilityTier',
];

export { normalizeCanonicalModelRegistry, toPromotedToolList };

export function hasLegacyModelSettingsPayload(settings: EditableSettings): boolean {
  return LEGACY_MODEL_SETTINGS_KEYS.some((key) => settings[key] !== undefined);
}

export function hasModelSettings(settings: EditableSettings): boolean {
  return settings.modelRegistry !== undefined;
}

export function extractModelSettings(settings: EditableSettings): EditableSettings {
  return settings.modelRegistry !== undefined
    ? { modelRegistry: settings.modelRegistry }
    : {};
}

export function splitSettingsByDomain(settings: EditableSettings): SettingsDomainSplit {
  const runtime: EditableSettings = { ...settings };
  for (const key of NON_RUNTIME_SETTINGS_KEYS) {
    delete runtime[key];
  }

  const legacyKeys: string[] = [];
  for (const key of NON_RUNTIME_SETTINGS_KEYS) {
    if (settings[key] !== undefined) {
      legacyKeys.push(key);
    }
  }

  return {
    runtime,
    models: extractModelSettings(settings),
    ...(settings.maintenanceIntervalMs !== undefined
      ? { maintenanceIntervalMs: settings.maintenanceIntervalMs }
      : {}),
    ...(settings.capabilityTier !== undefined
      ? { capabilityTier: settings.capabilityTier }
      : {}),
    legacyKeys,
  };
}

export function toRuntimeOwnedSettings(settings: EditableSettings): EditableSettings {
  return splitSettingsByDomain(settings).runtime;
}

export function normalizeEditableSettings(
  settings: EditableSettings,
  options?: { defaultContextWindow?: number },
): EditableSettings {
  const normalizedInput = normalizeContextControlSettings(settings);

  const hasLegacyModelInputs = hasLegacyModelSettingsPayload(normalizedInput);
  if (!hasModelSettings(normalizedInput)) {
    if (hasLegacyModelInputs) {
      throw new Error(
        'Legacy model settings are not accepted in this slice; provide models.modelRegistry payloads only',
      );
    }
    return { ...normalizedInput };
  }

  if (hasLegacyModelInputs) {
    throw new Error(
      'Model settings cannot mix modelRegistry with legacy primary/extraction/slot payloads',
    );
  }

  const normalizedRegistry = normalizeCanonicalModelRegistry(normalizedInput.modelRegistry, 'settings.modelRegistry');
  const projected = projectCanonicalModelRegistry(normalizedRegistry, options);
  const normalized: EditableSettings = {
    ...normalizedInput,
    ...projected,
    modelRegistry: normalizedRegistry,
  };
  return normalized;
}
