import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { TrustedHostProviderRecoveryService } from '../../../boundary/fleet-auth/trusted-host-provider-recovery.js';
import {
  FLEET_AUTH_PROVIDER_RECOVERY_FINISH_PATH,
  FLEET_AUTH_PROVIDER_RECOVERY_START_PATH,
  FleetAuthProviderRecoveryHttpRoutes,
} from './fleet-auth-provider-recovery-routes.js';

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

function fixture() {
  const start = vi.fn(async () => ({
    ceremonyId: '11111111-1111-4111-8111-111111111111',
    publicKey: { challenge: 'opaque' },
  }));
  const finish = vi.fn(async () => ({
    decisionId: '22222222-2222-4222-8222-222222222222',
    authorityGeneration: 2,
    globalAuthEpoch: 2,
  }));
  const recovery: Pick<TrustedHostProviderRecoveryService, 'start' | 'finish'> = {
    start,
    finish,
  };
  return { routes: new FleetAuthProviderRecoveryHttpRoutes(recovery), start, finish };
}

const proof = {
  provider: 'discord',
  subjectId: '223456789012345678',
  callbackTransactionId: '33333333-3333-4333-8333-333333333333',
  proofDigest: 'a'.repeat(64),
};
const common = {
  token: 'session-token',
  csrfToken: 'csrf-token',
  requestOrigin: 'https://fleet.example.test',
};

describe('FleetAuthProviderRecoveryHttpRoutes', () => {
  it('forwards only the exact one-time/OAuth/confirmation scope', async () => {
    const value = fixture();
    const res = response();
    const body = {
      oneTimeCredential: 'c'.repeat(43),
      confirmation: 'provider.recover',
      reason: 'current subject is unavailable',
      newProvider: proof,
    };
    await value.routes.handle({
      request: request(body),
      response: res,
      path: FLEET_AUTH_PROVIDER_RECOVERY_START_PATH,
      ...common,
    });
    expect(value.start).toHaveBeenCalledWith({ ...body, ...common });
    expect(res.headers.get('cache-control')).toBe('no-store');

    await expect(value.routes.handle({
      request: request({ ...body, ADMIN_TOKEN: 'legacy' }),
      response: response(),
      path: FLEET_AUTH_PROVIDER_RECOVERY_START_PATH,
      ...common,
    })).rejects.toMatchObject({ code: 'invalid_provider_recovery_request', status: 400 });
  });

  it('clears the old-provider session only after recovery commits', async () => {
    const value = fixture();
    const res = response();
    await value.routes.handle({
      request: request({
        oneTimeCredential: 'c'.repeat(43),
        confirmation: 'provider.recover',
        reason: 'current subject is unavailable',
        newProvider: proof,
        response: { id: 'assertion' },
      }),
      response: res,
      path: FLEET_AUTH_PROVIDER_RECOVERY_FINISH_PATH,
      ...common,
    });
    expect(value.finish).toHaveBeenCalledWith(expect.objectContaining({
      response: { id: 'assertion' },
      ...common,
    }));
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(JSON.parse(res.body)).toMatchObject({ reauthenticationRequired: true });
  });
});
