import { composeSystemPromptTemplate } from './loader.js';
import { buildCharacterMacroMap } from './character-macro-map.js';
import type { PromptLayerStatePort } from './prompt-state-port.js';
import type { CharacterCardV2 } from './types.js';
import { renderPromptRuntimeTokens } from './prompt-runtime.js';

export interface PromptSyncResult {
  ok: boolean;
  updated: boolean;
  error?: string;
  errorCode?: 'missing_required_fields' | 'unsupported_unresolved_macros' | 'prompt_store_update_failed';
}

// Canonical macro names only (E2.5): removed alias spellings are rejected by
// the prompt-store safety valve before this validation ever sees them.
const ALLOWED_RUNTIME_UNRESOLVED_TOKENS = new Set([
  'user',
  'user_name',
  'user_id',
  'channel_id',
  'channel_type',
  'channel_visibility',
  'trust_level',
  'canonical_contact_id',
  'model',
  'current_datetime',
  'current_date',
  'current_time',
  'unix_timestamp',
]);
const REQUIRED_CHARACTER_MACRO_FIELDS = ['name', 'personality'] as const;

export function syncCharacterFoundationPromptFromCard(
  promptStore: PromptLayerStatePort,
  card: CharacterCardV2,
  _updatedBy: string,
  _reason = 'Sync Character Foundation prompt from imported character card',
): PromptSyncResult {
  const nextPrompt = composeSystemPromptTemplate();
  const macroVariables = buildCharacterMacroMap(card);
  const missingRequiredFields = REQUIRED_CHARACTER_MACRO_FIELDS.filter((field) => {
    const value = macroVariables[field];
    return typeof value !== 'string' || value.trim().length === 0;
  });
  if (missingRequiredFields.length > 0) {
    return {
      ok: false,
      updated: false,
      error: `Missing required identity fields for prompt sync: ${missingRequiredFields.join(', ')}`,
      errorCode: 'missing_required_fields',
    };
  }
  const macroValidation = renderPromptRuntimeTokens(nextPrompt, { variables: macroVariables });
  const unsupportedUnresolved = macroValidation.unresolvedTokens.filter(
    token => !ALLOWED_RUNTIME_UNRESOLVED_TOKENS.has(token),
  );
  if (unsupportedUnresolved.length > 0) {
    return {
      ok: false,
      updated: false,
      error: `Unsupported unresolved prompt macros: ${unsupportedUnresolved.join(', ')}`,
      errorCode: 'unsupported_unresolved_macros',
    };
  }
  try {
    const updated = promptStore.seedFromCharacterCard(nextPrompt);
    if (!updated) {
      return { ok: true, updated: false };
    }
    return { ok: true, updated: true };
  } catch (error) {
    return {
      ok: false,
      updated: false,
      error: error instanceof Error ? error.message : String(error),
      errorCode: 'prompt_store_update_failed',
    };
  }
}
