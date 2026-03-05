import { composeSystemPromptTemplate } from './loader.js';
import { isCanonicalCharacterFoundationLayer } from './canonical-foundation.js';
import type { PromptLayerStore } from './prompt-store.js';
import type { CharacterCardV2 } from './types.js';
import { toErrorMessage } from '../utils/errors.js';

export interface PromptSyncResult {
  ok: boolean;
  updated: boolean;
  error?: string;
}

function resolveCharacterFoundationLayer(
  promptStore: PromptLayerStore,
): ReturnType<PromptLayerStore['getByType']>[number] | undefined {
  const baseLayers = promptStore.getByType('base');
  if (baseLayers.length === 0) return undefined;
  return baseLayers.find(layer => isCanonicalCharacterFoundationLayer(layer)) ?? baseLayers[0];
}

export function syncCharacterFoundationPromptFromCard(
  promptStore: PromptLayerStore | null | undefined,
  _card: CharacterCardV2,
  updatedBy: string,
  reason = 'Sync Character Foundation prompt from imported character card',
): PromptSyncResult {
  if (!promptStore) {
    return { ok: true, updated: false };
  }

  const foundation = resolveCharacterFoundationLayer(promptStore);
  if (!foundation) {
    return { ok: true, updated: false };
  }

  const nextPrompt = composeSystemPromptTemplate();
  if (foundation.content === nextPrompt) {
    return { ok: true, updated: false };
  }

  try {
    promptStore.update(foundation.id, nextPrompt, updatedBy, reason);
    return { ok: true, updated: true };
  } catch (error) {
    return {
      ok: false,
      updated: false,
      error: toErrorMessage(error),
    };
  }
}
