import { describe, expect, it } from 'vitest';
import {
  CompanionScopedGardenRouteError,
  FLEET_SSO_FLEET_MANIFEST_REQUIRED_ERROR,
  parseCompanionScopedGardenRoute,
  parseFleetSsoOuterTarget,
  resolveFleetSsoGardenUpstreams,
} from './fleet-sso-transport.js';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const ONE_COMPANION_FLEET = {
  persistenceRoot: '/runtime',
  workspacesRoot: '/runtime/workspaces',
  sharedWorkspacePath: '/runtime/shared',
  companions: [{
    companionId: COMPANION_A,
    companionDataDir: '/runtime/companions/one',
    characterCardPath: '/runtime/companions/one/character-card.json',
    personalWorkspacePath: '/runtime/workspaces/one',
    postgresSchema: 'companion_one',
  }],
} as const;

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

  it('preserves canonical encoded separators in query values without weakening path checks', () => {
    const target = `/companions/${COMPANION_A}/garden/api/admin/model-usage`
      + '?range=month&timezone=America%2FNew_York';

    expect(parseFleetSsoOuterTarget(target)).toEqual({
      rawPath: `/companions/${COMPANION_A}/garden/api/admin/model-usage`,
      rawQuery: 'range=month&timezone=America%2FNew_York',
    });
    expect(parseCompanionScopedGardenRoute(target)).toMatchObject({
      innerTarget: '/api/admin/model-usage?range=month&timezone=America%2FNew_York',
    });
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

describe('Fleet SSO Garden upstream resolution', () => {
  it('boots the fleet SSO transport from a one-entry companions.json manifest', () => {
    expect(resolveFleetSsoGardenUpstreams({
      fleet: ONE_COMPANION_FLEET,
      fleetGardenPort: 3001,
      env: {},
    })).toMatchObject([{
      companionId: COMPANION_A,
      origin: new URL('http://127.0.0.1:3001'),
      companionScopedTarget: true,
    }]);
  });

  it('fails closed with an actionable error when companions.json is absent', () => {
    let thrown: unknown;
    try {
      resolveFleetSsoGardenUpstreams({
        fleetGardenPort: 3001,
        env: {},
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(FLEET_SSO_FLEET_MANIFEST_REQUIRED_ERROR);
  });
});
