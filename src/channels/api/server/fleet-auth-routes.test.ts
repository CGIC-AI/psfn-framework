import type { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Readable } from 'node:stream';
import { TLSSocket } from 'node:tls';
import { describe, expect, it, vi } from 'vitest';
import {
  FleetAuthBrokerError,
  type GatewayFleetAuthBroker,
} from '../../../boundary/gateway/fleet-auth-broker.js';
import { FleetAuthHttpRoutes } from './fleet-auth-routes.js';

interface CapturedResponse {
  statusCode: number;
  headers: Map<string, string | number | readonly string[]>;
  body: string;
  writableEnded: boolean;
}

function response(): ServerResponse & CapturedResponse {
  const captured: CapturedResponse = {
    statusCode: 200,
    headers: new Map(),
    body: '',
    writableEnded: false,
  };
  return Object.assign(captured, {
    setHeader(name: string, value: string | number | readonly string[]) {
      captured.headers.set(name.toLowerCase(), value);
      return this;
    },
    writeHead(statusCode: number, headers?: Record<string, string>) {
      captured.statusCode = statusCode;
      for (const [name, value] of Object.entries(headers ?? {})) {
        captured.headers.set(name.toLowerCase(), value);
      }
      return this;
    },
    end(body?: string) {
      captured.body = body ?? '';
      captured.writableEnded = true;
      return this;
    },
  }) as unknown as ServerResponse & CapturedResponse;
}

function request(
  method: string,
  headers: IncomingMessage['headers'] = {},
  socket: object = {},
): IncomingMessage {
  return { method, headers, socket } as IncomingMessage;
}

function jsonRequest(body: unknown, headers: IncomingMessage['headers']): IncomingMessage {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method: 'POST',
    headers,
    socket: {},
  }) as unknown as IncomingMessage;
}

function routes(
  overrides: Partial<Record<keyof GatewayFleetAuthBroker, unknown>> = {},
  options: { trustProxy?: boolean } = {},
) {
  const broker = {
    beginLogin: vi.fn(async () => ({
      authorizationUrl: 'https://discord.com/oauth2/authorize?state=opaque',
      initiatingBrowserToken: 'p'.repeat(43),
      expiresAt: new Date('2099-07-15T12:05:00.000Z'),
    })),
    beginLifecycleOAuth: vi.fn(async () => ({
      authorizationUrl: 'https://discord.com/oauth2/authorize?state=lifecycle',
      initiatingBrowserToken: 'q'.repeat(43),
      expiresAt: new Date('2099-07-15T12:05:00.000Z'),
    })),
    completeOAuthCallback: vi.fn(async (input: { requestOrigin: string }) => {
      if (input.requestOrigin !== 'https://fleet.example.test') {
        throw new FleetAuthBrokerError('callback_origin_mismatch', 400);
      }
      return {
        kind: 'login' as const,
        returnPath: '/fleet',
        session: {
          recordId: 'record',
          principalId: 'principal',
          principalStatus: 'pending' as const,
          token: 'a'.repeat(43),
          csrfToken: 'b'.repeat(43),
          idleExpiresAt: new Date('2026-07-15T12:30:00.000Z'),
          absoluteExpiresAt: new Date('2099-07-15T20:00:00.000Z'),
        },
      };
    }),
    issueCsrf: vi.fn(async () => 'b'.repeat(43)),
    rotateSession: vi.fn(async () => ({
      recordId: 'rotated',
      principalId: 'principal',
      principalStatus: 'pending' as const,
      token: 'c'.repeat(43),
      csrfToken: 'd'.repeat(43),
      idleExpiresAt: new Date('2026-07-15T12:30:00.000Z'),
      absoluteExpiresAt: new Date('2099-07-15T20:00:00.000Z'),
    })),
    logout: vi.fn(async () => undefined),
    revokeProvider: vi.fn(async () => undefined),
    ...overrides,
  };
  return {
    broker,
    handler: new FleetAuthHttpRoutes({
      broker: broker as unknown as GatewayFleetAuthBroker,
      canonicalOrigin: 'https://fleet.example.test',
      callbackPath: '/auth/discord/callback',
      ...(options.trustProxy ? { trustProxy: true } : {}),
    }),
  };
}

