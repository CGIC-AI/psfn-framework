import { getChatBootstrap } from '$lib/api/endpoints/chat';
import {
  companionNameFromChatBootstrap,
  normalizeCompanionName,
  DEFAULT_COMPANION_NAME,
} from '$lib/companion-name';
import type { AdminChatBootstrapResponse } from '$lib/types';

let companionName = $state(DEFAULT_COMPANION_NAME);
let resolvedFromCharacterCard = $state(false);
let loadPromise: Promise<string> | null = null;

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
    loadPromise = (async () => {
      try {
        const bootstrap = await getChatBootstrap();
        setCompanionNameFromChatBootstrap(bootstrap);
      } catch {
        // Keep current fallback; allow retries on a future call.
      } finally {
        loadPromise = null;
      }
      return companionName;
    })();
  }

  return loadPromise ?? Promise.resolve(companionName);
}
