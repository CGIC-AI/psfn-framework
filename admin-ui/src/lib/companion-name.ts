import type {
  AdminChatBootstrapResponse,
  AdminModelRoomBootstrapResponse,
} from '$lib/types';

export const DEFAULT_COMPANION_NAME = 'Companion';
export const GENERIC_COMPANION_NAME = 'companion';

export interface AdminModelRoomBootstrapWireResponse extends Omit<AdminModelRoomBootstrapResponse, 'companion'> {
  companion?: AdminModelRoomBootstrapResponse['companion'];
  psfn?: AdminModelRoomBootstrapResponse['companion'];
}

function normalizedNonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeCompanionName(
  value: unknown,
  fallback = DEFAULT_COMPANION_NAME,
): string {
  return normalizedNonEmpty(value) ?? fallback;
}

export function companionNameFromChatBootstrap(
  bootstrap: Pick<AdminChatBootstrapResponse, 'assistantName'> | null | undefined,
): string {
  return normalizeCompanionName(bootstrap?.assistantName);
}

export function normalizeModelRoomBootstrap(
  payload: AdminModelRoomBootstrapWireResponse,
  fallbackCompanionName = DEFAULT_COMPANION_NAME,
): AdminModelRoomBootstrapResponse {
  const resolvedCompanion = payload.companion ?? payload.psfn;
  const companion = resolvedCompanion
    ? {
        ...resolvedCompanion,
        displayName: normalizeCompanionName(
          resolvedCompanion.displayName,
          fallbackCompanionName,
        ),
      }
    : {
        id: 'companion',
        displayName: fallbackCompanionName,
        defaultSystemPromptMode: 'default' as const,
      };

  return {
    api: payload.api,
    defaultRoomId: payload.defaultRoomId,
    companion,
    participants: payload.participants,
    constraints: payload.constraints,
  };
}
