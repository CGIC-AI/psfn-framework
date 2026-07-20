/**
 * Free-time chooser configuration (bible §10.2, adjudication S12.8).
 *
 * The chooser is the companion-facing entrance experience for a free-time
 * block: ONE cheap, tool-less background-model call that presents a lightweight
 * menu (rest / private wander / resume a project / begin something new) with
 * SAFE project metadata only — never project bodies. Rest is a first-class
 * outcome that ends the block without a second model call, and a rest decision
 * persists silence for the quiet period so the companion is never re-prompted
 * into muting her own reminders (bible §6.7, §10.2).
 *
 * All numeric tunables live inside the defaults factory body — never as
 * module-level tuning constants — so the hardcoded-settings gate stays satisfied
 * and Garden/config can own overrides (matches the participation-appraiser
 * settings pattern).
 */
import { isRecord } from '../../shared/utils/types.js';
import { assertNoUnknownKeys, assertPositiveInteger } from './validators.js';

export interface FreeTimeChooserSettings {
  /** Master switch. When false the chooser fails closed to `rest`. */
  enabled: boolean;
  /**
   * Hard wall-clock ceiling for the single background chooser call. On expiry
   * the call is aborted and the chooser fails closed to `rest` — never a forced
   * workspace (bible §18 / fail-closed posture).
   */
  chooserDeadlineMs: number;
  /** Output-token ceiling for the choice contract; only a small object is needed. */
  chooserMaxOutputTokens: number;
  /**
   * Bounded count of resumable projects rendered into the datamarked menu so a
   * large project library cannot inflate the prompt.
   */
  projectListCap: number;
  /** Per-field character cap on project title / focus hint in the menu. */
  projectMetadataChars: number;
  /**
   * How long a rest / silence decision suppresses re-prompting for this quiet
   * period, in minutes. "Not again for this quiet period" — the goal is never to
   * annoy the companion into muting her own reminders again (adjudication
   * S12.8). Persisted behind `RestWindowPolicyPort`.
   */
  silencePersistenceMinutes: number;
}

export function createDefaultFreeTimeChooserSettings(): FreeTimeChooserSettings {
  return {
    enabled: true,
    chooserDeadlineMs: 8_000,
    chooserMaxOutputTokens: 200,
    projectListCap: 8,
    projectMetadataChars: 120,
    silencePersistenceMinutes: 180,
  };
}

// ── Owner-file parser (jp36.8.2) ─────────────────────────────────────────────
// Fail-closed parser homing the free-time chooser tunables (incl. the rest /
// silence-persistence window) in scheduler.json (Garden-editable via the raw
// owner-file editor). Defaults come from the factory above so a config that
// omits the block is byte-identical to the pre-owner-file behavior. Bounds live
// inside the function body to satisfy the hardcoded-settings gate.

const FREE_TIME_CHOOSER_ERROR_PREFIX = 'Invalid free-time chooser config';

function chooserBoolean(value: unknown, fieldPath: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${FREE_TIME_CHOOSER_ERROR_PREFIX}: ${fieldPath} must be a boolean`);
  }
  return value;
}

function chooserPositiveInteger(value: unknown, fieldPath: string): number {
  return assertPositiveInteger(value, fieldPath, {
    min: 1,
    message: ({ fieldLabel }) => `${FREE_TIME_CHOOSER_ERROR_PREFIX}: ${fieldLabel} must be a finite integer >= 1`,
  });
}

function chooserNonNegativeInteger(value: unknown, fieldPath: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${FREE_TIME_CHOOSER_ERROR_PREFIX}: ${fieldPath} must be a finite integer >= 0`);
  }
  return value;
}

export function parseFreeTimeChooserSettings(
  raw: unknown,
  fieldPath: string,
): FreeTimeChooserSettings {
  const defaults = createDefaultFreeTimeChooserSettings();
  if (raw === undefined) {
    return defaults;
  }
  if (!isRecord(raw)) {
    throw new Error(`${FREE_TIME_CHOOSER_ERROR_PREFIX}: ${fieldPath} must be an object`);
  }
  assertNoUnknownKeys(
    raw,
    [
      'enabled',
      'chooserDeadlineMs',
      'chooserMaxOutputTokens',
      'projectListCap',
      'projectMetadataChars',
      'silencePersistenceMinutes',
    ],
    fieldPath,
    { errorPrefix: FREE_TIME_CHOOSER_ERROR_PREFIX },
  );
  return {
    enabled: chooserBoolean(raw.enabled ?? defaults.enabled, `${fieldPath}.enabled`),
    chooserDeadlineMs: chooserPositiveInteger(
      raw.chooserDeadlineMs ?? defaults.chooserDeadlineMs,
      `${fieldPath}.chooserDeadlineMs`,
    ),
    chooserMaxOutputTokens: chooserPositiveInteger(
      raw.chooserMaxOutputTokens ?? defaults.chooserMaxOutputTokens,
      `${fieldPath}.chooserMaxOutputTokens`,
    ),
    // 0 is a valid "no resumable projects in the menu" state (the consumer
    // clamps with Math.max(0, ...)).
    projectListCap: chooserNonNegativeInteger(
      raw.projectListCap ?? defaults.projectListCap,
      `${fieldPath}.projectListCap`,
    ),
    projectMetadataChars: chooserPositiveInteger(
      raw.projectMetadataChars ?? defaults.projectMetadataChars,
      `${fieldPath}.projectMetadataChars`,
    ),
    // 0 disables silence persistence (the consumer clamps with Math.max(0, ...)).
    silencePersistenceMinutes: chooserNonNegativeInteger(
      raw.silencePersistenceMinutes ?? defaults.silencePersistenceMinutes,
      `${fieldPath}.silencePersistenceMinutes`,
    ),
  };
}
