import { describe, expect, it, vi } from 'vitest';

import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import { createDefaultBiographicalDepthPolicy } from '../../../system/config/biographical-depth-policy.js';
import {
  createBiographySynthesisTargetPort,
  type BiographyGroupMembershipAuthorityPort,
  type VerifiedBiographyGroupMembership,
} from './synthesis-targets.js';
import type { BiographicalSubjectRef } from './types.js';

const COMPANION_SUBJECT: Extract<BiographicalSubjectRef, { kind: 'companion' }> = {
  kind: 'companion',
  companionId: 'companion-invented',
  subjectVersion: 1,
};

/** No contacts at all, so the only targets under test are the group ones. */
function emptyContactStore(): ContactStorePort {
  return {
    getByTrustLevel: vi.fn(async () => []),
    countVerifiedIdentityLinks: vi.fn(async () => 0),
  } as unknown as ContactStorePort;
}

function membership(
  overrides: Partial<VerifiedBiographyGroupMembership> = {},
): VerifiedBiographyGroupMembership {
  return {
    contextId: 'room-invented',
    governanceAuthorityRef: 'participation-authority:room-invented',
    verified: true,
    contactIds: ['contact-b-invented', 'contact-a-invented'],
    ...overrides,
  };
}

function authority(
  memberships: readonly VerifiedBiographyGroupMembership[],
): BiographyGroupMembershipAuthorityPort {
  return { listVerifiedGroups: vi.fn(async () => memberships) };
}

function targetPort(groupMembershipAuthority?: BiographyGroupMembershipAuthorityPort) {
  return createBiographySynthesisTargetPort({
    contactStore: emptyContactStore(),
    companionSubject: COMPANION_SUBJECT,
    depthPolicy: () => createDefaultBiographicalDepthPolicy(),
    ...(groupMembershipAuthority ? { groupMembershipAuthority } : {}),
  });
}

// psfn-framework-uz787 — group synthesis exists only where an authority vouches
// for the exact canonical membership. No authority means no group targets: the
// runtime never infers who was in a group from rooms, labels or model output.
describe('biography synthesis group targets (uz787)', () => {
  it('emits no group target at all when no membership authority is wired', async () => {
    const targets = await targetPort().listTargets(10);

    expect(targets).toHaveLength(1);
    expect(targets[0]?.socialContext).toEqual({
      kind: 'companion_self',
      companionId: COMPANION_SUBJECT.companionId,
    });
    expect(targets.some(target => target.socialContext.kind === 'companion_group')).toBe(false);
  });

  it('emits a companion-anchored group target from a verified membership', async () => {
    const targets = await targetPort(authority([membership()])).listTargets(10);

    expect(targets).toHaveLength(2);
    const group = targets[1];
    // A group claim is anchored on the companion and binds its participants
    // explicitly; it is never a claim ABOUT one member.
    expect(group?.subject).toEqual(COMPANION_SUBJECT);
    expect(group?.depth).toBe('full');
    expect(group?.socialContext).toEqual({
      kind: 'companion_group',
      companionId: COMPANION_SUBJECT.companionId,
      // Canonically ordered, matching `assertParticipantSet`, so the same group
      // observed twice never produces two different contexts.
      contactIds: ['contact-a-invented', 'contact-b-invented'],
    });
  });

  it.each([
    ['unverified membership', membership({ verified: false })],
    ['no governance authority reference', membership({ governanceAuthorityRef: 'not-a-ref' })],
    ['blank context id', membership({ contextId: '   ' })],
    ['a dyad rather than a group', membership({ contactIds: ['contact-a-invented'] })],
    ['a repeated contact', membership({
      contactIds: ['contact-a-invented', 'contact-a-invented'],
    })],
    ['an empty membership', membership({ contactIds: [] })],
  ])('drops a membership with %s rather than repairing it', async (_label, bad) => {
    const targets = await targetPort(authority([bad])).listTargets(10);

    expect(targets.some(target => target.socialContext.kind === 'companion_group')).toBe(false);
  });

  // psfn-framework-zu8d2 — the membership's governed context is also the
  // group's EVIDENCE boundary. Without it a group scan, which runs under the
  // companion's own subject, would be handed her entire private silo.
  it('scopes group evidence to the governed context the authority vouched for', async () => {
    const targets = await targetPort(authority([membership({ contextId: ' room-invented ' })]))
      .listTargets(10);

    expect(targets[1]?.evidenceScope).toEqual({ governedContextIds: ['room-invented'] });
  });

  it('leaves every subject-scoped target without an evidence scope', async () => {
    const targets = await targetPort(authority([membership()])).listTargets(10);

    // The autobiography is bounded by its subject, exactly as before.
    expect(targets[0]?.socialContext.kind).toBe('companion_self');
    expect(targets[0]?.evidenceScope).toBeUndefined();
  });

  it('keeps the caller target limit', async () => {
    const port = targetPort(authority([
      membership({ contextId: 'room-1', contactIds: ['contact-a', 'contact-b'] }),
      membership({ contextId: 'room-2', contactIds: ['contact-c', 'contact-d'] }),
    ]));

    // One slot is already spent on the companion's own autobiography.
    const targets = await port.listTargets(2);
    expect(targets).toHaveLength(2);
    expect(targets.filter(target => target.socialContext.kind === 'companion_group')).toHaveLength(1);
  });
});
