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
let sessionProbeScope: string | null = null;
let authenticated = $derived(!!token || serverSessionAuthenticated);

function clearSessionProbe(abort: boolean): void {
  if (abort) sessionProbeController?.abort();
  sessionProbeController = null;
  sessionProbePromise = null;
  sessionProbeScope = null;
}

onCompanionScopeChange((_previousCompanionId, nextCompanionId) => {
  const nextScope = nextCompanionId ?? 'single-companion';
  if (sessionProbeScope !== nextScope) {
    clearSessionProbe(true);
  }
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
  sessionProbeScope = companionScope;
  try {
    const res = await fetch(scopeGardenDataPath('/api/admin/dashboard'), {
      headers: { Accept: 'application/json' },
      credentials: 'include',
      signal: controller.signal,
    });
    if (companionScope !== getCompanionCacheScope()) return false;
    if (res.ok) {
      serverSessionAuthenticated = true;
      authResolved = true;
    } else if (res.status === 401 || res.status === 403) {
      serverSessionAuthenticated = false;
      authResolved = true;
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AbortError')) {
      console.warn(
        'Garden admin session probe failed; authentication remains unresolved.',
        error,
      );
    }
  } finally {
    if (sessionProbeController === controller) {
      clearSessionProbe(false);
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
  clearSessionProbe(true);
  clearLegacyPersistentAdminToken();
  clearLegacyScriptReadableAdminTokenCookie();
}
