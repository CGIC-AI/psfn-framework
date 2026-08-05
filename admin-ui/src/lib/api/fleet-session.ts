import { throwIfAborted } from './abort';
import { ApiError } from './errors';

const FLEET_SESSION_AUTHORITY_PATH = '/v1/fleet/portal';
const FLEET_CSRF_PATH = '/v1/fleet-auth/session/csrf';
const FLEET_SESSION_REFRESH_PATH = '/v1/fleet-auth/session/refresh';
const FLEET_CSRF_HEADER = 'X-PSFN-CSRF';
const FLEET_CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const FLEET_SESSION_TRANSITION_LOCK_NAME = 'fleet-session-transition';
export const FLEET_SESSION_TRANSITION_TIMEOUT_MS = 10_000;
const fleetSessionTransitionSignals = new WeakSet<AbortSignal>();

export interface FleetSessionRefreshResult {
  principalStatus: 'pending' | 'active';
  idleExpiresAtMs: number;
  absoluteExpiresAtMs: number;
}

async function withFleetSessionLock<T>(
  mode: 'exclusive' | 'shared',
  operation: (transitionSignal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(FLEET_SESSION_TRANSITION_TIMEOUT_MS);
  const transitionSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  const run = async (): Promise<T> => {
    if (mode === 'exclusive') fleetSessionTransitionSignals.add(transitionSignal);
    try {
      return await operation(transitionSignal);
    } finally {
      if (mode === 'exclusive') fleetSessionTransitionSignals.delete(transitionSignal);
    }
  };
  if (typeof navigator === 'undefined') return await run();
  if (!navigator.locks) {
    throw new Error('Browser session coordination is unavailable');
  }
  return await navigator.locks.request(
    FLEET_SESSION_TRANSITION_LOCK_NAME,
    { mode, signal: transitionSignal },
    run,
  );
}

export function isFleetSessionTransitionSignal(signal: AbortSignal): boolean {
  return fleetSessionTransitionSignals.has(signal);
}

export async function withFleetSessionRequestLock<T>(
  operation: (requestSignal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal && isFleetSessionTransitionSignal(signal)) {
    return await operation(signal);
  }
  return await withFleetSessionLock('shared', operation, signal);
}

export async function withFleetSessionTransitionLock<T>(
  operation: (transitionSignal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return await withFleetSessionLock('exclusive', operation, signal);
}

async function throwIfFleetSessionCeremonyFailed(response: Response): Promise<void> {
  if (response.status === 401) {
    throw new ApiError(401, 'Unauthorized');
  }
  if (response.ok) return;
  const body = (await response.text().catch(() => '')).trim();
  throw new ApiError(
    response.status,
    body || response.statusText || `HTTP ${response.status}`,
    body || undefined,
  );
}

async function rotateFleetSession(signal?: AbortSignal): Promise<FleetSessionRefreshResult> {
  const csrfResponse = await fetch(FLEET_CSRF_PATH, {
    cache: 'no-store',
    credentials: 'include',
    headers: { Accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
  if (signal) throwIfAborted(signal);
  await throwIfFleetSessionCeremonyFailed(csrfResponse);
  const csrf = await csrfResponse.json() as { csrfToken?: unknown };
  if (typeof csrf.csrfToken !== 'string' || !FLEET_CSRF_TOKEN_PATTERN.test(csrf.csrfToken)) {
    throw new Error('Fleet session refresh CSRF response is malformed');
  }

  const refreshResponse = await fetch(FLEET_SESSION_REFRESH_PATH, {
    method: 'POST',
    cache: 'no-store',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      [FLEET_CSRF_HEADER]: csrf.csrfToken,
    },
    ...(signal ? { signal } : {}),
  });
  if (signal) throwIfAborted(signal);
  await throwIfFleetSessionCeremonyFailed(refreshResponse);
  const result = await refreshResponse.json() as {
    principalStatus?: unknown;
    idleExpiresAt?: unknown;
    absoluteExpiresAt?: unknown;
  };
  const idleExpiresAtMs = typeof result.idleExpiresAt === 'string'
    ? Date.parse(result.idleExpiresAt)
    : Number.NaN;
  const absoluteExpiresAtMs = typeof result.absoluteExpiresAt === 'string'
    ? Date.parse(result.absoluteExpiresAt)
    : Number.NaN;
  if ((result.principalStatus !== 'pending' && result.principalStatus !== 'active')
    || !Number.isFinite(idleExpiresAtMs)
    || !Number.isFinite(absoluteExpiresAtMs)
    || idleExpiresAtMs > absoluteExpiresAtMs) {
    throw new Error('Fleet session refresh response is malformed');
  }
  return {
    principalStatus: result.principalStatus,
    idleExpiresAtMs,
    absoluteExpiresAtMs,
  };
}

export async function refreshFleetSession(signal?: AbortSignal): Promise<FleetSessionRefreshResult> {
  return await withFleetSessionTransitionLock(
    async transitionSignal => await rotateFleetSession(transitionSignal),
    signal,
  );
}

async function readFleetSessionStateUnlocked(
  signal?: AbortSignal,
): Promise<'signed_in' | 'signed_out'> {
  const response = await fetch(FLEET_SESSION_AUTHORITY_PATH, {
    cache: 'no-store',
    credentials: 'include',
    headers: { Accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
  if (signal) throwIfAborted(signal);
  if (response.status === 401) return 'signed_out';
  await throwIfFleetSessionCeremonyFailed(response);
  return 'signed_in';
}

export async function readFleetSessionState(
  signal?: AbortSignal,
): Promise<'signed_in' | 'signed_out'> {
  return await withFleetSessionTransitionLock(
    async transitionSignal => await readFleetSessionStateUnlocked(transitionSignal),
    signal,
  );
}

async function logoutFleetSessionUnlocked(signal?: AbortSignal): Promise<void> {
  const csrfResponse = await fetch(FLEET_CSRF_PATH, {
    cache: 'no-store',
    credentials: 'include',
    headers: { Accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
  if (signal) throwIfAborted(signal);
  await throwIfFleetSessionCeremonyFailed(csrfResponse);
  const csrf = await csrfResponse.json() as { csrfToken?: unknown };
  if (typeof csrf.csrfToken !== 'string' || !FLEET_CSRF_TOKEN_PATTERN.test(csrf.csrfToken)) {
    throw new Error('Fleet logout CSRF response is malformed');
  }
  const response = await fetch('/v1/fleet-auth/logout', {
    method: 'POST',
    cache: 'no-store',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      [FLEET_CSRF_HEADER]: csrf.csrfToken,
    },
    ...(signal ? { signal } : {}),
  });
  if (signal) throwIfAborted(signal);
  await throwIfFleetSessionCeremonyFailed(response);
}

export async function logoutFleetSession(signal?: AbortSignal): Promise<void> {
  await withFleetSessionTransitionLock(
    async transitionSignal => await logoutFleetSessionUnlocked(transitionSignal),
    signal,
  );
}
