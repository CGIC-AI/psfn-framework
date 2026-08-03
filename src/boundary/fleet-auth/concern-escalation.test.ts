import { describe, expect, it } from 'vitest';
import { escalationScopeDigest } from './escalation.js';
import { compileGatewayGardenRequestTarget } from './request-capability-target.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';

const COMPANION_ID = createCompanionId('11111111-1111-4111-8111-111111111111');

function target(concernId: string, action: 'resolve' | 'suppress' | 'transition') {
  return compileGatewayGardenRequestTarget({
    rawTarget: `/api/admin/concerns/${concernId}/${action}`,
    method: 'POST',
    companionId: COMPANION_ID,
    body: Buffer.from('{}', 'utf8'),
  });
}

describe('CogSec concern escalation binding', () => {
  it('binds grants independently to the exact concern and exact action route', () => {
    const resolveA = target('concern-a', 'resolve');
    const resolveB = target('concern-b', 'resolve');
    const suppressA = target('concern-a', 'suppress');

    expect(resolveA).toMatchObject({
      action: 'cogsec.manage',
      resource: {
        routeId: 'POST /api/admin/concerns/:concernId/resolve',
        pathParams: { concernId: 'concern-a' },
      },
    });
    expect(escalationScopeDigest(resolveB)).not.toBe(escalationScopeDigest(resolveA));
    expect(escalationScopeDigest(suppressA)).not.toBe(escalationScopeDigest(resolveA));
  });
});
