import type { ImageModelRegistryEntry } from '../../shared/contracts/runtime-base.js';
import { isRecord } from '../../shared/utils/types.js';

const IMAGE_MODEL_ENTRY_KEYS = ['id', 'provider', 'model', 'modes', 'primary'] as const;
const IMAGE_MODEL_MODES = ['create', 'edit'] as const;
const IMAGE_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;
// Provider model slugs such as `vendor/model-name` or `vendor/model:variant`.
const IMAGE_MODEL_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/iu;

/**
 * Validate the optional models.json `imageModels` section (s5b89). Unknown
 * keys, duplicate ids, unknown modes, or two primaries for one mode reject the
 * whole registry; there is no implicit image model.
 */
export function normalizeImageModelRegistry(
  value: unknown,
  fieldPath: string,
): ImageModelRegistryEntry[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid model registry at ${fieldPath}: expected array`);
  }
  const seenIds = new Set<string>();
  const primaryModes = new Set<string>();
  return value.map((raw, index) => {
    const path = `${fieldPath}[${index}]`;
    if (!isRecord(raw)) throw new Error(`Invalid model registry at ${path}: expected object`);
    const unknown = Object.keys(raw).filter(key => !(IMAGE_MODEL_ENTRY_KEYS as readonly string[]).includes(key));
    if (unknown.length > 0) {
      throw new Error(`Invalid model registry at ${path}: unknown key(s) ${unknown.join(', ')}`);
    }
    if (typeof raw.id !== 'string' || !IMAGE_MODEL_ID_PATTERN.test(raw.id) || seenIds.has(raw.id)) {
      throw new Error(`Invalid model registry at ${path}.id: expected a unique lowercase id`);
    }
    seenIds.add(raw.id);
    if (typeof raw.provider !== 'string' || raw.provider.trim().length === 0) {
      throw new Error(`Invalid model registry at ${path}.provider: expected a providers.json id`);
    }
    if (typeof raw.model !== 'string' || !IMAGE_MODEL_SLUG_PATTERN.test(raw.model)) {
      throw new Error(`Invalid model registry at ${path}.model: expected a provider model slug`);
    }
    if (!Array.isArray(raw.modes) || raw.modes.length === 0
      || raw.modes.some(mode => !(IMAGE_MODEL_MODES as readonly unknown[]).includes(mode))
      || new Set(raw.modes).size !== raw.modes.length) {
      throw new Error(`Invalid model registry at ${path}.modes: expected create and/or edit`);
    }
    if (typeof raw.primary !== 'boolean') {
      throw new Error(`Invalid model registry at ${path}.primary: expected boolean`);
    }
    const modes = raw.modes as ImageModelRegistryEntry['modes'];
    if (raw.primary) {
      for (const mode of modes) {
        if (primaryModes.has(mode)) {
          throw new Error(`Invalid model registry at ${path}.primary: mode "${mode}" already has a primary image model`);
        }
        primaryModes.add(mode);
      }
    }
    return {
      id: raw.id,
      provider: raw.provider.trim(),
      model: raw.model,
      modes: [...modes],
      primary: raw.primary,
    };
  });
}
