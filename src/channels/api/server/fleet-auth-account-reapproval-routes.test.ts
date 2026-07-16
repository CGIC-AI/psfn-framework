import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { TrustedHostAccountReapprovalService } from '../../../boundary/fleet-auth/trusted-host-account-reapproval.js';
import {
  FLEET_AUTH_ACCOUNT_REAPPROVAL_FINISH_PATH,
  FLEET_AUTH_ACCOUNT_REAPPROVAL_START_PATH,
  FleetAuthAccountReapprovalHttpRoutes,
} from './fleet-auth-account-reapproval-routes.js';

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

const providerProof = {
  provider: 'discord' as const,
  subjectId: '123456789012345678',
  callbackTransactionId: '11111111-1111-4111-8111-111111111111',
  proofDigest: createHash('sha256').update(
    'fleet-auth-verified-provider-proof:v1:discord:'
    + '123456789012345678:11111111-1111-4111-8111-111111111111',
  ).digest('hex'),
};
const common = {
  token: 'session-token',
  csrfToken: 'csrf-token',
  requestOrigin: 'https://fleet.example.test',
};

function fixture() {
  const startAuthentication = vi.fn(async () => ({
    ceremonyId: '22222222-2222-4222-8222-222222222222',
    publicKey: { challenge: 'opaque' },
  }));
  const finishAuthentication = vi.fn(async () => ({
    principalId: '33333333-3333-4333-8333-333333333333',
    authorityGeneration: 2,
    globalAuthEpoch: 3,
    authnVersion: 2,
    authzVersion: 2,
    bindingVersion: 2,
    roleVersion: 2,
    auditEventId: '44444444-4444-4444-8444-444444444444',
    reauthenticationRequired: true as const,
  }));
  const service: Pick<TrustedHostAccountReapprovalService,
    'startAuthentication' | 'finishAuthentication'> = {
      startAuthentication,
      finishAuthentication,
    };
  return {
    routes: new FleetAuthAccountReapprovalHttpRoutes(service),
    startAuthentication,
    finishAuthentication,
  };
}

describe('FleetAuthAccountReapprovalHttpRoutes', () => {
  it('starts exact same-origin UV authentication with active session evidence', async () => {
    const subject = fixture();
    const res = response();
    await subject.routes.handle({
      request: request({ nonce: 'n'.repeat(43), providerProof }),
      response: res,
      path: FLEET_AUTH_ACCOUNT_REAPPROVAL_START_PATH,
      ...common,
    });
    expect(subject.startAuthentication).toHaveBeenCalledWith({
      nonce: 'n'.repeat(43),
      providerProof,
      ...common,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects browser-supplied restore authority fields before dispatch', async () => {
    const subject = fixture();
    await expect(subject.routes.handle({
      request: request({
        nonce: 'n'.repeat(43),
        providerProof,
        principalId: '55555555-5555-4555-8555-555555555555',
      }),
      response: response(),
      path: FLEET_AUTH_ACCOUNT_REAPPROVAL_START_PATH,
      ...common,
    })).rejects.toMatchObject({ code: 'invalid_account_reapproval_request', status: 400 });
    expect(subject.startAuthentication).not.toHaveBeenCalled();
  });

  it('finishes account reapproval and clears the globally fenced browser session', async () => {
    const subject = fixture();
    const res = response();
    await subject.routes.handle({
      request: request({ nonce: 'n'.repeat(43), providerProof, response: { id: 'credential' } }),
      response: res,
      path: FLEET_AUTH_ACCOUNT_REAPPROVAL_FINISH_PATH,
      ...common,
    });
    expect(subject.finishAuthentication).toHaveBeenCalledWith({
      nonce: 'n'.repeat(43),
      providerProof,
      response: { id: 'credential' },
      ...common,
    });
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(JSON.parse(res.body)).toMatchObject({ reauthenticationRequired: true });
  });
});
