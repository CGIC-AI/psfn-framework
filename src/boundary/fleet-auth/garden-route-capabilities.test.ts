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
    expect(resolveGardenRouteCapability('GET', '/api/admin/automata')?.capability.authorization)
      .toMatchObject({
        action: 'automata.read',
        baseRole: 'admin',
        resource: { area: 'automata' },
      });
    expect(resolveGardenRouteCapability('GET', '/automata')?.capability.authorization)
      .toMatchObject({ action: 'automata.read', baseRole: 'admin' });
    expect(resolveGardenRouteCapability('GET', '/api/admin/scheduler')?.capability.authorization)
      .toMatchObject({ action: 'scheduler.read', baseRole: 'admin' });
    expect(resolveGardenRouteCapability(
      'POST',
      '/api/admin/icp-autonomy/test-initiations',
    )?.capability).toMatchObject({
      id: 'POST /api/admin/icp-autonomy/test-initiations',
      body: { mode: 'required' },
      authorization: {
        action: 'autonomy.manage',
        baseRole: 'admin',
        requirements: { assurance: 'oauth', confirmation: 'explicit' },
      },
    });
    expect(resolveGardenRouteCapability('POST', '/v1/chat/completions')?.capability)
      .toMatchObject({
        body: { mode: 'required', maxBytes: 1_048_576 },
        authorization: {
          action: 'companion.interact',
          baseRole: 'guest',
          resource: { scope: 'garden_surface', area: 'garden_ui' },
        },
      });
    expect(resolveGardenRouteCapability('POST', '/api/admin/contacts/contact-a/merge')?.capability.authorization)
      .toMatchObject({
        action: 'contacts.manage',
        baseRole: 'admin',
        requirements: {
          assurance: 'oauth',
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
        assurance: 'escalated',
        confirmation: 'explicit',
        approvals: ['cogsec', 'independent_reviewer'],
      },
    });
    expect(resolveGardenRouteCapability(
      'POST',
      '/api/admin/concerns/concern-a/resolve',
    )?.capability.authorization).toMatchObject({
      action: 'cogsec.manage',
      baseRole: 'admin',
      requirements: {
        assurance: 'escalated',
        confirmation: 'explicit',
        approvals: ['cogsec'],
      },
    });
    expect(resolveGardenRouteCapability('WS', '/api/admin/events')?.capability.authorization)
      .toMatchObject({ action: 'telemetry.read', baseRole: 'admin' });
    expect(resolveGardenRouteCapability(
      'GET',
      '/api/admin/wiki/shared-world-proposals',
    )?.capability).toMatchObject({
      query: {
        state: { cardinality: 'singleton', maxValues: 1 },
        limit: { cardinality: 'singleton', maxValues: 1 },
      },
      body: { mode: 'forbidden' },
      authorization: {
        action: 'wiki.read',
        resource: { scope: 'governed_shared_workspace' },
      },
    });
    expect(resolveGardenRouteCapability(
      'POST',
      '/api/admin/wiki/shared-world-proposals/proposal-a/approve',
    )?.capability).toMatchObject({
      body: { mode: 'optional' },
      authorization: {
        action: 'wiki.manage',
        resource: { scope: 'governed_shared_workspace' },
        requirements: {
          assurance: 'escalated',
          confirmation: 'explicit',
          approvals: ['cogsec'],
        },
      },
    });
    expect(resolveGardenRouteCapability(
      'POST',
      '/api/admin/wiki/shared-world-proposals/cleanup',
    )?.capability.body).toMatchObject({ mode: 'required' });
    expect(resolveGardenRouteCapability(
      'POST',
      '/api/admin/prompts/count-tokens',
    )?.capability).toMatchObject({
      body: { mode: 'required' },
      authorization: { action: 'prompts.read' },
    });
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
    expect(resolveGardenRouteCapability(
      'POST',
      '/api/admin/privacy-break-glass/journal/reflection-journal/confirm',
    )?.capability).toMatchObject({
      authorization: {
        action: 'privacy.break_glass',
        baseRole: 'admin',
        resource: { area: 'values' },
        requirements: { assurance: 'privacy_break_glass', confirmation: 'explicit' },
      },
    });
    expect(resolveGardenRouteCapability(
      'POST',
      '/api/admin/privacy-break-glass/journal/reflection-journal/decide',
    )?.capability.authorization).toMatchObject({
      action: 'privacy.break_glass',
      requirements: { assurance: 'oauth', confirmation: 'explicit' },
    });
    expect(resolveGardenRouteCapability(
      'GET',
      '/api/admin/shards/shard-a/configuration',
    )?.capability).toMatchObject({
      body: { mode: 'forbidden' },
      authorization: {
        action: 'audit.read',
        baseRole: 'admin',
      },
    });
    expect(resolveGardenRouteCapability(
      'PATCH',
      '/api/admin/shards/shard-a/configuration',
    )?.capability).toMatchObject({
      body: { mode: 'required' },
      authorization: {
        action: 'settings.write',
        baseRole: 'admin',
        requirements: {
          assurance: 'oauth',
          confirmation: 'explicit',
        },
      },
    });
  });

  it('declares the Bearer API companion pin routes alongside the context-envelope channel controls', () => {
    expect(resolveGardenRouteCapability('GET', '/api/admin/channels/bearer-companion')?.capability)
      .toMatchObject({
        id: 'GET /api/admin/channels/bearer-companion',
        authorization: { action: 'channels.read', baseRole: 'admin' },
      });
    expect(resolveGardenRouteCapability('POST', '/api/admin/channels/bearer-companion')?.capability)
      .toMatchObject({
        id: 'POST /api/admin/channels/bearer-companion',
        body: { mode: 'forbidden' },
        authorization: {
          action: 'channels.manage',
          baseRole: 'admin',
          requirements: { assurance: 'oauth', confirmation: 'explicit' },
        },
      });
  });

  it('matches mutation body policies to the Garden handlers that consume request bodies', () => {
    const bodyMode = (method: 'POST', path: string) =>
      resolveGardenRouteCapability(method, path)?.capability.body.mode;

    expect(bodyMode('POST', '/api/admin/graph-proposals/proposal-a/approve')).toBe('optional');
    expect(bodyMode('POST', '/api/admin/graph-proposals/proposal-a/reject')).toBe('forbidden');
    expect(bodyMode('POST', '/api/admin/contact-approvals/contact-a/approve')).toBe('forbidden');
    expect(bodyMode('POST', '/api/admin/contact-approvals/contact-a/deny')).toBe('forbidden');
    expect(bodyMode('POST', '/api/admin/contact-approvals/contact-a/reset')).toBe('forbidden');
    expect(bodyMode('POST', '/api/admin/wishlist/wish-a/acknowledge')).toBe('forbidden');
    expect(bodyMode('POST', '/api/admin/wishlist/wish-a/done')).toBe('forbidden');
    expect(bodyMode('POST', '/api/admin/prompts/layer-a/rollback')).toBe('optional');
    expect(bodyMode('POST', '/api/admin/action-pipe/actions/action-a/acknowledge')).toBe('optional');
    expect(bodyMode('POST', '/api/admin/action-pipe/actions/action-a/cancel')).toBe('optional');
    expect(bodyMode('POST', '/api/admin/session-routes/reset')).toBe('optional');
    expect(bodyMode('POST', '/api/admin/icp-autonomy/test-initiations')).toBe('required');
  });

  it('compiles the authenticated ICP test-initiation declaration', () => {
    expect(compileGardenRouteDeclarations([{
      method: 'POST',
      match: { capabilityPattern: '/api/admin/icp-autonomy/test-initiations' },
    }])[0]?.capability.authorization).toMatchObject({
      action: 'autonomy.manage',
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
