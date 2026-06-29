export const ADMIN_TOKEN_STORAGE_KEY = 'psfn_token';

export interface LegacyAdminTokenStorage {
  removeItem(key: string): void;
}

export interface LegacyAdminTokenDocument {
  cookie: string;
}

export function clearLegacyPersistentAdminToken(
  storage: LegacyAdminTokenStorage | undefined = globalThis.window?.localStorage,
): void {
  try {
    storage?.removeItem(ADMIN_TOKEN_STORAGE_KEY);
  } catch {
    // localStorage can be unavailable in hardened browser contexts.
  }
}

export function clearLegacyScriptReadableAdminTokenCookie(
  documentRef: LegacyAdminTokenDocument | undefined = globalThis.document,
): void {
  if (!documentRef) return;
  documentRef.cookie = `${ADMIN_TOKEN_STORAGE_KEY}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
