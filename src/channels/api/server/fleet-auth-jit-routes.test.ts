import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  FleetJitStepUpError,
  type FleetJitStepUpCoordinator,
} from '../../../boundary/fleet-auth/jit-step-up.js';
import {
  FLEET_AUTH_JIT_DISCORD_START_PATH,
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

  it('requires a memory grant to match the exact reveal body and rejects session-wide elevation', async () => {
    const memoryBody = {
      subjectScopeDigest: 'c'.repeat(64),
      purpose: 'Review my own intimate memory',
      memoryRevision: 4,
      classifierVersion: 1,
      classifierEvidenceDigest: 'd'.repeat(64),
    };
    const valid = {
      companionId: '11111111-1111-4111-8111-111111111111',
      method: 'POST',
      target: '/api/admin/memory/memory-a/reveal',
      bodyBase64url: Buffer.from(JSON.stringify(memoryBody), 'utf8').toString('base64url'),
      subjectScopeDigest: memoryBody.subjectScopeDigest,
      purpose: memoryBody.purpose,
      memoryRevision: memoryBody.memoryRevision,
      classifierEvidenceDigest: memoryBody.classifierEvidenceDigest,
    };
    const accepted = coordinator();
    const acceptedRoutes = new FleetAuthJitHttpRoutes(accepted.value);
    await acceptedRoutes.handle({
      request: request(valid),
      response: response(),
      path: FLEET_AUTH_JIT_WEBAUTHN_START_PATH,
      token: 'session',
      csrfToken: 'csrf',
      requestOrigin: 'https://fleet.example.test',
    });
    expect(accepted.startWebAuthn).toHaveBeenCalledOnce();

    const mismatch = coordinator();
    await expect(new FleetAuthJitHttpRoutes(mismatch.value).handle({
      request: request({ ...valid, memoryRevision: 5 }),
      response: response(),
      path: FLEET_AUTH_JIT_WEBAUTHN_START_PATH,
      token: 'session',
      csrfToken: 'csrf',
      requestOrigin: 'https://fleet.example.test',
    })).rejects.toMatchObject({ code: 'invalid_jit_request', status: 400 });
    expect(mismatch.startWebAuthn).not.toHaveBeenCalled();

    const elevation = coordinator();
    await expect(new FleetAuthJitHttpRoutes(elevation.value).handle({
      request: request({
        ...valid,
        target: '/api/admin/memory/elevation',
        bodyBase64url: '',
      }),
      response: response(),
      path: FLEET_AUTH_JIT_WEBAUTHN_START_PATH,
      token: 'session',
      csrfToken: 'csrf',
      requestOrigin: 'https://fleet.example.test',
    })).rejects.toMatchObject({ code: 'invalid_jit_request', status: 400 });
    expect(elevation.startWebAuthn).not.toHaveBeenCalled();
  });

  it('derives privacy break-glass authority only from one exact confirm target', async () => {
    const breakGlassBody = {
      reasonCategory: 'incident_response',
      reason: 'Contain an active account compromise.',
    };
    const startBody = {
      companionId: '11111111-1111-4111-8111-111111111111',
      method: 'POST',
      target: '/api/admin/privacy-break-glass/memory/memory-b/confirm',
      bodyBase64url: Buffer.from(JSON.stringify(breakGlassBody), 'utf8').toString('base64url'),
    };
    const accepted = coordinator();
    await new FleetAuthJitHttpRoutes(accepted.value).handle({
      request: request(startBody),
      response: response(),
      path: FLEET_AUTH_JIT_WEBAUTHN_START_PATH,
      token: 'session',
      csrfToken: 'csrf',
      requestOrigin: 'https://fleet.example.test',
    });
    expect(accepted.startWebAuthn).toHaveBeenCalledWith(expect.objectContaining({
      binding: expect.objectContaining({
        target: expect.objectContaining({
          action: 'privacy.break_glass',
          authorization: expect.objectContaining({
            requirements: expect.objectContaining({ assurance: 'privacy_break_glass' }),
          }),
        }),
        subjectScopeDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        purpose: expect.stringContaining('incident_response'),
        memoryRevision: 1,
        classifierEvidenceDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }),
    }));

    for (const invalid of [
      { ...startBody, subjectScopeDigest: 'a'.repeat(64) },
      { ...startBody, purpose: 'browser authority' },
      { ...startBody, target: '/api/admin/privacy-break-glass/memory/memory-b/decide' },
    ]) {
      const denied = coordinator();
      await expect(new FleetAuthJitHttpRoutes(denied.value).handle({
        request: request(invalid),
        response: response(),
        path: FLEET_AUTH_JIT_WEBAUTHN_START_PATH,
        token: 'session',
        csrfToken: 'csrf',
        requestOrigin: 'https://fleet.example.test',
      })).rejects.toMatchObject({ code: 'invalid_jit_request', status: 400 });
      expect(denied.startWebAuthn).not.toHaveBeenCalled();
    }
  });

  it('cannot turn Discord possession into privacy break-glass authority', async () => {
    const fixture = coordinator();
    fixture.value.startDiscordPossession = vi.fn().mockRejectedValue(new FleetJitStepUpError(
      'strong_assurance_required',
      'Privacy break-glass requires UV WebAuthn',
    ));
    await expect(new FleetAuthJitHttpRoutes(fixture.value).handle({
      request: request({
        companionId: '11111111-1111-4111-8111-111111111111',
        method: 'POST',
        target: '/api/admin/privacy-break-glass/profile/contact-b/confirm',
        bodyBase64url: Buffer.from(JSON.stringify({
          reasonCategory: 'safety_intervention',
          reason: 'Immediate welfare check.',
        }), 'utf8').toString('base64url'),
      }),
      response: response(),
      path: FLEET_AUTH_JIT_DISCORD_START_PATH,
      token: 'session',
      csrfToken: 'csrf',
      requestOrigin: 'https://fleet.example.test',
    })).rejects.toMatchObject({ code: 'strong_assurance_required', status: 403 });
  });
});
