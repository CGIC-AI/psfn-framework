import {
  clearLegacyPersistentAdminToken,
  clearLegacyScriptReadableAdminTokenCookie,
} from './auth-storage';
import {
  currentCompanionGardenScope,
  getCompanionCacheScope,
  onCompanionScopeChange,
  scopeGardenDataPath,
} from '$lib/fleet/companion-scope';
import { isAbortError, throwIfAborted } from '$lib/api/abort';
import { ApiError } from '$lib/api/errors';

clearLegacyPersistentAdminToken();

let token = $state<string>('');
let serverSessionAuthenticated = $state(false);
let authResolved = $state(typeof window === 'undefined');
let sessionProbePromise: Promise<boolean> | null = null;
let sessionProbeController: AbortController | null = null;
let sessionProbeScope: string | null = null;
let sessionRefreshRunning = false;
let sessionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let sessionRefreshPromise: Promise<void> | null = null;
let sessionRefreshController: AbortController | null = null;
let sessionRefreshGeneration = 0;
let sessionRefreshDueAtMs: number | null = null;
let sessionIdleExpiresAtMs: number | null = null;
let sessionAbsoluteExpiresAtMs: number | null = null;
let authenticated = $derived(!!token || serverSessionAuthenticated);

function isFleetSessionPath(): boolean {
  if (typeof window === 'undefined') return false;
  return currentCompanionGardenScope(window.location.pathname) !== null;
}

function clearSessionRefreshTimer(): void {
  if (sessionRefreshTimer === null) return;
  clearTimeout(sessionRefreshTimer);
  sessionRefreshTimer = null;
}

function clearSessionRefreshSchedule(): void {
  clearSessionRefreshTimer();
  sessionRefreshDueAtMs = null;
  sessionIdleExpiresAtMs = null;
  sessionAbsoluteExpiresAtMs = null;
}

function cancelSessionRefreshRequest(): void {
  sessionRefreshGeneration += 1;
  sessionRefreshController?.abort();
  sessionRefreshController = null;
  sessionRefreshPromise = null;
}

function sessionRefreshDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden;
}

function sessionRefreshExpired(now: number): boolean {
  return (sessionIdleExpiresAtMs !== null && now >= sessionIdleExpiresAtMs)
    || (sessionAbsoluteExpiresAtMs !== null && now >= sessionAbsoluteExpiresAtMs);
}

function scheduleSessionRefreshTimer(): void {
  clearSessionRefreshTimer();
  if (!sessionRefreshRunning
    || !serverSessionAuthenticated
    || token.length > 0
    || !isFleetSessionPath()
    || sessionRefreshDocumentHidden()
    || sessionRefreshDueAtMs === null) {
    return;
  }
  const now = Date.now();
  if (sessionRefreshExpired(now)) {
    serverSessionAuthenticated = false;
    authResolved = true;
    clearSessionRefreshSchedule();
    return;
  }
  const delayMs = Math.max(0, sessionRefreshDueAtMs - now);
  sessionRefreshTimer = setTimeout(() => {
    sessionRefreshTimer = null;
    void requestServerSessionRefresh();
  }, delayMs);
}

