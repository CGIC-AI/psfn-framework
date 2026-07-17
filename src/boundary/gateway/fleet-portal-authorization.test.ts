import { describe, expect, it, vi } from 'vitest';
import { FleetAuthorizationDeniedError } from './fleet-authorization-context.js';
import { GatewayFleetPortalAuthorizationBatchResolver } from './fleet-portal-authorization.js';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';
const SESSION_TOKEN = 'S'.repeat(43);

describe('gateway fleet portal batch authorization resolver', () => {
  it('accepts one opaque session input and returns a bounded immutable safe projection', async () => {
    const resolveBatch = vi.fn(async () => ({
      decision: 'allow' as const,
      companions: [
        { companionId: COMPANION_B, gardenLinkEligible: false },
        { companionId: COMPANION_A, gardenLinkEligible: true },
      ],
    }));
    const resolver = new GatewayFleetPortalAuthorizationBatchResolver(
      { resolveBatch },
      [COMPANION_A, COMPANION_B],
    );

    const result = await resolver.resolve({ sessionToken: SESSION_TOKEN });
    expect(resolveBatch).toHaveBeenCalledOnce();
    expect(result).toEqual({
      companions: [
        { companionId: COMPANION_A, gardenLinkEligible: true },
        { companionId: COMPANION_B, gardenLinkEligible: false },
      ],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.companions)).toBe(true);
    expect(Object.isFrozen(result.companions[0])).toBe(true);
  });

  it('rejects caller-selected companions and malformed session tokens before persistence', async () => {
    const resolveBatch = vi.fn();
    const resolver = new GatewayFleetPortalAuthorizationBatchResolver(
      { resolveBatch },
      [COMPANION_A],
    );
    for (const input of [
      {},
      { sessionToken: 'short' },
      { sessionToken: SESSION_TOKEN, companionId: COMPANION_A },
      { sessionToken: SESSION_TOKEN, action: 'companion.read' },
    ]) {
      await expect(resolver.resolve(input)).rejects.toMatchObject({ code: 'malformed_request' });
    }
    expect(resolveBatch).not.toHaveBeenCalled();
  });

  it('normalizes all authentication denials without returning companion data', async () => {
    const resolver = new GatewayFleetPortalAuthorizationBatchResolver({
      resolveBatch: async () => ({ decision: 'deny', reasonCode: 'session_authz_stale' }),
    }, [COMPANION_A]);
    await expect(resolver.resolve({ sessionToken: SESSION_TOKEN })).rejects.toEqual(
      expect.objectContaining<FleetAuthorizationDeniedError>({ code: 'session_authz_stale' }),
    );
  });

  it('fails closed on unknown, duplicate, or oversized store results', async () => {
    const results = [
      [{ companionId: COMPANION_B, gardenLinkEligible: true }],
      [
        { companionId: COMPANION_A, gardenLinkEligible: true },
        { companionId: COMPANION_A, gardenLinkEligible: true },
      ],
      [{ companionId: COMPANION_A, gardenLinkEligible: 'yes' }],
    ];
    for (const companions of results) {
      const resolver = new GatewayFleetPortalAuthorizationBatchResolver({
        resolveBatch: async () => ({ decision: 'allow', companions } as never),
      }, [COMPANION_A]);
      await expect(resolver.resolve({ sessionToken: SESSION_TOKEN }))
        .rejects.toThrow(/invalid|duplicate|unknown/i);
    }
  });
});
