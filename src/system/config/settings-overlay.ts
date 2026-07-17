import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecord } from '../../shared/utils/types.js';
import {
  normalizeEditableSettings,
  type EditableSettings,
  type RuntimeSettingKey,
} from '../settings.js';

/**
 * Per-companion settings overlay (bead dnll.1).
 *
 * The single-release fleet topology roots every owner file — settings.json
 * included — at the shared `systemDataDir`, so every semantically per-companion
 * setting is cluster-global by accident (one clock, one voice target, one
 * emo_sim session for all companions). This module gives each companion an
 * OPTIONAL `settings.overlay.json` inside its own `companionDataDir`, deep-merged
 * over the global settings.json for an EXPLICIT whitelist of keys only.
 *
 * Contract:
 * - Absent overlay ⇒ byte-identical behavior to today (returns the base
 *   settings object untouched).
 * - Present overlay ⇒ every top-level key must be on the whitelist. A
 *   non-whitelisted key fails startup closed; it is never silently merged.
 * - Whitelisted keys are deep-merged over the base runtime settings and the
 *   merged result is re-validated through the existing settings normalizer.
 *
 * This is the general mechanism the dnll siblings build on; it deliberately does
 * NOT relocate whole owner files (capability-tier.json / scheduler.json are
 * dnll.2 / dnll.3) and does NOT own workspace isolation (c337).
 */

export const COMPANION_SETTINGS_OVERLAY_FILE_NAME = 'settings.overlay.json';

/**
 * The only settings.json keys a per-companion overlay may set. Sourced from the
 * shared-seams audit (§11 of working_docs/fleet-analysis-findings-20260714.md):
 * activeTimezone (seam 3), voice* (seam 6), observerEvalSidecar (seam 1),
 * emotionScoping (seam 9), plus uiThemeId and discordTrigger* per the bead.
 *
 * Every entry is a runtime-owned key (see RUNTIME_SETTINGS_KEYS); no model,
 * scheduler, or capability-tier key is overlay-eligible. Keep this the single
 * source of truth — the settings contract derives its per-key scope from it.
 */
export const COMPANION_SETTINGS_OVERLAY_WHITELIST = [
  'activeTimezone',
  'observerEvalSidecar',
  'emotionScoping',
  'uiThemeId',
  // voice* — target guild/user/channel, cue text, and TTS/STT identity
  'voiceEnabled',
  'ttsProvider',
  'voiceId',
  'voiceTargetGuildId',
  'voiceTargetUserId',
  'voiceReadyCueText',
  'echoTtsUrl',
  'echoTtsVoice',
  'echoTtsPreset',
  'sttProvider',
  'deepgramModel',
  'deepgramSttEndpoint',
  'deepgramListenEndpoint',
  'elevenLabsModelId',
  'elevenLabsEndpointBase',
  // discordTrigger*
  'discordTriggerWords',
  'discordTriggerReactions',
  'discordTriggerListenWindowMs',
] as const satisfies readonly RuntimeSettingKey[];

export type CompanionSettingsOverlayKey = typeof COMPANION_SETTINGS_OVERLAY_WHITELIST[number];

export const COMPANION_SETTINGS_OVERLAY_KEY_SET: ReadonlySet<string> = new Set(
  COMPANION_SETTINGS_OVERLAY_WHITELIST,
);

/** Fail-closed check used by the settings contract to tag per-key scope. */
export function isCompanionSettingsOverlayKey(key: string): key is CompanionSettingsOverlayKey {
  return COMPANION_SETTINGS_OVERLAY_KEY_SET.has(key);
}

function isEnoent(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}

/**
 * Deep-merge two plain records. Nested plain objects merge recursively; arrays
 * and scalars from the overlay replace the base wholesale (a per-companion list
 * override is a replacement, not an append). Overlay values are structurally
 * cloned so the merged result never aliases the parsed overlay.
 */
function deepMergeRecords(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, overlayValue] of Object.entries(overlay)) {
    const baseValue = merged[key];
    if (isRecord(baseValue) && isRecord(overlayValue)) {
      merged[key] = deepMergeRecords(baseValue, overlayValue);
    } else {
      merged[key] = structuredClone(overlayValue);
    }
  }
  return merged;
}

/**
 * Load and validate a companion's `settings.overlay.json`.
 *
 * Returns `undefined` when the file is absent (the byte-identical path).
 * Throws fail-closed when the file exists but is malformed JSON, is not a JSON
 * object, or contains any key outside {@link COMPANION_SETTINGS_OVERLAY_WHITELIST}.
 */
export function loadCompanionSettingsOverlay(
  companionDataDir: string,
): EditableSettings | undefined {
  const path = join(companionDataDir, COMPANION_SETTINGS_OVERLAY_FILE_NAME);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    if (isEnoent(error)) {
      return undefined;
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid companion settings overlay at ${path}. Repair it in place; `
      + `The runtime will not fall back to global settings for a malformed overlay. Cause: ${reason}`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(
      `Companion settings overlay at ${path} must be a JSON object of whitelisted settings keys.`,
    );
  }

  const offendingKeys = Object.keys(parsed).filter(
    (key) => !COMPANION_SETTINGS_OVERLAY_KEY_SET.has(key),
  );
  if (offendingKeys.length > 0) {
    throw new Error(
      `Companion settings overlay at ${path} contains non-whitelisted keys: `
      + `${offendingKeys.join(', ')}. Per-companion overlays may only set `
      + `${COMPANION_SETTINGS_OVERLAY_WHITELIST.join(', ')}.`,
    );
  }

  return parsed as EditableSettings;
}

/**
 * Deep-merge a validated overlay over the base runtime settings and re-validate
 * the result through the existing normalizer. The overlay is assumed to already
 * be whitelist-validated by {@link loadCompanionSettingsOverlay}.
 */
export function mergeCompanionSettingsOverlay(
  baseRuntimeSettings: EditableSettings,
  overlay: EditableSettings,
): EditableSettings {
  const merged = deepMergeRecords(
    baseRuntimeSettings as Record<string, unknown>,
    overlay as Record<string, unknown>,
  ) as EditableSettings;
  return normalizeEditableSettings(merged);
}

/**
 * Resolve the effective runtime settings for a companion: the global runtime
 * settings with any per-companion overlay deep-merged on top. When no overlay
 * file is present the base object is returned unchanged (byte-identical path).
 *
 * This is the single entry point the startup config-hydration paths call before
 * `applySettings`.
 */
export function resolveEffectiveRuntimeSettings(
  baseRuntimeSettings: EditableSettings,
  companionDataDir: string,
): EditableSettings {
  const overlay = loadCompanionSettingsOverlay(companionDataDir);
  if (!overlay) {
    return baseRuntimeSettings;
  }
  return mergeCompanionSettingsOverlay(baseRuntimeSettings, overlay);
}
