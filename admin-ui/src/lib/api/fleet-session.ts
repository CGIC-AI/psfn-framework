import { throwIfNotOk } from './client';
import { throwIfAborted } from './abort';

const FLEET_CSRF_PATH = '/v1/fleet-auth/session/csrf';
const FLEET_SESSION_REFRESH_PATH = '/v1/fleet-auth/session/refresh';
const FLEET_CSRF_HEADER = 'X-PSFN-CSRF';
const FLEET_CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export interface FleetSessionRefreshResult {
  principalStatus: 'pending' | 'active';
  idleExpiresAtMs: number;
  absoluteExpiresAtMs: number;
}

export async function refreshFleetSession(signal?: AbortSignal): Promise<FleetSessionRefreshResult> {
  const csrfResponse = await fetch(FLEET_CSRF_PATH, {
    cache: 'no-store',
    credentials: 'include',
    headers: { Accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
  if (signal) throwIfAborted(signal);
  await throwIfNotOk(csrfResponse);
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
  await throwIfNotOk(refreshResponse);
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
