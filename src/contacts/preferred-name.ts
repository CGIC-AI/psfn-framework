import type { Contact } from './types.js';

type ContactNameSource = Pick<Contact, 'displayName' | 'nickname'> | null | undefined;

function normalizeTrimmed(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolvePreferredContactName(
  contact: ContactNameSource,
  fallback?: string,
): string | undefined {
  const nickname = normalizeTrimmed(contact?.nickname);
  if (nickname) return nickname;

  const displayName = normalizeTrimmed(contact?.displayName);
  if (displayName) return displayName;

  return normalizeTrimmed(fallback);
}
