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
