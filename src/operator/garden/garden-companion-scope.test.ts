import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  assertGardenRequestCompanionScope,
  gardenRequestCompanionScopeDenial,
  GardenCompanionScopeError,
} from './garden-companion-scope.js';
import {
  createLegacyGardenRequestContext,
  type FleetGardenRequestContext,
  type GardenRequestContext,
  type PublicGardenRequestContext,
} from './garden-request-context.js';
import { dispatchAdminRoute, type AdminRoute } from './server-routes.js';
import type { GardenRouteAuthorization } from '../../boundary/fleet-auth/garden-route-authorization.js';

const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';

const AUTHORIZATION: GardenRouteAuthorization = Object.freeze({
  action: 'dashboard.read',
  baseRole: 'member',
  resource: Object.freeze({ scope: 'personal_workspace', area: 'dashboard' }),
  subjectRelation: 'operator_scope',
  requirements: Object.freeze({
    assurance: 'oauth',
    confirmation: 'none',
    approvals: Object.freeze([]),
  }),
  publicAccess: 'never',
  recoveryAccess: 'forbidden',
}) as unknown as GardenRouteAuthorization;

function fleetContext(companionId: string | null): FleetGardenRequestContext {
  return Object.freeze({
    kind: 'fleet_principal',
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    decisionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    authorizationEventId: 'event-a',
    resolvedAt: '2030-01-01T00:00:00.000Z',
    versions: Object.freeze({
      authorityGeneration: 1,
      globalAuthEpoch: 1,
      sessionAuthnVersion: 1,
      sessionAuthzVersion: 1,
      bindingVersion: 1,
      grantVersion: 1,
      policyVersion: 1,
    }),
    issuedAt: 1,
    expiresAt: 2,
    actor: Object.freeze({
      kind: 'fleet_principal',
      principalId: 'principal-a',
      provider: 'discord',
      providerSubjectId: 'provider-a',
      contactId: 'contact-a',
      contactBindingId: 'binding-a',
      role: 'member',
      operatorGrantId: 'grant-a',
      sessionRecordId: 'session-a',
      sessionAssurance: 'oauth',
    }),
    action: 'dashboard.read',
    resource: Object.freeze({
      routeId: 'GET /api/admin/dashboard',
      scope: 'personal_workspace',
      area: 'dashboard',
      companionId,
      pathParams: Object.freeze({}),
      query: Object.freeze({}),
    }),
    subjectRelation: 'operator_scope',
    authorization: AUTHORIZATION,
  }) as unknown as FleetGardenRequestContext;
}

describe('gardenRequestCompanionScopeDenial (invariant 11)', () => {
  it('allows a fleet request whose companion matches the bound companion', () => {
    expect(gardenRequestCompanionScopeDenial(fleetContext(COMPANION_A), COMPANION_A)).toBeNull();
  });

  it('denies a fleet request for a different companion than the dispatch binding', () => {
    const denial = gardenRequestCompanionScopeDenial(fleetContext(COMPANION_B), COMPANION_A);
    expect(denial).toBe(
      'Fleet Garden request companion does not match the dispatch companion binding',
    );
  });

  it('fails closed when the fleet request carries no companion target', () => {
    expect(gardenRequestCompanionScopeDenial(fleetContext(null), COMPANION_A)).toBe(
      'Fleet Garden request carries no authenticated companion target',
    );
  });

  it('fails closed when the dispatch has no companion binding', () => {
    expect(gardenRequestCompanionScopeDenial(fleetContext(COMPANION_A), undefined)).toBe(
      'Fleet Garden dispatch has no companion binding to scope the request',
    );
    expect(gardenRequestCompanionScopeDenial(fleetContext(COMPANION_A), '')).toBe(
      'Fleet Garden dispatch has no companion binding to scope the request',
    );
  });

  it('exempts a legacy-token context (single-companion Garden behavior unchanged)', () => {
    const legacy: GardenRequestContext = createLegacyGardenRequestContext({
      authorization: AUTHORIZATION,
      routeId: 'GET /api/admin/dashboard',
      companionId: COMPANION_A,
      pathParams: {},
      query: {},
    });
    // Even a mismatched bound companion is irrelevant for legacy: no fleet target.
    expect(gardenRequestCompanionScopeDenial(legacy, COMPANION_B)).toBeNull();
    expect(gardenRequestCompanionScopeDenial(legacy, undefined)).toBeNull();
  });

  it('exempts a public context', () => {
    const publicContext = Object.freeze({
      kind: 'public',
      requestId: null,
      decisionId: null,
      versions: null,
      action: 'dashboard.read',
      resource: Object.freeze({
        routeId: 'GET /health',
        scope: 'public',
        area: 'public',
        companionId: null,
        pathParams: Object.freeze({}),
        query: Object.freeze({}),
      }),
      subjectRelation: 'operator_scope',
      authorization: AUTHORIZATION,
      actor: Object.freeze({ kind: 'public', actorId: 'public:anonymous' }),
    }) as unknown as PublicGardenRequestContext;
    expect(gardenRequestCompanionScopeDenial(publicContext, COMPANION_A)).toBeNull();
  });
});

