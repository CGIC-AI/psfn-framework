import {
  RUNTIME_SETTINGS_KEYS,
  type EditableSettings,
  type SettingsDomainSplit,
} from './contracts.js';
import { normalizeContextControlSettings, toPromotedToolList } from './schema-runtime-normalization.js';
import {
  normalizeCanonicalModelRegistry,
  projectCanonicalModelRegistry,
} from './schema-model-registry.js';
import { assertNoUnknownKeys, isRecord } from '../../shared/utils/types.js';

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
  'salienceDecayIntervalMs',
  'backgroundMaintenanceIntervalMs',
  'maintenanceIntervalMs',
  'capabilityTier',
];

export {
  normalizeCanonicalModelRegistry,
  toPromotedToolList,
};

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

/**
 * Parse an untrusted whole-file settings.json payload before it crosses into
 * the typed config-store API. Runtime settings normalization validates the
 * known values; this exact-key check prevents normalization's object spreads
 * from carrying unowned keys into the canonical owner file.
 */
export function parseRuntimeSettingsOwnerPayload(value: unknown): EditableSettings {
  if (!isRecord(value)) {
    throw new Error('settings.json payload must be an object');
  }
  assertNoUnknownKeys(
    value,
    RUNTIME_SETTINGS_KEYS,
    'settings.json payload',
  );
  const settings: EditableSettings = {};
  Object.assign(settings, value);
  return normalizeEditableSettings(settings);
}
