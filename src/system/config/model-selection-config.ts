import {
  CANONICAL_MODEL_PURPOSES,
  type CanonicalModelPurpose,
  type ModelPurposeSelection,
} from '../../shared/contracts/runtime.js';
import { isRecord } from '../../shared/utils/types.js';
import { MODEL_SLOT_KEY_PATTERN } from '../settings/contracts.js';
import type { SubstrateConfig } from './runtime-config-contracts.js';

/**
 * Per-companion model selection (bead 23pp).
 *
 * `modelPurposeSelection` is a runtime settings key (settings.json, overridable
 * per companion via settings.overlay.json) mapping a canonical model purpose to
 * the models.json registry entry id (catalog slot key) that companion should
 * lead the lane with. The registry/catalog and every provider credential stay
 * gateway-global; ONLY the selection is companion-scoped character config.
 *
 * Fail-closed contract:
 * - structure is validated here (unknown purpose keys / malformed slot keys
 *   reject the settings write or startup);
 * - slot keys are validated against the loaded models.json registry after
 *   models hydration ({@link assertModelPurposeSelectionResolvable}) and again
 *   at the gateway when the selection crosses the agent→gateway boundary
 *   (UnknownModelSelectionSlotError in model-hint-routing.ts);
 * - an absent selection is byte-identical to today's registry-primary routing.
 */

const CANONICAL_MODEL_PURPOSE_SET = new Set<string>(CANONICAL_MODEL_PURPOSES);

/**
 * Normalize a `modelPurposeSelection` settings value. Returns undefined for
 * null/undefined (clearing the setting); throws an actionable error for any
 * structural problem. Slot-key EXISTENCE is intentionally not checked here —
 * the settings normalizer has no view of models.json; existence is enforced by
 * {@link assertModelPurposeSelectionResolvable} and at the gateway boundary.
 */
export function normalizeModelPurposeSelectionSetting(
  value: unknown,
  fieldName = 'modelPurposeSelection',
): ModelPurposeSelection | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new Error(
      `${fieldName} must be an object mapping model purposes `
      + `(${CANONICAL_MODEL_PURPOSES.join(', ')}) to models.json slot keys`,
    );
  }
  const normalized: ModelPurposeSelection = {};
  for (const [rawPurpose, rawSlotKey] of Object.entries(value)) {
    const purpose = rawPurpose.trim();
    if (!CANONICAL_MODEL_PURPOSE_SET.has(purpose)) {
      throw new Error(
        `${fieldName} contains unknown model purpose "${rawPurpose}". `
        + `Valid purposes: ${CANONICAL_MODEL_PURPOSES.join(', ')}`,
      );
    }
    if (rawSlotKey === undefined || rawSlotKey === null) continue;
    if (typeof rawSlotKey !== 'string' || rawSlotKey.trim().length === 0) {
      throw new Error(
        `${fieldName}.${purpose} must be a non-empty models.json slot key string`,
      );
    }
    const slotKey = rawSlotKey.trim();
    if (!MODEL_SLOT_KEY_PATTERN.test(slotKey)) {
      throw new Error(
        `${fieldName}.${purpose} slot key "${slotKey}" contains characters outside [A-Za-z0-9._-]`,
      );
    }
    normalized[purpose as CanonicalModelPurpose] = slotKey;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/** Enabled models.json registry entry ids, the valid selection targets. */
export function listEnabledModelRegistrySlotKeys(
  config: Pick<SubstrateConfig, 'modelRegistry'>,
): string[] {
  return (config.modelRegistry?.models ?? [])
    .filter((entry) => entry.enabled !== false)
    .map((entry) => entry.id);
}

/**
 * Fail-closed startup validation: every configured selection slot key must be
 * an enabled models.json registry entry. Called after models hydration in both
 * canonical startup and the operator/json-backed hydration path, so a stale or
 * mistyped per-companion selection stops the process with an actionable
 * message instead of silently routing to another model.
 */
export function assertModelPurposeSelectionResolvable(
  config: Pick<SubstrateConfig, 'modelPurposeSelection' | 'modelRegistry'>,
): void {
  const selection = config.modelPurposeSelection;
  if (!selection) return;
  const validSlotKeys = listEnabledModelRegistrySlotKeys(config);
  const validSlotKeySet = new Set(validSlotKeys);
  for (const [purpose, slotKey] of Object.entries(selection)) {
    if (!validSlotKeySet.has(slotKey)) {
      throw new Error(
        `modelPurposeSelection.${purpose} references slot "${slotKey}", which is not an enabled `
        + `models.json registry entry. Valid slot keys: `
        + `${validSlotKeys.length > 0 ? validSlotKeys.join(', ') : '(none — models.json registry is empty)'}. `
        + 'Fix settings.json or the companion settings.overlay.json, or add the model to models.json.',
      );
    }
  }
}
