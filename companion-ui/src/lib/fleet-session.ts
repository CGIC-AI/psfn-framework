import { isObjectRecord as isRecord } from '../../../src/shared/utils/types.js';
import { hasExactKeys } from './protocol/validation.js';

const STATUS_PATH = '/v1/fleet-auth/session/status';
const CSRF_PATH = '/v1/fleet-auth/session/csrf';
const LOGOUT_PATH = '/v1/fleet-auth/logout';
const FLEET_SESSION_TRANSITION_LOCK_NAME = 'fleet-session-transition';
const FLEET_SESSION_TRANSITION_TIMEOUT_MS = 10_000;
const ROLES = ['owner', 'admin', 'member', 'guest'] as const;
const WEBSOCKET_PATH = /^\/companion-ui\/companions\/[0-9a-f-]{36}\/ws$/u;

export type FleetSessionStatus = Readonly<{
  schemaVersion: 1;
  state: 'signed_out';
  guestMode: 'disabled' | 'explicit';
  websocketPath?: string;
}> | Readonly<{
  schemaVersion: 1;
  state: 'signed_in';
  guestMode: 'disabled' | 'explicit';
  websocketPath: string;
  human: Readonly<{
    provider: 'discord';
    label: string;
    role: typeof ROLES[number];
  }>;
}>;

export class FleetSessionProtocolError extends Error {
  constructor(message = 'Fleet session response was malformed') {
    super(message);
    this.name = 'FleetSessionProtocolError';
  }
}

/**
 * Validates the one canonical Companion UI stream path
 * (`/companion-ui/companions/<uuid>/ws`). Exported so the roster client
 * (`fleet-roster.ts`) applies the SAME rule: the active companion is expressed
 * only by which of these paths the app opens — never by a client-side identity
 * field. The path is not tied to the signed-in companion, so the app may open
 * any authorized companion's stream from the roster.
 */
export function validWebsocketPath(value: unknown): value is string {
  return typeof value === 'string' && WEBSOCKET_PATH.test(value) && !value.includes('?');
}

export function parseFleetSessionStatus(value: unknown): FleetSessionStatus {
  if (!isRecord(value) || value.schemaVersion !== 1
    || (value.guestMode !== 'disabled' && value.guestMode !== 'explicit')) {
    throw new FleetSessionProtocolError();
  }
  if (value.state === 'signed_out') {
    const explicit = value.guestMode === 'explicit';
    if (!hasExactKeys(value, explicit
      ? ['schemaVersion', 'state', 'guestMode', 'websocketPath']
      : ['schemaVersion', 'state', 'guestMode'])
      || (explicit && !validWebsocketPath(value.websocketPath))) {
      throw new FleetSessionProtocolError();
    }
    return Object.freeze({
      schemaVersion: 1,
      state: 'signed_out',
      guestMode: value.guestMode,
      ...(explicit ? { websocketPath: String(value.websocketPath) } : {}),
    });
  }
  if (value.state !== 'signed_in'
    || !hasExactKeys(value, ['schemaVersion', 'state', 'guestMode', 'websocketPath', 'human'])
    || !validWebsocketPath(value.websocketPath)
    || !isRecord(value.human)
    || !hasExactKeys(value.human, ['provider', 'label', 'role'])
    || value.human.provider !== 'discord'
    || typeof value.human.label !== 'string'
    || value.human.label.length < 1 || value.human.label.length > 80
    || typeof value.human.role !== 'string'
    || !ROLES.includes(value.human.role as typeof ROLES[number])) {
    throw new FleetSessionProtocolError();
  }
  return Object.freeze({
    schemaVersion: 1,
    state: 'signed_in',
    guestMode: value.guestMode,
    websocketPath: value.websocketPath,
    human: Object.freeze({
      provider: 'discord',
      label: value.human.label,
      role: value.human.role as typeof ROLES[number],
    }),
  });
}

type FetchLike = typeof fetch;

async function withFleetSessionTransitionLock<T>(
  operation: (transitionSignal: AbortSignal) => Promise<T>,
): Promise<T> {
  const transitionSignal = AbortSignal.timeout(FLEET_SESSION_TRANSITION_TIMEOUT_MS);
  if (typeof navigator === 'undefined') return await operation(transitionSignal);
  if (!navigator.locks) {
    throw new FleetSessionProtocolError('Browser session coordination is unavailable');
  }
  return await navigator.locks.request(
    FLEET_SESSION_TRANSITION_LOCK_NAME,
    { mode: 'exclusive', signal: transitionSignal },
    async () => await operation(transitionSignal),
  );
}

export class FleetSessionClient {
  constructor(private readonly fetchImpl: FetchLike = (...args) => fetch(...args)) {}

  async readStatus(): Promise<FleetSessionStatus> {
    return await withFleetSessionTransitionLock(async transitionSignal => {
      const response = await this.fetchImpl(STATUS_PATH, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        redirect: 'error',
        signal: transitionSignal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok || response.headers.get('cache-control')?.toLowerCase().includes('no-store') !== true) {
        throw new FleetSessionProtocolError('Fleet session status was unavailable');
      }
      return parseFleetSessionStatus(await response.json());
    });
  }

  async logout(): Promise<void> {
    await withFleetSessionTransitionLock(async transitionSignal => {
      const csrf = await this.readCsrf(transitionSignal);
      const response = await this.fetchImpl(LOGOUT_PATH, {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        redirect: 'error',
        signal: transitionSignal,
        headers: {
          Accept: 'application/json',
          'X-PSFN-CSRF': csrf,
        },
      });
      if (response.status !== 204) throw new FleetSessionProtocolError('Fleet logout was denied');
    });
  }

  private async readCsrf(signal: AbortSignal): Promise<string> {
    const response = await this.fetchImpl(CSRF_PATH, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'error',
      signal,
      headers: { Accept: 'application/json' },
    });
    const value: unknown = response.ok ? await response.json() : undefined;
    if (!isRecord(value) || !hasExactKeys(value, ['csrfToken'])
      || typeof value.csrfToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value.csrfToken)) {
      throw new FleetSessionProtocolError('Fleet logout authorization was unavailable');
    }
    return value.csrfToken;
  }
}
