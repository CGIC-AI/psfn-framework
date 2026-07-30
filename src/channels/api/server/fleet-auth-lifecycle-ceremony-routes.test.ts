import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { FleetAuthBrokerError } from '../../../boundary/gateway/fleet-auth-broker.js';
import {
  FLEET_AUTH_PROVIDER_COMPLETE_PATH,
  FLEET_AUTH_ROLE_COMPLETE_PATH,
} from '../../../boundary/fleet-auth/lifecycle-ceremony.js';
import { FleetAuthLifecycleCeremonyHttpRoutes } from './fleet-auth-lifecycle-ceremony-routes.js';

const COMPANION_ID = '00000000-0000-4000-8000-000000000401';
const PRINCIPAL_ID = '00000000-0000-4000-8000-000000000402';

function request(body: unknown): IncomingMessage {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage;
}

function response(): ServerResponse & { body: string; statusCode: number; writableEnded: boolean } {
  const state = { body: '', statusCode: 200, writableEnded: false };
  return Object.assign(state, {
    setHeader: vi.fn(),
    writeHead(statusCode: number) {
      state.statusCode = statusCode;
      return this;
    },
    end(body?: string) {
      state.body = body ?? '';
      state.writableEnded = true;
    },
  }) as unknown as ServerResponse & typeof state;
}

function roleRequest() {
  return {
    action: 'role.grant',
    ceremonyId: '00000000-0000-4000-8000-000000000403',
    companionId: COMPANION_ID,
    targetPrincipalId: PRINCIPAL_ID,
    grantId: '00000000-0000-4000-8000-000000000404',
    role: 'member',
    reason: 'ordinary access grant',
  };
}

describe('fleet-auth lifecycle ceremony HTTP routes', () => {
  it('rejects undeclared envelope fields on a completion route', async () => {
    const complete = vi.fn();
    const routes = new FleetAuthLifecycleCeremonyHttpRoutes({ complete });
    await expect(routes.handle({
      request: request({ request: roleRequest(), jitGrantId: '00000000-0000-4000-8000-000000000405' }),
      response: response(),
      path: FLEET_AUTH_ROLE_COMPLETE_PATH,
      token: 'session-token',
      csrfToken: 'csrf-token',
      requestOrigin: 'https://fleet.example.test',
    })).rejects.toBeInstanceOf(FleetAuthBrokerError);
    expect(complete).not.toHaveBeenCalled();
  });

  it('rejects a role request presented to the provider completion route', async () => {
    const routes = new FleetAuthLifecycleCeremonyHttpRoutes({ complete: vi.fn() });
    await expect(routes.handle({
      request: request({ request: roleRequest() }),
      response: response(),
      path: FLEET_AUTH_PROVIDER_COMPLETE_PATH,
      token: 'session-token',
      csrfToken: 'csrf-token',
      requestOrigin: 'https://fleet.example.test',
    })).rejects.toBeInstanceOf(FleetAuthBrokerError);
  });

  it('returns a redacted completion without internal target authority identifiers', async () => {
    const complete = vi.fn(async () => ({
      decisionId: '00000000-0000-4000-8000-000000000406',
      action: 'role.grant' as const,
      authorityGeneration: 9,
      globalAuthEpoch: 10,
      target: {
        principalId: PRINCIPAL_ID,
        authnVersion: 1,
        authzVersion: 1,
        bindingVersion: 1,
        grantVersion: 1,
        policyVersion: 1,
      },
    }));
    const routes = new FleetAuthLifecycleCeremonyHttpRoutes({ complete });
    const res = response();
    await routes.handle({
      request: request({ request: roleRequest() }),
      response: res,
      path: FLEET_AUTH_ROLE_COMPLETE_PATH,
      token: 'session-token',
      csrfToken: 'csrf-token',
      requestOrigin: 'https://fleet.example.test',
    });
    expect(JSON.parse(res.body)).toEqual({
      decisionId: '00000000-0000-4000-8000-000000000406',
      action: 'role.grant',
      authorityGeneration: 9,
      globalAuthEpoch: 10,
      reauthenticationRequired: true,
    });
    expect(res.body).not.toContain(PRINCIPAL_ID);
  });
});
