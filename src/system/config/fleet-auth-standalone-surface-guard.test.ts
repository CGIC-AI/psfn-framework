import { describe, expect, it, vi } from 'vitest';
import {
  assertFleetAuthStandaloneSurfacesUnavailable,
  warnIfInsecureLocalApiUnderFleetAuth,
} from './fleet-auth-standalone-surface-guard.js';

describe('fleet auth standalone surface startup guard', () => {
  // Operator rule (S13): fleet auth ADDS SSO and never removes key/token
  // authentication. Every key/token surface below must start under fleet auth.
  it.each([
    ['gateway-admin Garden ADMIN_TOKEN', 'gateway' as const, {
      ADMIN_PORT: '8790',
      ADMIN_TOKEN: 'standalone-admin-token',
    }],
    ['operator Garden ADMIN_TOKEN', 'operator' as const, {
      ADMIN_PORT: '8790',
      ADMIN_TOKEN: 'standalone-admin-token',
    }],
    ['operator Garden ADMIN_ALLOW_INSECURE', 'operator' as const, {
      ADMIN_PORT: '8790',
      ADMIN_ALLOW_INSECURE: 'true',
    }],
    ['gateway API_KEY with fleet SSO routes', 'gateway' as const, {
      API_PORT: '8787',
      API_KEY: 'machine-api-key',
    }],
  ])('keeps %s available under fleet auth', (_label, processMode, env) => {
    expect(() => assertFleetAuthStandaloneSurfacesUnavailable({
      fleetAuthEnabled: true,
      processMode,
      env,
      fleetAuthBootstrapRoutesWired: processMode === 'gateway',
    })).not.toThrow();
  });

  it('never fails boot when key auth is the only wired principal source', () => {
    expect(() => assertFleetAuthStandaloneSurfacesUnavailable({
      fleetAuthEnabled: true,
      processMode: 'gateway',
      env: { API_PORT: '8787', API_KEY: 'machine-api-key', ADMIN_TOKEN: 'admin' },
      fleetAuthBootstrapRoutesWired: true,
      principalAuthenticationWired: false,
    })).not.toThrow();
    expect(() => assertFleetAuthStandaloneSurfacesUnavailable({
      fleetAuthEnabled: true,
      processMode: 'operator',
      env: { ADMIN_PORT: '8790', ADMIN_TOKEN: 'admin' },
      principalAuthenticationWired: false,
    })).not.toThrow();
  });

  it('preserves feature-off startup and does not mutate standalone credentials', () => {
    const env = {
      API_PORT: '8787',
      ADMIN_PORT: '8790',
      ADMIN_TOKEN: 'standalone-admin-token',
    };
    const before = { ...env };
    expect(() => assertFleetAuthStandaloneSurfacesUnavailable({
      fleetAuthEnabled: false,
      processMode: 'gateway',
      env,
    })).not.toThrow();
    expect(env).toEqual(before);
  });

  it('only rejects a gateway API port whose configured fleet auth has no SSO routes wired', () => {
    expect(() => assertFleetAuthStandaloneSurfacesUnavailable({
      fleetAuthEnabled: true,
      processMode: 'gateway',
      env: { API_PORT: '8787', API_KEY: 'machine-api-key' },
    })).toThrow(/SSO bootstrap routes are not wired/i);

    expect(() => assertFleetAuthStandaloneSurfacesUnavailable({
      fleetAuthEnabled: true,
      processMode: 'gateway',
      env: { API_PORT: '8787' },
      principalAuthenticationWired: true,
    })).not.toThrow();

    // No API port exposed: nothing to check.
    expect(() => assertFleetAuthStandaloneSurfacesUnavailable({
      fleetAuthEnabled: true,
      processMode: 'gateway',
      env: { ADMIN_PORT: '8790', ADMIN_TOKEN: 'standalone-admin-token' },
    })).not.toThrow();
  });
});

describe('warnIfInsecureLocalApiUnderFleetAuth', () => {
  it('warns that the bypass stays in effect when fleet auth is active and ALLOW_INSECURE_LOCAL_API=true is set', () => {
    const logger = { warn: vi.fn() };
    const fired = warnIfInsecureLocalApiUnderFleetAuth({
      fleetAuthEnabled: true,
      env: { ALLOW_INSECURE_LOCAL_API: 'TRUE' },
      logger,
    });
    expect(fired).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toContain('ALLOW_INSECURE_LOCAL_API=true is set while fleet auth');
    expect(logger.warn.mock.calls[0]?.[0]).toContain('REMAINS IN EFFECT');
    expect(logger.warn.mock.calls[0]?.[0]).toContain('fleet auth');
  });

  it('stays silent when fleet auth is active but the insecure flag is unset', () => {
    const logger = { warn: vi.fn() };
    const fired = warnIfInsecureLocalApiUnderFleetAuth({
      fleetAuthEnabled: true,
      env: {},
      logger,
    });
    expect(fired).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stays silent when fleet auth is disabled even if the insecure flag is set', () => {
    const logger = { warn: vi.fn() };
    const fired = warnIfInsecureLocalApiUnderFleetAuth({
      fleetAuthEnabled: false,
      env: { ALLOW_INSECURE_LOCAL_API: 'true' },
      logger,
    });
    expect(fired).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
