import type { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
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

function routes(overrides: Partial<Record<keyof GatewayFleetAuthBroker, unknown>> = {}) {
  const broker = {
    beginLogin: vi.fn(async () => ({
      authorizationUrl: 'https://discord.com/oauth2/authorize?state=opaque',
    })),
    completeCallback: vi.fn(async (input: { requestOrigin: string }) => {
      if (input.requestOrigin !== 'https://fleet.example.test') {
        throw new FleetAuthBrokerError('callback_origin_mismatch', 400);
      }
      return {
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
    }),
  };
}

describe('gateway-only fleet auth HTTP routes', () => {
  it('redirects login to the broker-generated authorization URL without setting credentials', async () => {
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
    expect(res.headers.has('set-cookie')).toBe(false);
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
    expect(broker.completeCallback).toHaveBeenCalledWith(expect.objectContaining({
      requestOrigin: 'invalid://callback-origin',
    }));
    expect(res.statusCode).toBe(400);
    expect(res.headers.has('set-cookie')).toBe(false);
  });

  it('sets only an opaque secure HttpOnly __Host- cookie on an exact TLS callback', async () => {
    const { handler } = routes();
    const res = response();
    const tlsSocket = new TLSSocket(new Socket());
    await handler.handle(
      request('GET', { host: 'fleet.example.test' }, tlsSocket),
      res,
      new URL('https://fleet.example.test/auth/discord/callback?state=opaque&code=code'),
    );
    expect(res.statusCode).toBe(303);
    expect(res.headers.get('location')).toBe('/fleet');
    expect(res.headers.get('set-cookie')).toMatch(
      /^__Host-psfn_session=a{43}; Path=\/; Max-Age=\d+; Secure; HttpOnly; SameSite=Lax$/u,
    );
    expect(res.body).toBe('');
    expect(String(res.headers.get('location'))).not.toContain('a'.repeat(43));
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
});
