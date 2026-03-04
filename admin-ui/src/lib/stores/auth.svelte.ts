let token = $state<string>(
  typeof window !== 'undefined' ? (localStorage.getItem('psfn_token') ?? '') : ''
);
let serverSessionAuthenticated = $state(false);
let authResolved = $state(typeof window === 'undefined');
let sessionProbePromise: Promise<boolean> | null = null;
let authenticated = $derived(!!token || serverSessionAuthenticated);

export function getToken(): string {
  return token;
}

export function isAuthenticated(): boolean {
  return authenticated;
}

export function isAuthResolved(): boolean {
  return authResolved;
}

async function probeServerSession(): Promise<boolean> {
  try {
    const res = await fetch('/api/admin/dashboard', {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
    serverSessionAuthenticated = res.ok;
  } catch {
    serverSessionAuthenticated = false;
  } finally {
    authResolved = true;
    sessionProbePromise = null;
  }
  return authenticated;
}

export async function ensureAuthResolved(): Promise<boolean> {
  if (authResolved) return authenticated;
  if (token) {
    serverSessionAuthenticated = true;
    authResolved = true;
    return true;
  }
  if (!sessionProbePromise) {
    sessionProbePromise = probeServerSession();
  }
  return sessionProbePromise;
}

export function setToken(t: string) {
  token = t;
  serverSessionAuthenticated = token.length > 0;
  authResolved = true;
  if (typeof window !== 'undefined') {
    localStorage.setItem('psfn_token', t);
    document.cookie = `psfn_token=${encodeURIComponent(t)}; path=/; SameSite=Strict`;
  }
}

export function clearToken() {
  token = '';
  serverSessionAuthenticated = false;
  authResolved = true;
  sessionProbePromise = null;
  if (typeof window !== 'undefined') {
    localStorage.removeItem('psfn_token');
    document.cookie = 'psfn_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  }
}