describe('assertGardenRequestCompanionScope', () => {
  it('returns without throwing when the request companion is in scope', () => {
    expect(() =>
      assertGardenRequestCompanionScope(fleetContext(COMPANION_A), COMPANION_A),
    ).not.toThrow();
  });

  it('throws GardenCompanionScopeError on a cross-companion request', () => {
    expect(() =>
      assertGardenRequestCompanionScope(fleetContext(COMPANION_B), COMPANION_A),
    ).toThrow(GardenCompanionScopeError);
  });
});

class CapturingResponse {
  status = 0;
  headers: Record<string, string> = {};
  body = '';

  writeHead(status: number, headers?: Record<string, string>): this {
    this.status = status;
    this.headers = headers ?? {};
    return this;
  }

  end(body?: string): this {
    this.body = body ?? '';
    return this;
  }
}

function makeRequest(url: string): IncomingMessage {
  return { url, method: 'GET', headers: { host: 'localhost' } } as unknown as IncomingMessage;
}

describe('dispatchAdminRoute companion-scope enforcement (wiring)', () => {
  function routeWith(handle: () => void): AdminRoute[] {
    return [
      {
        method: 'GET',
        match: (path: string) => (path === '/api/admin/dashboard' ? {} : null),
        capability: { id: 'GET /api/admin/dashboard', authorization: AUTHORIZATION },
        handle,
      },
    ] as unknown as AdminRoute[];
  }

  it('denies a fleet request whose companion differs from the dispatch binding, without calling the handler', () => {
    const handle = vi.fn();
    const res = new CapturingResponse();
    const handled = dispatchAdminRoute(
      routeWith(handle),
      'GET',
      '/api/admin/dashboard',
      makeRequest('/api/admin/dashboard'),
      res as unknown as ServerResponse,
      fleetContext(COMPANION_B),
      COMPANION_A,
    );

    expect(handled).toBe(true);
    expect(res.status).toBe(403);
    expect(res.body).toContain('does not match the dispatch companion binding');
    expect(handle).not.toHaveBeenCalled();
  });

  it('runs the handler when the fleet request companion matches the dispatch binding', () => {
    const handle = vi.fn();
    const res = new CapturingResponse();
    const handled = dispatchAdminRoute(
      routeWith(handle),
      'GET',
      '/api/admin/dashboard',
      makeRequest('/api/admin/dashboard'),
      res as unknown as ServerResponse,
      fleetContext(COMPANION_A),
      COMPANION_A,
    );

    expect(handled).toBe(true);
    expect(handle).toHaveBeenCalledTimes(1);
  });
});
