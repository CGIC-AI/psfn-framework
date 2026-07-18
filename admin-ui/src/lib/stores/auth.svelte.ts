import {
  clearLegacyPersistentAdminToken,
  clearLegacyScriptReadableAdminTokenCookie,
} from './auth-storage';
import {
  getCompanionCacheScope,
  onCompanionScopeChange,
  scopeGardenDataPath,
} from '$lib/fleet/companion-scope';

clearLegacyPersistentAdminToken();

let token = $state<string>('');
let serverSessionAuthenticated = $state(false);
let authResolved = $state(typeof window === 'undefined');
let sessionProbePromise: Promise<boolean> | null = null;
let sessionProbeController: AbortController | null = null;
let authenticated = $derived(!!token || serverSessionAuthenticated);

onCompanionScopeChange(() => {
  sessionProbeController?.abort();
  sessionProbeController = null;
  sessionProbePromise = null;
  authResolved = token.length > 0;
  serverSessionAuthenticated = token.length > 0;
});

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
  const companionScope = getCompanionCacheScope();
  const controller = new AbortController();
  sessionProbeController = controller;
  try {
    const res = await fetch(scopeGardenDataPath('/api/admin/dashboard'), {
      headers: { Accept: 'application/json' },
      credentials: 'include',
      signal: controller.signal,
    });
    if (companionScope !== getCompanionCacheScope()) return false;
    serverSessionAuthenticated = res.ok;
  } catch {
    if (companionScope === getCompanionCacheScope()) serverSessionAuthenticated = false;
  } finally {
    if (companionScope === getCompanionCacheScope()) authResolved = true;
    if (sessionProbeController === controller) {
      sessionProbeController = null;
      sessionProbePromise = null;
    }
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
  clearLegacyPersistentAdminToken();
}

export function clearToken() {
  token = '';
  serverSessionAuthenticated = false;
  authResolved = true;
  sessionProbePromise = null;
  sessionProbeController?.abort();
  sessionProbeController = null;
  clearLegacyPersistentAdminToken();
  clearLegacyScriptReadableAdminTokenCookie();
}
