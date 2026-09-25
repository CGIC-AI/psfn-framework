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

/**
 * Non-secret marker the gateway sets beside the HttpOnly ADMIN_TOKEN cookie
 * on a fleet ADMIN_TOKEN sign-in (psfn-framework-jxthv). It carries no
 * authority: it only tells the Garden to send protected mutations through the
 * audited ADMIN_TOKEN door instead of minting an SSO escalation grant. A stale
 * marker fails closed at the gateway (401) exactly like a missing session.
 */
const GARDEN_OPERATOR_DOOR_COOKIE = 'garden_operator_door';

export function usesAdminTokenOperatorDoor(
  documentRef: LegacyAdminTokenDocument | undefined = globalThis.document,
): boolean {
  if (!documentRef || typeof documentRef.cookie !== 'string') return false;
  return documentRef.cookie
    .split(';')
    .some(entry => entry.trim() === `${GARDEN_OPERATOR_DOOR_COOKIE}=admin_token`);
}

export function clearAdminTokenOperatorDoor(
  documentRef: LegacyAdminTokenDocument | undefined = globalThis.document,
): void {
  if (!documentRef) return;
  documentRef.cookie = `${GARDEN_OPERATOR_DOOR_COOKIE}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}
