// ── Auth store — token persistence + validation ──

const STORAGE_KEY = 'psfn_token';

let token = $state<string | null>(null);
let initialized = $state(false);

export function initAuth(): void {
  if (initialized) return;
  token = localStorage.getItem(STORAGE_KEY);
  initialized = true;
}

export function getToken(): string | null {
  return token;
}

export function isAuthenticated(): boolean {
  return token !== null && token.length > 0;
}

export function setToken(newToken: string): void {
  token = newToken;
  localStorage.setItem(STORAGE_KEY, newToken);
  // Also set cookie for WebSocket auth
  document.cookie = `psfn_token=${encodeURIComponent(newToken)}; path=/; SameSite=Strict`;
}

export function clearToken(): void {
  token = null;
  localStorage.removeItem(STORAGE_KEY);
  document.cookie = 'psfn_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
}

export async function validateToken(t: string): Promise<boolean> {
  try {
    const res = await fetch('/api/admin/dashboard', {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${t}`,
      },
    });
    return res.ok;
  } catch {
    return false;
  }
}
