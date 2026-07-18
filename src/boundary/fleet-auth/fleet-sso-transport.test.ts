import { describe, expect, it } from 'vitest';
import {
  CompanionScopedGardenRouteError,
  parseCompanionScopedGardenRoute,
  parseFleetSsoOuterTarget,
} from './fleet-sso-transport.js';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';

describe('companion-scoped Garden route parsing', () => {
  it('binds one immutable server-derived companion from the canonical route', () => {
    const route = parseCompanionScopedGardenRoute(
      `/companions/${COMPANION_A}/garden/api/admin/dashboard?limit=5`,
    );
    expect(route).toEqual({
      companionId: COMPANION_A,
      innerTarget: '/api/admin/dashboard?limit=5',
      publicPrefix: `/companions/${COMPANION_A}/garden`,
    });
    expect(Object.isFrozen(route)).toBe(true);
  });

  it('maps the bare garden marker to the inner root target', () => {
    expect(parseCompanionScopedGardenRoute(`/companions/${COMPANION_A}/garden`))
      .toMatchObject({ innerTarget: '/' });
  });

  it('returns undefined for targets outside the companion prefix', () => {
    expect(parseCompanionScopedGardenRoute('/fleet')).toBeUndefined();
    expect(parseCompanionScopedGardenRoute('/v1/fleet-auth/session')).toBeUndefined();
  });

  it('fails closed on malformed companion selections without revealing existence', () => {
    for (const rawTarget of [
      '/companions/', // empty selection
      `/companions/${COMPANION_A}`, // no garden marker
      `/companions/${COMPANION_A}/gardenx`, // marker alias
      '/companions/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA/garden', // case alias
      '/companions/not-a-uuid/garden',
      '/companions/../garden',
    ]) {
      expect(() => parseCompanionScopedGardenRoute(rawTarget))
        .toThrowError(CompanionScopedGardenRouteError);
    }
  });

  it('rejects protocol-level target aliases before any companion selection', () => {
    for (const rawTarget of [
      `//companions/${COMPANION_A}/garden`,
      `/companions/${COMPANION_A}/garden/../secrets`,
      `/companions/${COMPANION_A}/garden/a//b`,
      `/companions/${COMPANION_A}/garden/a%2Fb`,
      `/companions/${COMPANION_A}/garden#fragment`,
      `/companions/${COMPANION_A}/garden\\alias`,
      `/companions/${COMPANION_A}/garden?a=1?b=2`,
      'companions/relative',
    ]) {
      expect(() => parseFleetSsoOuterTarget(rawTarget))
        .toThrowError(CompanionScopedGardenRouteError);
    }
  });
});