describe('gateway-only fleet auth HTTP routes', () => {
  it('redirects login with only an opaque initiating-browser __Host- cookie', async () => {
    const { handler, broker } = routes();
    const res = response();
    await handler.handle(
      request('GET'),
      res,
      new URL('https://fleet.example.test/v1/fleet-auth/login?return_to=%2Ffleet'),
    );
    expect(broker.beginLogin).toHaveBeenCalledWith({ returnPath: '/fleet' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.get('location')).toBe('https://discord.com/oauth2/authorize?state=opaque');
    expect(res.headers.get('set-cookie')).toMatch(
      /^__Host-psfn_preauth=p{43}; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Lax$/u,
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('rejects non-TLS callback origins before issuing a cookie', async () => {
    const { handler, broker } = routes();
    const res = response();
    await handler.handle(
      request('GET', { host: 'fleet.example.test' }),
      res,
      new URL('https://fleet.example.test/auth/discord/callback?state=opaque&code=code'),
    );
    expect(broker.completeOAuthCallback).toHaveBeenCalledWith(expect.objectContaining({
      requestOrigin: 'invalid://callback-origin',
    }));
    expect(res.statusCode).toBe(400);
    expect(res.headers.get('set-cookie')).toBe(
      '__Host-psfn_preauth=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax',
    );
  });

  it('sets only an opaque secure HttpOnly __Host- cookie on an exact TLS callback', async () => {
    const { handler, broker } = routes();
    const res = response();
    const tlsSocket = new TLSSocket(new Socket());
    await handler.handle(
      request('GET', {
        host: 'fleet.example.test',
        cookie: `__Host-psfn_preauth=${'p'.repeat(43)}`,
      }, tlsSocket),
      res,
      new URL('https://fleet.example.test/auth/discord/callback?state=opaque&code=code'),
    );
    expect(res.statusCode).toBe(303);
    expect(res.headers.get('location')).toBe('/fleet');
    expect(broker.completeOAuthCallback).toHaveBeenCalledWith(expect.objectContaining({
      initiatingBrowserToken: 'p'.repeat(43),
    }));
    expect(res.headers.get('set-cookie')).toEqual([
      '__Host-psfn_preauth=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax',
      expect.stringMatching(
        /^__Host-psfn_session=a{43}; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Lax$/u,
      ),
    ]);
    expect(res.body).toBe('');
    expect(String(res.headers.get('location'))).not.toContain('a'.repeat(43));
    tlsSocket.destroy();
  });

  it('accepts only the exact configured trusted-proxy callback provenance', async () => {
    const { handler, broker } = routes({}, { trustProxy: true });
    const exactProxyHeaders = {
      host: 'fleet.example.test',
      cookie: `__Host-psfn_preauth=${'p'.repeat(43)}`,
      'x-forwarded-host': 'fleet.example.test',
      'x-forwarded-proto': 'https',
      'x-forwarded-port': '443',
      'x-forwarded-for': '198.51.100.9',
    };
    const accepted = response();
    await handler.handle(
      request('GET', exactProxyHeaders),
      accepted,
      new URL('https://fleet.example.test/auth/discord/callback?state=opaque&code=code'),
    );
    expect(accepted.statusCode).toBe(303);
    expect(broker.completeOAuthCallback).toHaveBeenLastCalledWith(expect.objectContaining({
      requestOrigin: 'https://fleet.example.test',
      initiatingBrowserToken: 'p'.repeat(43),
    }));
    expect(accepted.headers.get('set-cookie')).toEqual(expect.arrayContaining([
      expect.stringMatching(/^__Host-psfn_session=a{43};.*Secure; HttpOnly; SameSite=Lax$/u),
    ]));

    const spoofed = response();
    await handler.handle(
      request('GET', { ...exactProxyHeaders, 'x-forwarded-host': 'attacker.example.test' }),
      spoofed,
      new URL('https://fleet.example.test/auth/discord/callback?state=opaque&code=code'),
    );
    expect(spoofed.statusCode).toBe(400);
    expect(spoofed.headers.get('set-cookie')).toBe(
      '__Host-psfn_preauth=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax',
    );
  });

  it('clears callback cookies and returns only the stable reauthentication response', async () => {
    const { handler } = routes({
      completeOAuthCallback: vi.fn(async () => {
        throw new FleetAuthBrokerError(
          'reauthentication_required',
          401,
          'Reauthentication is required',
        );
      }),
    });
    const res = response();
    const tlsSocket = new TLSSocket(new Socket());
    await handler.handle(
      request('GET', {
        host: 'fleet.example.test',
        cookie: `__Host-psfn_preauth=${'p'.repeat(43)}`,
      }, tlsSocket),
      res,
      new URL('https://fleet.example.test/auth/discord/callback?state=opaque&code=code'),
    );

    expect(res.statusCode).toBe(401);
    expect(res.headers.get('set-cookie')).toEqual([
      '__Host-psfn_preauth=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax',
      '__Host-psfn_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax',
    ]);
    expect(JSON.parse(res.body)).toEqual({
      error: {
        type: 'reauthentication_required',
        message: 'Reauthentication is required',
      },
    });
    expect(res.body).not.toMatch(/provider|subject|token|secret/iu);
    tlsSocket.destroy();
  });

  it('starts lifecycle OAuth only through an authenticated origin-and-CSRF-bound mutation', async () => {
    const { handler, broker } = routes();
    const res = response();
    await handler.handle(
      jsonRequest({
        returnPath: '/fleet/providers',
        ceremonyId: '00000000-0000-4000-8000-000000000301',
        action: 'provider.replace',
        proofRole: 'new',
      }, {
        cookie: `__Host-psfn_session=${'a'.repeat(43)}`,
        origin: 'https://fleet.example.test',
        'x-psfn-csrf': 'b'.repeat(43),
      }),
      res,
      new URL('https://fleet.example.test/v1/fleet-auth/lifecycle/oauth'),
    );

    expect(broker.beginLifecycleOAuth).toHaveBeenCalledWith({
      token: 'a'.repeat(43),
      csrfToken: 'b'.repeat(43),
      requestOrigin: 'https://fleet.example.test',
      returnPath: '/fleet/providers',
      ceremonyId: '00000000-0000-4000-8000-000000000301',
      action: 'provider.replace',
      proofRole: 'new',
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://discord.com/oauth2/authorize?state=lifecycle',
    );
    expect(res.headers.get('set-cookie')).toMatch(
      /^__Host-psfn_preauth=q{43}; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Lax$/u,
    );
  });

  it('returns a purpose-bound lifecycle proof without creating or exposing a session token', async () => {
    const callbackTransactionId = '00000000-0000-4000-8000-000000000302';
    const { handler } = routes({
      completeOAuthCallback: vi.fn(async () => ({
        kind: 'lifecycle' as const,
        returnPath: '/fleet/providers',
        ceremonyId: '00000000-0000-4000-8000-000000000301',
        action: 'provider.replace' as const,
        proofRole: 'new' as const,
        proof: {
          provider: 'discord' as const,
          subjectId: '123456789012345679',
          callbackTransactionId,
          proofDigest: 'c'.repeat(64),
        },
      })),
    });
    const res = response();
    const tlsSocket = new TLSSocket(new Socket());
    await handler.handle(
      request('GET', {
        host: 'fleet.example.test',
        cookie: `__Host-psfn_preauth=${'p'.repeat(43)}; __Host-psfn_session=${'a'.repeat(43)}`,
      }, tlsSocket),
      res,
      new URL('https://fleet.example.test/auth/discord/callback?state=opaque&code=code'),
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers.get('set-cookie')).toBe(
      '__Host-psfn_preauth=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax',
    );
    expect(JSON.parse(res.body)).toEqual({
      kind: 'lifecycle',
      returnPath: '/fleet/providers',
      ceremonyId: '00000000-0000-4000-8000-000000000301',
      action: 'provider.replace',
      proofRole: 'new',
      proof: {
        provider: 'discord',
        subjectId: '123456789012345679',
        callbackTransactionId,
        proofDigest: 'c'.repeat(64),
      },
    });
    expect(res.body).not.toContain('a'.repeat(43));
    expect(res.body).not.toContain('provider-access-secret');
    expect(res.headers.get('location')).toBeUndefined();
    tlsSocket.destroy();
  });

  it('requires one opaque __Host- session cookie, exact Origin, and session-bound CSRF to rotate', async () => {
    const { handler, broker } = routes();
    const res = response();
    await handler.handle(
      request('POST', {
        cookie: `__Host-psfn_session=${'a'.repeat(43)}`,
        origin: 'https://fleet.example.test',
        'x-psfn-csrf': 'b'.repeat(43),
      }),
      res,
      new URL('https://fleet.example.test/v1/fleet-auth/session/refresh'),
    );
    expect(broker.rotateSession).toHaveBeenCalledWith({
      token: 'a'.repeat(43),
      csrfToken: 'b'.repeat(43),
      requestOrigin: 'https://fleet.example.test',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(
      /^__Host-psfn_session=c{43}; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Lax$/u,
    );

    const duplicate = response();
    await handler.handle(
      request('POST', {
        cookie: `__Host-psfn_session=${'a'.repeat(43)}; __Host-psfn_session=${'e'.repeat(43)}`,
        origin: 'https://fleet.example.test',
        'x-psfn-csrf': 'b'.repeat(43),
      }),
      duplicate,
      new URL('https://fleet.example.test/v1/fleet-auth/session/refresh'),
    );
    expect(duplicate.statusCode).toBe(401);
    expect(broker.rotateSession).toHaveBeenCalledTimes(1);
  });

  it('clears the prior session cookie when rotation requires reauthentication', async () => {
    const { handler } = routes({
      rotateSession: vi.fn(async () => {
        throw new FleetAuthBrokerError(
          'reauthentication_required',
          401,
          'Reauthentication is required',
        );
      }),
    });
    const res = response();
    await handler.handle(
      request('POST', {
        cookie: `__Host-psfn_session=${'a'.repeat(43)}`,
        origin: 'https://fleet.example.test',
        'x-psfn-csrf': 'b'.repeat(43),
      }),
      res,
      new URL('https://fleet.example.test/v1/fleet-auth/session/refresh'),
    );

    expect(res.statusCode).toBe(401);
    expect(res.headers.get('set-cookie')).toBe(
      '__Host-psfn_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax',
    );
    expect(JSON.parse(res.body)).toEqual({
      error: {
        type: 'reauthentication_required',
        message: 'Reauthentication is required',
      },
    });
  });

  it('logs out through session-bound CSRF even when companion runtimes are unavailable', async () => {
    const logout = vi.fn(async (input: { requestOrigin: string }) => {
      if (input.requestOrigin !== 'https://fleet.example.test') {
        throw new FleetAuthBrokerError('origin_mismatch', 403, 'Origin is invalid');
      }
    });
    const { handler } = routes({ logout });
    const res = response();
    await handler.handle(
      request('POST', {
        cookie: `__Host-psfn_session=${'a'.repeat(43)}`,
        origin: 'https://fleet.example.test',
        'x-psfn-csrf': 'b'.repeat(43),
      }),
      res,
      new URL('https://fleet.example.test/v1/fleet-auth/logout'),
    );
    expect(logout).toHaveBeenCalledWith({
      token: 'a'.repeat(43),
      csrfToken: 'b'.repeat(43),
      requestOrigin: 'https://fleet.example.test',
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers.get('set-cookie')).toBe(
      '__Host-psfn_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax',
    );

    const confusedOrigin = response();
    await handler.handle(
      request('POST', {
        cookie: `__Host-psfn_session=${'a'.repeat(43)}`,
        origin: 'https://attacker.example.test',
        'x-psfn-csrf': 'b'.repeat(43),
      }),
      confusedOrigin,
      new URL('https://fleet.example.test/v1/fleet-auth/logout'),
    );
    expect(confusedOrigin.statusCode).toBe(403);
    expect(confusedOrigin.headers.get('set-cookie')).toBeUndefined();
  });
});
