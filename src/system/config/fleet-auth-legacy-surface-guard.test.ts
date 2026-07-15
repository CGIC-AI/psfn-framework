import { describe, expect, it } from 'vitest';
import { assertFleetAuthLegacySurfacesUnavailable } from './fleet-auth-legacy-surface-guard.js';

describe('fleet auth legacy surface startup guard', () => {
  it.each([
    ['gateway HTTP/API/WebSocket', 'gateway' as const, { API_PORT: '8787' }],
    ['gateway-admin Garden cookie/token', 'gateway' as const, {
      ADMIN_PORT: '8790',
      ADMIN_TOKEN: 'legacy-admin-token',
    }],
    ['operator Garden cookie/token', 'operator' as const, {
      ADMIN_PORT: '8790',
      ADMIN_TOKEN: 'legacy-admin-token',
    }],
  ])('rejects %s before a listener can start', (_label, processMode, env) => {
    expect(() => assertFleetAuthLegacySurfacesUnavailable({
      fleetAuthEnabled: true,
      processMode,
      env,
    })).toThrow(/fleet auth.*legacy.*before listen/i);
  });

  it('preserves feature-off startup and does not mutate legacy credentials', () => {
    const env = {
      API_PORT: '8787',
      ADMIN_PORT: '8790',
      ADMIN_TOKEN: 'legacy-admin-token',
    };
    const before = { ...env };
    expect(() => assertFleetAuthLegacySurfacesUnavailable({
      fleetAuthEnabled: false,
      processMode: 'gateway',
      env,
    })).not.toThrow();
    expect(env).toEqual(before);
  });

  it('permits the gateway API only after gateway-owned principal authentication is wired', () => {
    expect(() => assertFleetAuthLegacySurfacesUnavailable({
      fleetAuthEnabled: true,
      processMode: 'gateway',
      env: { API_PORT: '8787', API_KEY: 'machine-api-key' },
      principalAuthenticationWired: true,
    })).not.toThrow();

    expect(() => assertFleetAuthLegacySurfacesUnavailable({
      fleetAuthEnabled: true,
      processMode: 'gateway',
      env: { API_PORT: '8787', ADMIN_TOKEN: 'legacy-admin-token' },
      principalAuthenticationWired: true,
    })).toThrow(/legacy/i);
  });
});
