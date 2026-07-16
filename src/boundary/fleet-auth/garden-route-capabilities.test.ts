import { describe, expect, it } from 'vitest';
import {
  GARDEN_CLIENT_ROUTES,
  GARDEN_ROUTE_CAPABILITIES,
  resolveGardenRouteCapability,
} from './garden-route-capabilities.js';

describe('Garden route capability catalogue', () => {
  it('has one exact declaration per method and canonical pattern', () => {
    const ids = GARDEN_ROUTE_CAPABILITIES.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const capability of GARDEN_ROUTE_CAPABILITIES) {
      expect(capability.id).toBe(`${capability.method} ${capability.pattern}`);
      expect(capability.action).toBeTruthy();
      expect(capability.resource.scope).toBeTruthy();
      expect(capability.resource.area).toBeTruthy();
      expect(capability.body.maxBytes).toBeGreaterThanOrEqual(0);
    }
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
    expect(resolveGardenRouteCapability('GET', '/api/admin/images/generated')?.capability.resource)
      .toEqual({ scope: 'personal_workspace', area: 'images' });
    expect(resolveGardenRouteCapability('GET', '/api/admin/sessions/channel-a')?.capability.resource)
      .toEqual({ scope: 'personal_workspace', area: 'channel_artifacts' });
    expect(resolveGardenRouteCapability('GET', '/api/admin/wiki/document-a')?.capability.resource)
      .toEqual({ scope: 'personal_workspace', area: 'wiki' });
    expect(resolveGardenRouteCapability('GET', '/api/admin/shared-workspace/artifact')?.capability.resource)
      .toEqual({ scope: 'governed_shared_workspace', area: 'shared_workspace' });
    expect(resolveGardenRouteCapability('GET', '/api/admin/wiki/shared-world/site-a')?.capability.resource)
      .toEqual({ scope: 'governed_shared_workspace', area: 'wiki' });
  });
});
