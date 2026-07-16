import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { TrustedHostPasskeyCeremonyService } from '../../../boundary/fleet-auth/trusted-host-passkey-ceremony.js';
import type { GatewayFleetAuthBroker } from '../../../boundary/gateway/fleet-auth-broker.js';
import {
  FLEET_AUTH_FIRST_OWNER_COMPLETE_PATH,
  FLEET_AUTH_PASSKEY_FINISH_PATH,
  FLEET_AUTH_PASSKEY_START_PATH,
  FleetAuthPasskeyHttpRoutes,
} from './fleet-auth-passkey-routes.js';

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
  const startRegistration = vi.fn(async () => ({
    ceremonyId: '11111111-1111-4111-8111-111111111111',
    kind: 'passkey_enrollment' as const,
    publicKey: { challenge: 'opaque' },
  }));
  const finishRegistration = vi.fn(async () => ({
    credentialIdHash: 'a'.repeat(64),
    credentialFloorGeneration: 2,
  }));
  const completeFirstOwnerBootstrap = vi.fn(async () => ({
    token: 'rotated-session',
    csrfToken: 'rotated-csrf',
    principalId: '22222222-2222-4222-8222-222222222222',
    principalStatus: 'active' as const,
    idleExpiresAt: new Date(Date.now() + 60_000),
    absoluteExpiresAt: new Date(Date.now() + 120_000),
  }));
  const ceremonies: Pick<TrustedHostPasskeyCeremonyService,
    'startRegistration' | 'finishRegistration'> = {
      startRegistration,
      finishRegistration,
    };
  const broker: Pick<GatewayFleetAuthBroker, 'completeFirstOwnerBootstrap'> = {
    completeFirstOwnerBootstrap,
  };
  return {
    routes: new FleetAuthPasskeyHttpRoutes({ ceremonies, broker }),
    startRegistration,
    finishRegistration,
    completeFirstOwnerBootstrap,
  };
}

const common = {
  token: 'session-token',
  csrfToken: 'csrf-token',
  requestOrigin: 'https://fleet.example.test',
};

describe('FleetAuthPasskeyHttpRoutes', () => {
  it('starts only an exact trusted-host ceremony and forwards session authority', async () => {
    const subject = fixture();
    const res = response();
    await subject.routes.handle({
      request: request({ nonce: 'n'.repeat(43), kind: 'passkey_enrollment' }),
      response: res,
      path: FLEET_AUTH_PASSKEY_START_PATH,
      ...common,
    });
    expect(subject.startRegistration).toHaveBeenCalledWith({
      nonce: 'n'.repeat(43),
      kind: 'passkey_enrollment',
      ...common,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects browser-supplied authority fields before ceremony dispatch', async () => {
    const subject = fixture();
    await expect(subject.routes.handle({
      request: request({
        nonce: 'n'.repeat(43),
        kind: 'passkey_enrollment',
        expectedProviderSubjectId: '12345678901234567',
      }),
      response: response(),
      path: FLEET_AUTH_PASSKEY_START_PATH,
      ...common,
    })).rejects.toMatchObject({ code: 'invalid_passkey_ceremony_request', status: 400 });
    expect(subject.startRegistration).not.toHaveBeenCalled();
  });

  it('finishes enrollment and clears the now-revoked session cookie', async () => {
    const subject = fixture();
    const res = response();
    await subject.routes.handle({
      request: request({
        nonce: 'n'.repeat(43),
        kind: 'passkey_enrollment',
        response: { id: 'credential' },
      }),
      response: res,
      path: FLEET_AUTH_PASSKEY_FINISH_PATH,
      ...common,
    });
    expect(subject.finishRegistration).toHaveBeenCalledWith({
      nonce: 'n'.repeat(43),
      kind: 'passkey_enrollment',
      response: { id: 'credential' },
      ...common,
    });
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(JSON.parse(res.body)).toMatchObject({ reauthenticationRequired: true });
  });

  it('completes first-owner bootstrap and installs only the rotated session', async () => {
    const subject = fixture();
    const res = response();
    await subject.routes.handle({
      request: request({ nonce: 'n'.repeat(43), response: { id: 'credential' } }),
      response: res,
      path: FLEET_AUTH_FIRST_OWNER_COMPLETE_PATH,
      ...common,
    });
    expect(subject.completeFirstOwnerBootstrap).toHaveBeenCalledWith({
      token: common.token,
      csrfToken: common.csrfToken,
      requestOrigin: common.requestOrigin,
      assuranceEvidence: {
        nonce: 'n'.repeat(43),
        response: { id: 'credential' },
      },
    });
    expect(res.headers.get('set-cookie')).toContain('rotated-session');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
