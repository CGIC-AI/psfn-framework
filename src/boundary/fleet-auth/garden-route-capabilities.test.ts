import { describe, expect, it } from 'vitest';
import {
  compileGardenRouteDeclarations,
  GARDEN_CLIENT_ROUTES,
  GARDEN_ROUTE_CAPABILITIES,
  resolveGardenRouteCapability,
} from './garden-route-capabilities.js';
import { FLEET_AUTH_ROLES } from '../../system/config/fleet-auth-config.js';
import {
  FLEET_AUTH_ACTION_BASE_ROLE,
  FLEET_AUTH_DEFAULT_ROLE_ACTION_POLICY,
  fleetAuthRoleAllowsAction,
} from './role-action-policy.js';

describe('Garden route capability catalogue', () => {
  it('has one exact declaration per method and canonical pattern', () => {
    const ids = GARDEN_ROUTE_CAPABILITIES.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const capability of GARDEN_ROUTE_CAPABILITIES) {
      expect(capability.id).toBe(`${capability.method} ${capability.pattern}`);
      expect(capability.authorization.action).toBeTruthy();
      expect(capability.authorization.resource.scope).toBeTruthy();
      expect(capability.authorization.resource.area).toBeTruthy();
      expect(capability.authorization.requirements.assurance).toBeTruthy();
      expect(capability.authorization.publicAccess).toBeTruthy();
      expect(capability.authorization.recoveryAccess).toBeTruthy();
      expect(capability.authorization.baseRole)
        .toBe(FLEET_AUTH_ACTION_BASE_ROLE[capability.authorization.action]);
      expect(capability.body.maxBytes).toBeGreaterThanOrEqual(0);
      for (const role of FLEET_AUTH_ROLES) {
        expect(
          fleetAuthRoleAllowsAction(role, capability.authorization.action),
          `${capability.id} ${role}`,
        ).toBe(FLEET_AUTH_DEFAULT_ROLE_ACTION_POLICY[role]
          .includes(capability.authorization.action));
      }
    }
  });

  it('keeps public, recovery, sensitive, and conjunctive policy classifications exact', () => {
    expect(resolveGardenRouteCapability('GET', '/health')?.capability.authorization)
      .toMatchObject({ baseRole: null, publicAccess: 'always', recoveryAccess: 'forbidden' });
    expect(resolveGardenRouteCapability('POST', '/login')?.capability.authorization)
      .toMatchObject({ baseRole: null, publicAccess: 'feature_off_only' });
    expect(resolveGardenRouteCapability('GET', '/')?.capability.authorization)
      .toMatchObject({ action: 'companion.read', baseRole: 'guest', publicAccess: 'never' });
    expect(resolveGardenRouteCapability('GET', '/session-recovery')?.capability.authorization)
      .toMatchObject({
        action: 'recovery.begin',
        baseRole: null,
        publicAccess: 'never',
        recoveryAccess: 'trusted_host_exact_scope',
      });
    expect(resolveGardenRouteCapability('PATCH', '/api/admin/settings')?.capability.authorization)
      .toMatchObject({ action: 'settings.write', baseRole: 'admin' });
    expect(resolveGardenRouteCapability('POST', '/api/admin/contacts/contact-a/merge')?.capability.authorization)
      .toMatchObject({
        action: 'contacts.manage',
        baseRole: 'admin',
        requirements: {
          assurance: 'webauthn_uv',
          confirmation: 'explicit',
          approvals: ['contact_approval'],
        },
      });
    expect(
      resolveGardenRouteCapability(
        'POST',
        '/api/admin/shared-workspace/reviews/review-a/decision',
      )?.capability.authorization,
    ).toMatchObject({
      action: 'shared_workspace.manage',
      baseRole: 'admin',
      requirements: {
        assurance: 'webauthn_uv',
        confirmation: 'explicit',
        approvals: ['cogsec', 'independent_reviewer'],
      },
    });
    expect(resolveGardenRouteCapability('WS', '/api/admin/events')?.capability.authorization)
      .toMatchObject({ action: 'telemetry.read', baseRole: 'admin' });
    expect(resolveGardenRouteCapability(
      'POST',
      '/api/admin/privacy-break-glass/memory/memory-a/confirm',
    )?.capability).toMatchObject({
      body: { mode: 'required' },
      authorization: {
        action: 'privacy.break_glass',
        baseRole: 'admin',
        subjectRelation: 'none',
        requirements: { assurance: 'privacy_break_glass', confirmation: 'explicit' },
      },
    });
    expect(resolveGardenRouteCapability(
      'POST',
      '/api/admin/privacy-break-glass/memory/memory-a/decide',
    )?.capability.authorization).toMatchObject({
      action: 'privacy.break_glass',
      requirements: { assurance: 'oauth', confirmation: 'explicit' },
    });
  });

  it('fails construction for an active route without an exact catalogue declaration', () => {
    expect(() => compileGardenRouteDeclarations([{
      method: 'GET',
      match: { capabilityPattern: '/api/admin/unclassified' },
    }])).toThrow(/absent from capability catalogue/u);
  });

  it('declares every public Garden UI route for GET and HEAD', () => {
    for (const path of GARDEN_CLIENT_ROUTES) {
      expect(resolveGardenRouteCapability('GET', path)?.capability.id).toBe(`GET ${path}`);
      expect(resolveGardenRouteCapability('HEAD', path)?.capability.id).toBe(`HEAD ${path}`);
    }
    expect(resolveGardenRouteCapability('WS', '/api/admin/events')?.capability.id)
      .toBe('WS /api/admin/events');
  });

  it('matches sensitive dynamic routes without identifier substitution', () => {
    const resolved = resolveGardenRouteCapability(
      'GET',
      '/api/admin/sessions/channel-a/turns/turn-b',
    );
    expect(resolved?.capability.id).toBe(
      'GET /api/admin/sessions/:channelId/turns/:turnId',
    );
    expect(resolved?.pathParams).toEqual({ channelId: 'channel-a', turnId: 'turn-b' });
    expect(resolveGardenRouteCapability('GET', '/api/admin/sessions/channel-a/turns'))
      .toBeNull();
  });

  it('scopes personal artifacts and governed shared material separately', () => {
    expect(resolveGardenRouteCapability('GET', '/api/admin/images/generated')?.capability.authorization.resource)
      .toEqual({ scope: 'personal_workspace', area: 'images' });
    expect(resolveGardenRouteCapability('GET', '/api/admin/sessions/channel-a')?.capability.authorization.resource)
      .toEqual({ scope: 'personal_workspace', area: 'sessions' });
    expect(resolveGardenRouteCapability('GET', '/api/admin/wiki/document-a')?.capability.authorization.resource)
      .toEqual({ scope: 'personal_workspace', area: 'wiki' });
    expect(resolveGardenRouteCapability('GET', '/api/admin/shared-workspace/artifact')?.capability.authorization.resource)
      .toEqual({ scope: 'governed_shared_workspace', area: 'shared_workspace' });
    expect(resolveGardenRouteCapability('GET', '/api/admin/wiki/shared-world/site-a')?.capability.authorization.resource)
      .toEqual({ scope: 'governed_shared_workspace', area: 'wiki' });
  });
});
