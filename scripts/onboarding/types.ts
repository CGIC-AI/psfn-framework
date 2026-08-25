// ── Onboarding flow types (psfn-framework-wckv.1.1 / wckv.1.2 / wckv.1.3) ──
// Shared shapes for the `npm run onboard` interactive flow. The interactive I/O
// is expressed entirely through the {@link Prompter} seam so the pure planning
// and generation code can be driven non-interactively from tests.

import type { CharacterCardV2 } from '../../src/core/identity/types.js';
import type { CompanionSource } from './companion-import.js';

/** Install target the operator picks first. */
export type InstallMode = 'compose' | 'kubernetes' | 'local';

/**
 * A single question/answer surface. The readline-backed implementation lives in
 * `prompter.ts`; tests supply a scripted stub. `secret` must never echo the
 * typed value or return it through any logging path.
 */
export interface Prompter {
  info(message: string): void;
  choice(question: string, options: readonly PrompterChoiceOption[]): Promise<string>;
  text(question: string, options?: { default?: string; allowEmpty?: boolean }): Promise<string>;
  secret(question: string): Promise<string>;
  confirm(question: string, options?: { default?: boolean }): Promise<boolean>;
  /** Release the input source when the flow ends (interactive impls hold stdin open). */
  dispose?(): void;
}

export interface PrompterChoiceOption {
  value: string;
  label: string;
  hint?: string;
}

/** Fully-resolved provider choice ready to become providers.json + a secret. */
export interface ProviderSelection {
  /** Canonical provider registry id (key-safe, lowercased). */
  id: string;
  /** Canonical provider type from the runtime contract. */
  type: string;
  label: string;
  apiBaseUrl: string;
  /** Required for the openrouter type; omitted otherwise. */
  modelsApiUrl?: string;
  /** Uppercase env var NAME that holds the key (never the key value). */
  apiKeyEnvName: string;
  /** The secret VALUE, held only in memory until the .env commit. Never logged. */
  apiKeyValue: string;
}

/** Model slugs the operator confirmed for the three generated runtime roles. */
export interface ModelSelection {
  primaryModelSlug: string;
  extractionModelSlug: string;
  visionModelSlug: string;
}

/** Optional voice selection. When disabled the runtime keeps stt/tts off. */
export interface VoiceSelection {
  enabled: boolean;
  sttProvider?: string;
  ttsProvider?: string;
  /** Secret env entries for the chosen voice providers (name -> value). */
  secrets: Array<{ envName: string; value: string }>;
}

/** The two-root persistence target for the chosen mode. */
export interface PersistenceRootPlan {
  systemDataDir: string;
  companionDataDir: string;
  /** True when systemDataDir === companionDataDir (legacy shared layout). */
  shared: boolean;
}

/** A complete, side-effect-free description of what commit() will write. */
export interface OnboardingPlan {
  mode: InstallMode;
  roots: PersistenceRootPlan;
  seedDir: string;
  provider: ProviderSelection;
  models: ModelSelection;
  voice: VoiceSelection;
  companionId: string;
  /** Non-secret and secret .env entries (name -> value). */
  envEntries: Array<{
    envName: string;
    value: string;
    comment?: string;
    /** Keep an existing value during reconfiguration (used for persistent-stack secrets). */
    preserveExisting?: boolean;
  }>;
  /** When true, existing owner files may be overwritten (operator confirmed). */
  updateExisting: boolean;
  /**
   * The companion definition to write alongside the owner files (wckv.1.3).
   * Optional so unit tests that only exercise owner-file generation may omit it;
   * the interactive flow always resolves one (imported or fresh-start).
   */
  companionSource?: CompanionSource;
  card?: CharacterCardV2;
}
