export const DEFAULT_COMPANION_NAME = 'Companion';
export const DEFAULT_COMPANION_ID = 'companion';
export const DEFAULT_COMPANION_CARD_FILE_NAME = 'companion.json';
export const LEGACY_CHARACTER_CARD_FILE_NAME = 'character.json';
export const DEFAULT_COMPANION_SKILLS_DIRECTORY = 'companion/skills';
export const DEFAULT_ADMIN_CHAT_MODEL_ID = 'companion-admin-chat';

export const LEGACY_COMPANION_NAME = 'PSFN';
export const LEGACY_COMPANION_ID = 'psfn';
export const LEGACY_COMPANION_SKILLS_DIRECTORY = 'psfn/skills';

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