async function runServerSessionRefresh(
  generation: number,
  controller: AbortController,
): Promise<void> {
  try {
    const { readFleetSessionState, refreshFleetSession } = await import('$lib/api/fleet-session');
    let refreshed: Awaited<ReturnType<typeof refreshFleetSession>>;
    try {
      refreshed = await refreshFleetSession(controller.signal);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      const state = await readFleetSessionState(controller.signal);
      if (state === 'signed_out') throw error;
      refreshed = await refreshFleetSession(controller.signal);
    }
    if (generation !== sessionRefreshGeneration
      || !sessionRefreshRunning
      || !serverSessionAuthenticated
      || token.length > 0) return;
    const now = Date.now();
    sessionIdleExpiresAtMs = refreshed.idleExpiresAtMs;
    sessionAbsoluteExpiresAtMs = refreshed.absoluteExpiresAtMs;
    if (now >= refreshed.absoluteExpiresAtMs || now >= refreshed.idleExpiresAtMs) {
      serverSessionAuthenticated = false;
      authResolved = true;
      clearSessionRefreshSchedule();
      return;
    }
    sessionRefreshDueAtMs = now + Math.floor((refreshed.idleExpiresAtMs - now) / 2);
    scheduleSessionRefreshTimer();
  } catch (error) {
    if (generation !== sessionRefreshGeneration || !sessionRefreshRunning) return;
    if (error instanceof ApiError && error.status === 401) {
      serverSessionAuthenticated = false;
      authResolved = true;
      clearSessionRefreshSchedule();
      if (typeof window !== 'undefined') window.location.href = '/fleet/login';
      return;
    }
    console.warn('Garden fleet session refresh failed; retaining the current session.', error);
    const now = Date.now();
    if (sessionIdleExpiresAtMs !== null) {
      if (now >= sessionIdleExpiresAtMs) {
        serverSessionAuthenticated = false;
        authResolved = true;
        clearSessionRefreshSchedule();
        return;
      }
      sessionRefreshDueAtMs = now + Math.floor((sessionIdleExpiresAtMs - now) / 2);
    }
    scheduleSessionRefreshTimer();
  } finally {
    if (sessionRefreshController === controller) {
      sessionRefreshController = null;
      sessionRefreshPromise = null;
    }
  }
}

function requestServerSessionRefresh(): Promise<void> | null {
  if (!sessionRefreshRunning
    || !serverSessionAuthenticated
    || token.length > 0
    || !isFleetSessionPath()
    || sessionRefreshDocumentHidden()) {
    return sessionRefreshPromise;
  }
  if (sessionRefreshExpired(Date.now())) {
    serverSessionAuthenticated = false;
    authResolved = true;
    clearSessionRefreshSchedule();
    return null;
  }
  if (!sessionRefreshPromise) {
    const controller = new AbortController();
    sessionRefreshController = controller;
    sessionRefreshPromise = runServerSessionRefresh(sessionRefreshGeneration, controller);
  }
  return sessionRefreshPromise;
}

function handleSessionRefreshVisibilityChange(): void {
  if (!sessionRefreshRunning) return;
  if (sessionRefreshDocumentHidden()) {
    clearSessionRefreshTimer();
    return;
  }
  if (sessionRefreshDueAtMs === null || sessionRefreshDueAtMs <= Date.now()) {
    void requestServerSessionRefresh();
    return;
  }
  scheduleSessionRefreshTimer();
}

export function startServerSessionRefresh(): void {
  if (sessionRefreshRunning || typeof document === 'undefined') return;
  sessionRefreshRunning = true;
  document.addEventListener('visibilitychange', handleSessionRefreshVisibilityChange);
  void requestServerSessionRefresh();
}

export function stopServerSessionRefresh(): void {
  if (!sessionRefreshRunning) return;
  sessionRefreshRunning = false;
  document.removeEventListener('visibilitychange', handleSessionRefreshVisibilityChange);
  cancelSessionRefreshRequest();
  clearSessionRefreshSchedule();
}

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
  cancelSessionRefreshRequest();
  clearSessionRefreshSchedule();
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
    const { withFleetSessionTransitionLock } = await import('$lib/api/fleet-session');
    const res = await withFleetSessionTransitionLock(async transitionSignal => (
      fetch(scopeGardenDataPath('/api/admin/dashboard'), {
        headers: { Accept: 'application/json' },
        credentials: 'include',
        signal: transitionSignal,
      })
    ), controller.signal);
    throwIfAborted(controller.signal);
    if (companionScope !== getCompanionCacheScope()) return false;
    if (res.ok) {
      serverSessionAuthenticated = true;
      authResolved = true;
      void requestServerSessionRefresh();
    } else if (res.status === 401 || res.status === 403) {
      serverSessionAuthenticated = false;
      authResolved = true;
    }
  } catch (error) {
    if (!isAbortError(error, controller.signal)) {
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
  cancelSessionRefreshRequest();
  clearSessionRefreshSchedule();
  clearLegacyPersistentAdminToken();
}

export function clearToken() {
  token = '';
  serverSessionAuthenticated = false;
  authResolved = true;
  stopServerSessionRefresh();
  clearSessionProbe(true);
  clearLegacyPersistentAdminToken();
  clearLegacyScriptReadableAdminTokenCookie();
}
