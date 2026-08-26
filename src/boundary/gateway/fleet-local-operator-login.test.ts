import type { IncomingHttpHeaders } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { FleetAuthConfig } from '../../system/config/fleet-auth-config.js';
import {
  readFleetBrowserSession,
  resolveFleetLocalOperatorLoginConfig,
  validateFleetLocalOperatorOrigins,
} from './fleet-local-operator-login.js';

const ownerConfig = {
  discordEvidenceMappings: [],
  accountRoster: [{
    providerSubjectId: '123456789012345679',
    companionId: '00000000-0000-4000-8000-000000000201',
    contactId: '00000000-0000-4000-8000-000000000211',
    role: 'owner',
  }],
} as unknown as FleetAuthConfig;

function request(headers: IncomingHttpHeaders) {
  return { headers };
}

describe('fleet local operator login boundary', () => {
  it('requires explicit trusted-proxy enablement, an admin token, and a unique rostered owner', () => {
    expect(resolveFleetLocalOperatorLoginConfig({
      enabled: false,
      trustProxy: false,
      fleetAuth: ownerConfig,
    })).toBeUndefined();
    expect(() => resolveFleetLocalOperatorLoginConfig({
      enabled: true,
      trustProxy: false,
      adminToken: 'local-admin-token-at-least-32-bytes',
      rawAllowedOrigins: 'http://127.0.0.1:10053',
      fleetAuth: ownerConfig,
    })).toThrow(/trusted gateway ingress/u);
    expect(() => resolveFleetLocalOperatorLoginConfig({
      enabled: true,
      trustProxy: true,
      adminToken: '',
      rawAllowedOrigins: 'http://127.0.0.1:10053',
      fleetAuth: ownerConfig,
    })).toThrow(/ADMIN_TOKEN/u);

    expect(resolveFleetLocalOperatorLoginConfig({
      enabled: true,
      trustProxy: true,
      adminToken: 'local-admin-token-at-least-32-bytes',
      rawAllowedOrigins: 'http://127.0.0.1:10053, http://localhost:10053',
      fleetAuth: ownerConfig,
    })).toEqual({
      adminToken: 'local-admin-token-at-least-32-bytes',
      allowedOrigins: ['http://127.0.0.1:10053', 'http://localhost:10053'],
    });
  });

  it('accepts only unique exact HTTP loopback origins with explicit ports', () => {
    expect(validateFleetLocalOperatorOrigins([
      'http://127.0.0.1:10053',
      'http://localhost:10053',
    ])).toEqual(['http://127.0.0.1:10053', 'http://localhost:10053']);
    for (const origins of [
      [] as string[],
      ['https://127.0.0.1:10053'],
      ['http://127.0.0.1'],
      ['http://127.0.0.1:10053/path'],
      ['http://192.0.2.1:10053'],
      ['http://localhost:10053', 'http://localhost:10053'],
    ]) {
      expect(() => validateFleetLocalOperatorOrigins(origins)).toThrow();
    }
  });

  it('keeps canonical and local cookies separate and rejects ambiguity', () => {
    expect(readFleetBrowserSession(request({
      cookie: `psfn_local_operator_session=${'l'.repeat(43)}`,
    }), true)).toEqual({ token: 'l'.repeat(43), kind: 'local_operator' });
    expect(readFleetBrowserSession(request({
      cookie: `__Host-psfn_session=${'c'.repeat(43)}`,
    }), true)).toEqual({ token: 'c'.repeat(43), kind: 'canonical' });
    expect(readFleetBrowserSession(request({
      cookie: `__Host-psfn_session=${'c'.repeat(43)}; psfn_local_operator_session=${'l'.repeat(43)}`,
    }), true)).toBeUndefined();
    expect(readFleetBrowserSession(request({
      cookie: `psfn_local_operator_session=${'l'.repeat(43)}`,
    }), false)).toBeUndefined();
  });
});
