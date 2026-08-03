import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  FleetEscalationError,
  type FleetEscalationCoordinator,
} from '../../../boundary/fleet-auth/escalation.js';
import { FleetAuthBrokerError } from '../../../boundary/gateway/fleet-auth-broker.js';
import {
  FLEET_AUTH_ESCALATION_GRANT_PATH,
  FleetAuthEscalationHttpRoutes,
} from './fleet-auth-escalation-routes.js';

const ORIGIN = 'https://fleet.example.test';
const GRANT_ID = '55555555-5555-4555-8555-555555555555';
const EXPIRES_AT = new Date('2026-07-30T20:15:00.000Z');

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

function request(body: unknown): IncomingMessage {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    socket: {},
  }) as unknown as IncomingMessage;
}

function coordinator(issue?: FleetEscalationCoordinator['issueGrant']) {
  const issueGrant = vi.fn(issue ?? (async () => ({
    grantId: GRANT_ID,
    routeId: 'POST /api/admin/memory/:id/reveal',
    expiresAt: EXPIRES_AT,
  })));
  return { value: { issueGrant } as Pick<FleetEscalationCoordinator, 'issueGrant'>, issueGrant };
}

function validBody(): Record<string, unknown> {
  return {
    companionId: '11111111-1111-4111-8111-111111111111',
    method: 'POST',
    target: '/api/admin/memory/memory-a/reveal',
    reason: 'Cogsec remediation of an old memory',
  };
}

async function handle(
  routes: FleetAuthEscalationHttpRoutes,
  body: unknown,
): Promise<ServerResponse & CapturedResponse> {
  const res = response();
  await routes.handle({
    request: request(body),
    response: res,
    path: FLEET_AUTH_ESCALATION_GRANT_PATH,
    token: 'session-token',
    csrfToken: 'csrf-token',
    requestOrigin: ORIGIN,
  });
  return res;
}

describe('FleetAuthEscalationHttpRoutes', () => {
  it('matches only POST on the escalation grant path', () => {
    const routes = new FleetAuthEscalationHttpRoutes(coordinator().value);
    expect(routes.matches('POST', FLEET_AUTH_ESCALATION_GRANT_PATH)).toBe(true);
    expect(routes.matches('GET', FLEET_AUTH_ESCALATION_GRANT_PATH)).toBe(false);
    expect(routes.matches('POST', '/v1/fleet-auth/escalation/other')).toBe(false);
  });

  it('compiles the declared route target and issues an audited grant', async () => {
    const { value, issueGrant } = coordinator();
    const routes = new FleetAuthEscalationHttpRoutes(value);
    const res = await handle(routes, validBody());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      grantId: GRANT_ID,
      routeId: 'POST /api/admin/memory/:id/reveal',
      expiresAt: EXPIRES_AT.toISOString(),
    });
    expect(res.headers.get('cache-control')).toBe('no-store');
    const call = issueGrant.mock.calls[0]![0];
    expect(call.token).toBe('session-token');
    expect(call.csrfToken).toBe('csrf-token');
    expect(call.requestOrigin).toBe(ORIGIN);
    expect(call.binding.reason).toBe('Cogsec remediation of an old memory');
    expect(call.binding.target.action).toBe('memory.reveal');
    expect(call.binding.target.resource.routeId).toBe('POST /api/admin/memory/:id/reveal');
    expect(call.binding.target.resource.pathParams.id).toBe('memory-a');
  });

  it('compiles the exact companion-journal confirmation target', async () => {
    const { value, issueGrant } = coordinator(async () => ({
      grantId: GRANT_ID,
      routeId: 'POST /api/admin/privacy-break-glass/journal/:id/confirm',
      expiresAt: EXPIRES_AT,
    }));
    const routes = new FleetAuthEscalationHttpRoutes(value);
    const res = await handle(routes, {
      companionId: '11111111-1111-4111-8111-111111111111',
      method: 'POST',
      target: '/api/admin/privacy-break-glass/journal/reflection-journal/confirm',
      reason: 'Contain an active compromise.',
    });

    expect(res.statusCode).toBe(200);
    expect(issueGrant).toHaveBeenCalledWith(expect.objectContaining({
      requestOrigin: ORIGIN,
      binding: expect.objectContaining({ reason: 'Contain an active compromise.' }),
    }));
    const target = issueGrant.mock.calls[0]![0].binding.target;
    expect(target).toMatchObject({
      action: 'privacy.break_glass',
      resource: {
        routeId: 'POST /api/admin/privacy-break-glass/journal/:id/confirm',
        pathParams: { id: 'reflection-journal' },
      },
    });
  });

  it('rejects unknown keys and malformed companion ids as 400', async () => {
    const routes = new FleetAuthEscalationHttpRoutes(coordinator().value);
    await expect(handle(routes, { ...validBody(), extra: true }))
      .rejects.toMatchObject({ status: 400 });
    await expect(handle(routes, { ...validBody(), companionId: 'not-a-uuid' }))
      .rejects.toMatchObject({ status: 400 });
    await expect(handle(routes, { ...validBody(), reason: undefined }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('translates non-escalation surfaces to 404 without leaking route existence', async () => {
    const { value } = coordinator(async () => {
      throw new FleetEscalationError('not_escalation_surface', 'This route is not an escalation surface');
    });
    const routes = new FleetAuthEscalationHttpRoutes(value);
    await expect(handle(routes, validBody())).rejects.toMatchObject({
      status: 404,
      code: 'not_escalation_surface',
    });
  });

  it('translates session and origin failures fail-closed', async () => {
    for (const [code, status] of [
      ['session_unavailable', 401],
      ['origin_mismatch', 403],
      ['grant_unavailable', 409],
    ] as const) {
      const { value } = coordinator(async () => {
        throw new FleetEscalationError(code, 'denied');
      });
      const routes = new FleetAuthEscalationHttpRoutes(value);
      await expect(handle(routes, validBody())).rejects.toMatchObject({ status, code });
    }
  });

  it('passes broker errors through untranslated', async () => {
    const { value } = coordinator(async () => {
      throw new FleetAuthBrokerError('invalid_session', 401, 'Session is invalid or expired');
    });
    const routes = new FleetAuthEscalationHttpRoutes(value);
    await expect(handle(routes, validBody())).rejects.toMatchObject({
      status: 401,
      code: 'invalid_session',
    });
  });
});
