import { getChatBootstrap } from '$lib/api/endpoints/chat';
import {
  companionNameFromChatBootstrap,
  normalizeCompanionName,
  DEFAULT_COMPANION_NAME,
} from '$lib/companion-name';
import type { AdminChatBootstrapResponse } from '$lib/types';
import { onCompanionScopeChange } from '$lib/fleet/companion-scope';

let companionName = $state(DEFAULT_COMPANION_NAME);
let resolvedFromCharacterCard = $state(false);
let loadPromise: Promise<string> | null = null;
let scopeGeneration = 0;

onCompanionScopeChange(() => {
  scopeGeneration += 1;
  companionName = DEFAULT_COMPANION_NAME;
  resolvedFromCharacterCard = false;
  loadPromise = null;
});

export function getCompanionName(): string {
  return companionName;
}

export function setCompanionName(value: string | null | undefined): string {
  companionName = normalizeCompanionName(value);
  return companionName;
}

export function setCompanionNameFromChatBootstrap(
  bootstrap: Pick<AdminChatBootstrapResponse, 'assistantName'> | null | undefined,
): string {
  companionName = companionNameFromChatBootstrap(bootstrap);
  resolvedFromCharacterCard = true;
  return companionName;
}

export async function ensureCompanionNameLoaded(forceRefresh = false): Promise<string> {
  if (resolvedFromCharacterCard && !forceRefresh) return companionName;
  if (!loadPromise || forceRefresh) {
    const generation = scopeGeneration;
    const current = (async () => {
      try {
        const bootstrap = await getChatBootstrap();
        if (generation === scopeGeneration) setCompanionNameFromChatBootstrap(bootstrap);
      } catch {
        // Keep current fallback; allow retries on a future call.
      }
      return companionName;
    })();
    loadPromise = current;
    void current.finally(() => {
      if (loadPromise === current) loadPromise = null;
    });
  }

  return loadPromise ?? Promise.resolve(companionName);
}
