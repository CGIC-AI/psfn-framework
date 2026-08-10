import { describe, expect, it } from 'vitest';
import { escalationScopeDigest } from './escalation.js';
import { compileGatewayGardenRequestTarget } from './request-capability-target.js';
import { createCompanionId } from '../../shared/routing/companion-id.js';

const COMPANION_ID = createCompanionId('11111111-1111-4111-8111-111111111111');

function memoryRevealTarget(memoryId: string) {
  return compileGatewayGardenRequestTarget({
    rawTarget: `/api/admin/memory/${memoryId}/reveal`,
    method: 'POST',
    companionId: COMPANION_ID,
    body: Buffer.from('{"reason":"why"}', 'utf8'),
  });
}

function quarantineTarget(
  envelopeId: string,
  phase: 'confirm' | 'decide',
) {
  return compileGatewayGardenRequestTarget({
    rawTarget: `/api/admin/intake/quarantine/${envelopeId}/${phase}`,
    method: 'POST',
    companionId: COMPANION_ID,
    body: Buffer.from('{}', 'utf8'),
  });
}

describe('Protected action escalation binding', () => {
  it('binds memory reveal grants independently to the exact memory id under memory.reveal', () => {
    const revealA = memoryRevealTarget('mem-a');
    const revealB = memoryRevealTarget('mem-b');

    expect(revealA).toMatchObject({
      action: 'memory.reveal',
      resource: {
        routeId: 'POST /api/admin/memory/:id/reveal',
        pathParams: { id: 'mem-a' },
      },
    });
    // A grant for one memory never authorizes another: the scope digest is
    // path-param bound, so a replay against a different id fails closed.
    expect(escalationScopeDigest(revealB)).not.toBe(escalationScopeDigest(revealA));
  });

  it('binds quarantine confirm and decide grants to the exact envelope id and exact phase', () => {
    const confirmA = quarantineTarget('env-a', 'confirm');
    const decideA = quarantineTarget('env-a', 'decide');
    const confirmB = quarantineTarget('env-b', 'confirm');

    expect(confirmA).toMatchObject({
      action: 'cogsec.manage',
      resource: {
        routeId: 'POST /api/admin/intake/quarantine/:id/confirm',
        pathParams: { id: 'env-a' },
      },
    });
    expect(decideA).toMatchObject({
      action: 'cogsec.manage',
      resource: {
        routeId: 'POST /api/admin/intake/quarantine/:id/decide',
        pathParams: { id: 'env-a' },
      },
    });
    // A confirm grant cannot be spent on the decide route, and a grant for one
    // envelope cannot be spent on another — each fails closed.
    expect(escalationScopeDigest(decideA)).not.toBe(escalationScopeDigest(confirmA));
    expect(escalationScopeDigest(confirmB)).not.toBe(escalationScopeDigest(confirmA));
  });

  it('never binds a memory reveal grant to a quarantine route or vice versa', () => {
    const reveal = memoryRevealTarget('mem-a');
    const confirm = quarantineTarget('mem-a', 'confirm');
    expect(reveal.action).toBe('memory.reveal');
    expect(confirm.action).toBe('cogsec.manage');
    expect(escalationScopeDigest(reveal)).not.toBe(escalationScopeDigest(confirm));
  });
});
