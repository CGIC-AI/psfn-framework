import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FleetSessionClient,
  FleetSessionProtocolError,
  parseFleetSessionStatus,
} from './fleet-session.js';

const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const WS_PATH = `/companion-ui/companions/${COMPANION_ID}/ws`;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Cache-Control': 'no-store, private', 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.stubGlobal('navigator', {
    locks: {
      request: async <T>(
        _name: string,
        _options: LockOptions,
        callback: () => Promise<T>,
      ): Promise<T> => await callback(),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fleet session protocol', () => {
  it('accepts only exact sanitized status variants', () => {
    expect(parseFleetSessionStatus({
      schemaVersion: 1,
      state: 'signed_in',
      guestMode: 'disabled',
      websocketPath: WS_PATH,
      human: { provider: 'discord', label: 'Discord user', role: 'member' },
    })).toEqual(expect.objectContaining({ state: 'signed_in', websocketPath: WS_PATH }));
    expect(parseFleetSessionStatus({
      schemaVersion: 1,
      state: 'signed_out',
      guestMode: 'explicit',
      websocketPath: WS_PATH,
    })).toEqual(expect.objectContaining({ state: 'signed_out', guestMode: 'explicit' }));
  });

  it.each([
    { schemaVersion: 1, state: 'signed_in', guestMode: 'disabled', websocketPath: `${WS_PATH}?token=x`, human: { provider: 'discord', label: 'Discord user', role: 'member' } },
    { schemaVersion: 1, state: 'signed_in', guestMode: 'disabled', websocketPath: WS_PATH, human: { provider: 'discord', label: 'Discord user', role: 'member', subjectId: 'secret' } },
    { schemaVersion: 1, state: 'signed_out', guestMode: 'disabled', websocketPath: WS_PATH },
    { schemaVersion: 1, state: 'signed_out', guestMode: 'surprise' },
  ])('rejects malformed or authority-bearing status %#', (value) => {
    expect(() => parseFleetSessionStatus(value)).toThrow(FleetSessionProtocolError);
  });

  it('reads no-store status and keeps cookies browser-owned', async () => {
    const fetchImpl = vi.fn(async () => json({
      schemaVersion: 1,
      state: 'signed_out',
      guestMode: 'disabled',
    }));
    const client = new FleetSessionClient(fetchImpl as typeof fetch);
    await expect(client.readStatus()).resolves.toEqual({
      schemaVersion: 1, state: 'signed_out', guestMode: 'disabled',
    });
    expect(fetchImpl).toHaveBeenCalledWith('/v1/fleet-auth/session/status', expect.objectContaining({
      credentials: 'include', cache: 'no-store', redirect: 'error',
    }));
  });

  it('uses a transient exact CSRF response for logout without returning it', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ csrfToken: 'c'.repeat(43) }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new FleetSessionClient(fetchImpl as typeof fetch);
    await expect(client.logout()).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenLastCalledWith('/v1/fleet-auth/logout', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      headers: expect.objectContaining({ 'X-PSFN-CSRF': 'c'.repeat(43) }),
    }));
  });

  it('fails closed when a browser cannot coordinate origin-wide session transitions', async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('navigator', {});
    const client = new FleetSessionClient(fetchImpl as typeof fetch);

    await expect(client.readStatus()).rejects.toThrow(/coordination is unavailable/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('serializes status and logout on the origin-wide session transition lock', async () => {
    let lockTail = Promise.resolve();
    const requestLock = vi.fn(async <T>(
      _name: string,
      _options: LockOptions,
      callback: () => Promise<T>,
    ): Promise<T> => {
      const previous = lockTail;
      let release = () => {};
      lockTail = new Promise<void>((resolve) => { release = resolve; });
      await previous;
      try {
        return await callback();
      } finally {
        release();
      }
    });
    vi.stubGlobal('navigator', { locks: { request: requestLock } });
    let activeRequests = 0;
    let maximumActiveRequests = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      await new Promise(resolve => setTimeout(resolve, 2));
      try {
        const path = String(input);
        if (path === '/v1/fleet-auth/session/status') {
          return json({ schemaVersion: 1, state: 'signed_out', guestMode: 'disabled' });
        }
        if (path === '/v1/fleet-auth/session/csrf') return json({ csrfToken: 'c'.repeat(43) });
        if (path === '/v1/fleet-auth/logout') return new Response(null, { status: 204 });
        throw new Error(`Unexpected request: ${path}`);
      } finally {
        activeRequests -= 1;
      }
    });
    const client = new FleetSessionClient(fetchImpl as typeof fetch);

    await expect(Promise.all([client.readStatus(), client.logout()])).resolves.toHaveLength(2);

    expect(requestLock).toHaveBeenCalledTimes(2);
    expect(new Set(requestLock.mock.calls.map(call => call[0]))).toEqual(
      new Set(['fleet-session-transition']),
    );
    expect(requestLock.mock.calls.every(call => call[1].signal instanceof AbortSignal)).toBe(true);
    expect(maximumActiveRequests).toBe(1);
  });
});
