import { throwIfNotOk } from './client';
import { throwIfAborted } from './abort';
import { ApiError } from './errors';

const FLEET_SESSION_STATUS_PATH = '/v1/fleet-auth/session/status';
const FLEET_CSRF_PATH = '/v1/fleet-auth/session/csrf';
const FLEET_SESSION_REFRESH_PATH = '/v1/fleet-auth/session/refresh';
const FLEET_CSRF_HEADER = 'X-PSFN-CSRF';
const FLEET_CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const FLEET_SESSION_TRANSITION_LOCK_NAME = 'fleet-session-transition';

export interface FleetSessionRefreshResult {
  principalStatus: 'pending' | 'active';
  idleExpiresAtMs: number;
  absoluteExpiresAtMs: number;
}

export async function withFleetSessionTransitionLock<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (typeof navigator === 'undefined' || !navigator.locks) return await operation();
  return await navigator.locks.request(
    FLEET_SESSION_TRANSITION_LOCK_NAME,
    { mode: 'exclusive', ...(signal ? { signal } : {}) },
    operation,
  );
}

async function throwIfFleetSessionCeremonyFailed(response: Response): Promise<void> {
  if (response.status === 401) {
    throw new ApiError(401, 'Unauthorized');
  }
  await throwIfNotOk(response);
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
  return await withFleetSessionTransitionLock(async () => await rotateFleetSession(signal), signal);
}

async function readFleetSessionStateUnlocked(
  signal?: AbortSignal,
): Promise<'signed_in' | 'signed_out'> {
  const response = await fetch(FLEET_SESSION_STATUS_PATH, {
    cache: 'no-store',
    credentials: 'include',
    headers: { Accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
  if (signal) throwIfAborted(signal);
  await throwIfFleetSessionCeremonyFailed(response);
  const value: unknown = await response.json();
  if (typeof value !== 'object' || value === null
    || !('schemaVersion' in value) || value.schemaVersion !== 1
    || !('state' in value)
    || (value.state !== 'signed_in' && value.state !== 'signed_out')) {
    throw new Error('Fleet session status response is malformed');
  }
  return value.state;
}

export async function readFleetSessionState(
  signal?: AbortSignal,
): Promise<'signed_in' | 'signed_out'> {
  return await withFleetSessionTransitionLock(
    async () => await readFleetSessionStateUnlocked(signal),
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
    async () => await logoutFleetSessionUnlocked(signal),
    signal,
  );
}
