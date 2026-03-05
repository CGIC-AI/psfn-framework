export const DEFAULT_COMPANION_NAME = 'Companion';
export const DEFAULT_COMPANION_ID = 'companion';
export const DEFAULT_COMPANION_SKILLS_DIRECTORY = 'companion/skills';
export const DEFAULT_ADMIN_CHAT_MODEL_ID = 'companion-admin-chat';

export const LEGACY_COMPANION_NAME = 'Purrsephone';
export const LEGACY_COMPANION_ID = 'purrsephone';
export const LEGACY_COMPANION_SKILLS_DIRECTORY = 'purrsephone/skills';

export function normalizeCompanionName(
  value: string | null | undefined,
  fallback = DEFAULT_COMPANION_NAME,
): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

export function formatPossessiveCompanionName(
  value: string | null | undefined,
  fallback = DEFAULT_COMPANION_NAME,
): string {
  const name = normalizeCompanionName(value, fallback);
  return name.endsWith('s') ? `${name}'` : `${name}'s`;
}
