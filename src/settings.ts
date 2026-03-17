// ── Persistent Editable Settings ──
// Subset of SubstrateConfig that can be changed at runtime via admin GUI.
// Persisted to data/settings.json (runtime-owned domain fields only).
// Loaded at startup from canonical system-data JSON owners.

export { createDefaultCompositionalPolicyConfig } from './compositional/policy.js';

export {
  SETTINGS_FILE_NAME,
  MOOD_CONGRUENCE_WEIGHT_RANGE,
  REMOVED_RUNTIME_SETTINGS_KEYS,
  MODEL_SLOT_KEY_PATTERN,
  DEFAULT_MODEL_ROLE_ASSIGNMENTS,
  RUNTIME_SETTINGS_KEYS,
  type EditableSettings,
  type RuntimeSettingKey,
  type RuntimeSettingValue,
  type RuntimeSettingsSnapshot,
  type SettingsDomainSplit,
} from './settings/contracts.js';

export {
  normalizeCanonicalModelRegistry,
  hasModelSettings,
  extractModelSettings,
  splitSettingsByDomain,
  toRuntimeOwnedSettings,
  normalizeEditableSettings,
} from './settings/schema.js';

export {
  loadSettings,
  saveSettings,
} from './settings/io.js';

export {
  isRuntimeSettingKey,
  getRuntimeSettingsSnapshot,
  applySettings,
} from './settings/runtime.js';

export {
  SETTINGS_VALIDATION,
  parseSettingsForm,
} from './settings/form.js';
