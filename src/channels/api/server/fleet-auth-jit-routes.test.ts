import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { FleetJitStepUpCoordinator } from '../../../boundary/fleet-auth/jit-step-up.js';
import {
  FLEET_AUTH_JIT_WEBAUTHN_START_PATH,
  FleetAuthJitHttpRoutes,
} from './fleet-auth-jit-routes.js';

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

function coordinator() {
  const startWebAuthn = vi.fn(async () => ({
    challengeId: '44444444-4444-4444-8444-444444444444',
    requestNonce: 'n'.repeat(43),
    assurance: 'webauthn_uv' as const,
    publicKey: { challenge: 'opaque' },
  }));
  const value: Pick<FleetJitStepUpCoordinator,
    | 'startWebAuthn'
    | 'finishWebAuthn'
    | 'startDiscordPossession'
    | 'finishDiscordPossession'
    | 'cancel'> = {
      startWebAuthn,
      finishWebAuthn: vi.fn(),
      startDiscordPossession: vi.fn(),
      finishDiscordPossession: vi.fn(),
      cancel: vi.fn(),
    };
  return { value, startWebAuthn };
}

function validStartBody(): Record<string, unknown> {
  return {
    companionId: '11111111-1111-4111-8111-111111111111',
    method: 'POST',
    target: '/api/admin/channels/context-envelope',
    bodyBase64url: Buffer.from('{"channel":"direct"}', 'utf8').toString('base64url'),
    subjectScopeDigest: 'a'.repeat(64),
    purpose: 'Approve the exact channel operation',
    memoryRevision: 1,
    classifierEvidenceDigest: 'b'.repeat(64),
  };
}

describe('FleetAuthJitHttpRoutes', () => {
  it('compiles an exact declared route target before invoking the coordinator', async () => {
    const fixture = coordinator();
    const routes = new FleetAuthJitHttpRoutes(fixture.value);
    const res = response();
    await routes.handle({
      request: request(validStartBody()),
      response: res,
      path: FLEET_AUTH_JIT_WEBAUTHN_START_PATH,
      token: 'session',
      csrfToken: 'csrf',
      requestOrigin: 'https://fleet.example.test',
    });
    expect(fixture.startWebAuthn).toHaveBeenCalledWith(expect.objectContaining({
      token: 'session',
      csrfToken: 'csrf',
      requestOrigin: 'https://fleet.example.test',
      binding: expect.objectContaining({
        target: expect.objectContaining({
          companionId: '11111111-1111-4111-8111-111111111111',
          action: 'channels.manage',
          authorization: expect.objectContaining({
            requirements: expect.objectContaining({ assurance: 'webauthn_uv' }),
          }),
        }),
      }),
    }));
    expect(res.statusCode).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects browser-supplied authority fields before coordinator dispatch', async () => {
    const fixture = coordinator();
    const routes = new FleetAuthJitHttpRoutes(fixture.value);
    const res = response();
    await expect(routes.handle({
      request: request({ ...validStartBody(), action: 'roles.manage' }),
      response: res,
      path: FLEET_AUTH_JIT_WEBAUTHN_START_PATH,
      token: 'session',
      csrfToken: 'csrf',
      requestOrigin: 'https://fleet.example.test',
    })).rejects.toMatchObject({ code: 'invalid_jit_request', status: 400 });
    expect(fixture.startWebAuthn).not.toHaveBeenCalled();
  });
});
