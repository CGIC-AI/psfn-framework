import { describe, expect, it } from 'vitest';
import type { SensitivityLevel } from '../../../system/trust/types.js';
import type {
  DisclosureDestinationConstraint,
  DisclosureSourceContribution,
  GenerationDisclosureContext,
} from './contracts.js';
import {
  accumulateDisclosureSource,
  assessDisclosure,
  beginDisclosureAccumulation,
  destinationEpochEligible,
  destinationPermitted,
  intersectDestinationConstraints,
  maxSensitivity,
} from './decision.js';

const CONTEXT: GenerationDisclosureContext = {
  generationContextRef: 'gen:test',
  classifierVersion: 'disclosure/v1',
  classifiedAt: '2026-07-19T00:00:00.000Z',
};

function source(
  overrides: Partial<DisclosureSourceContribution> & Pick<DisclosureSourceContribution, 'ref' | 'sensitivity' | 'permittedDestinations'>,
): DisclosureSourceContribution {
  return { classified: true, ...overrides };
}

// ── Rule 1: most-restrictive sensitivity ──────────────────────────────────────

describe('maxSensitivity (rule 1: most restrictive)', () => {
  it('returns the highest of the admitted sources', () => {
    expect(maxSensitivity(['public', 'intimate', 'personal'])).toBe('intimate');
    expect(maxSensitivity(['public', 'personal'])).toBe('personal');
    expect(maxSensitivity(['confidential', 'public'])).toBe('confidential');
  });

  it('fails closed to the most restrictive level for an empty set', () => {
    expect(maxSensitivity([])).toBe('confidential');
  });

  it('never lowers below an earlier restrictive source', () => {
    const levels: SensitivityLevel[] = ['confidential', 'public', 'personal'];
    expect(maxSensitivity(levels)).toBe('confidential');
  });
});

// ── Rule 2: destination intersection ──────────────────────────────────────────

describe('intersectDestinationConstraints (rule 2: intersection not union)', () => {
  it('keeps only kinds permitted by both sources', () => {
    const a: DisclosureDestinationConstraint[] = [
      { kind: 'contact_dm', contactIds: ['c1'] },
      { kind: 'invite_only_room', channelIds: ['r1'] },
    ];
    const b: DisclosureDestinationConstraint[] = [
      { kind: 'contact_dm', contactIds: ['c1', 'c2'] },
      { kind: 'public_room', channelIds: ['r9'] },
    ];
    expect(intersectDestinationConstraints(a, b)).toEqual([
      { kind: 'contact_dm', contactIds: ['c1'] },
    ]);
  });

  it('intersects scoped id sets and drops kinds with no shared id', () => {
    const a: DisclosureDestinationConstraint[] = [{ kind: 'invite_only_room', channelIds: ['r1', 'r2'] }];
    const b: DisclosureDestinationConstraint[] = [{ kind: 'invite_only_room', channelIds: ['r3'] }];
    expect(intersectDestinationConstraints(a, b)).toEqual([]);
  });

  it('treats an unrestricted (id-less) constraint as any id of its kind', () => {
    const a: DisclosureDestinationConstraint[] = [{ kind: 'contact_dm' }];
    const b: DisclosureDestinationConstraint[] = [{ kind: 'contact_dm', contactIds: ['c7'] }];
    expect(intersectDestinationConstraints(a, b)).toEqual([{ kind: 'contact_dm', contactIds: ['c7'] }]);
  });

  it('is union within a single source but intersection across sources', () => {
    const a: DisclosureDestinationConstraint[] = [
      { kind: 'invite_only_room', channelIds: ['r1'] },
      { kind: 'invite_only_room', channelIds: ['r2'] },
    ];
    const b: DisclosureDestinationConstraint[] = [{ kind: 'invite_only_room', channelIds: ['r2', 'r3'] }];
    expect(intersectDestinationConstraints(a, b)).toEqual([{ kind: 'invite_only_room', channelIds: ['r2'] }]);
  });
});

describe('destinationPermitted', () => {
  const constraints: DisclosureDestinationConstraint[] = [
    { kind: 'contact_dm', contactIds: ['c1'] },
    { kind: 'invite_only_room', channelIds: ['r1'] },
  ];

  it('permits a scoped destination whose id is present', () => {
    expect(destinationPermitted(constraints, { kind: 'contact_dm', contactId: 'c1' })).toBe(true);
    expect(destinationPermitted(constraints, { kind: 'invite_only_room', channelId: 'r1' })).toBe(true);
  });

  it('denies a scoped destination whose id is absent or whose kind is missing', () => {
    expect(destinationPermitted(constraints, { kind: 'contact_dm', contactId: 'c2' })).toBe(false);
    expect(destinationPermitted(constraints, { kind: 'public_room', channelId: 'r1' })).toBe(false);
    expect(destinationPermitted(constraints, { kind: 'publication' })).toBe(false);
  });

  it('always permits companion_self regardless of the constraint set', () => {
    expect(destinationPermitted([], { kind: 'companion_self' })).toBe(true);
  });
});

// ── Rule 3: fail-closed unclassified ──────────────────────────────────────────

describe('assessDisclosure (rule 3: fail closed) + composition', () => {
  it('fails closed for outward destinations when there is no lineage', () => {
    expect(assessDisclosure(undefined, { kind: 'publication' })).toMatchObject({
      allowed: false,
      outcome: 'non_shareable',
    });
    const empty = beginDisclosureAccumulation(CONTEXT);
    expect(assessDisclosure(empty, { kind: 'public_room', channelId: 'r1' })).toMatchObject({
      allowed: false,
      outcome: 'non_shareable',
    });
  });

  it('keeps companion_self eligible even with no lineage', () => {
    expect(assessDisclosure(undefined, { kind: 'companion_self' })).toMatchObject({
      allowed: true,
      outcome: 'auto_shareable',
    });
  });

  it('fails closed when any admitted source lacks usable lineage', () => {
    let lineage = beginDisclosureAccumulation(CONTEXT);
    lineage = accumulateDisclosureSource(lineage, source({
      ref: 'mem:1',
      sensitivity: 'public',
      permittedDestinations: [{ kind: 'public_room', channelIds: ['r1'] }],
    }));
    lineage = accumulateDisclosureSource(lineage, source({
      ref: 'wiki:legacy',
      sensitivity: 'public',
      permittedDestinations: [{ kind: 'public_room', channelIds: ['r1'] }],
      classified: false,
    }));
    expect(lineage.hasUnclassifiedSource).toBe(true);
    expect(lineage.classification).toBe('non_shareable');
    expect(assessDisclosure(lineage, { kind: 'public_room', channelId: 'r1' })).toMatchObject({
      allowed: false,
      outcome: 'non_shareable',
    });
    // companion-self still allowed
    expect(assessDisclosure(lineage, { kind: 'companion_self' }).allowed).toBe(true);
  });

  it('allows a permitted destination within the sensitivity ceiling', () => {
    let lineage = beginDisclosureAccumulation(CONTEXT);
    lineage = accumulateDisclosureSource(lineage, source({
      ref: 'room:r1:msg',
      sensitivity: 'public',
      permittedDestinations: [{ kind: 'public_room', channelIds: ['r1'] }],
      sourceChannelId: 'r1',
    }));
    expect(assessDisclosure(lineage, { kind: 'public_room', channelId: 'r1' })).toMatchObject({
      allowed: true,
      outcome: 'auto_shareable',
    });
  });

  it('routes over-ceiling but permitted content to approval_required', () => {
    let lineage = beginDisclosureAccumulation(CONTEXT);
    lineage = accumulateDisclosureSource(lineage, source({
      ref: 'dm:c1',
      sensitivity: 'confidential',
      permittedDestinations: [{ kind: 'contact_dm', contactIds: ['c1'] }, { kind: 'invite_only_room', channelIds: ['r1'] }],
    }));
    // invite_only_room ceiling is 'personal'; confidential exceeds it.
    expect(assessDisclosure(lineage, { kind: 'invite_only_room', channelId: 'r1' })).toMatchObject({
      allowed: false,
      outcome: 'approval_required',
    });
    // contact_dm ceiling is 'confidential'; permitted and within ceiling.
    expect(assessDisclosure(lineage, { kind: 'contact_dm', contactId: 'c1' }).allowed).toBe(true);
  });
});

// ── Parent-level accumulation behavior (jp36.1.1) ─────────────────────────────

describe('accumulateDisclosureSource: later restrictive source tightens outputs', () => {
  it('a later restrictive source blocks room/publication while companion-self stays allowed', () => {
    let lineage = beginDisclosureAccumulation(CONTEXT);
    // Public-clean room source: eligible for the public room.
    lineage = accumulateDisclosureSource(lineage, source({
      ref: 'room:r1',
      sensitivity: 'public',
      permittedDestinations: [
        { kind: 'public_room', channelIds: ['r1'] },
        { kind: 'publication' },
      ],
      sourceChannelId: 'r1',
    }));
    expect(assessDisclosure(lineage, { kind: 'public_room', channelId: 'r1' }).allowed).toBe(true);
    expect(assessDisclosure(lineage, { kind: 'publication' }).allowed).toBe(true);

    // A later intimate DM source, permitted only to that DM, tightens everything.
    lineage = accumulateDisclosureSource(lineage, source({
      ref: 'dm:c9',
      sensitivity: 'intimate',
      permittedDestinations: [{ kind: 'contact_dm', contactIds: ['c9'] }],
      subjectContactIds: ['c9'],
    }));

    expect(lineage.effectiveSensitivity).toBe('intimate');
    // Intersection with a DM-only source removes room + publication entirely.
    expect(lineage.permittedDestinations).toEqual([]);
    expect(assessDisclosure(lineage, { kind: 'public_room', channelId: 'r1' })).toMatchObject({
      allowed: false,
      outcome: 'non_shareable',
    });
    expect(assessDisclosure(lineage, { kind: 'publication' })).toMatchObject({
      allowed: false,
      outcome: 'non_shareable',
    });
    // companion-self remains allowed (jp36.1 acceptance criterion).
    expect(assessDisclosure(lineage, { kind: 'companion_self' }).allowed).toBe(true);
  });

  it('preserves and intersects per-channel admitted epochs (rule 4)', () => {
    let lineage = beginDisclosureAccumulation(CONTEXT);
    // First source records the room at epoch 2.
    lineage = accumulateDisclosureSource(lineage, source({
      ref: 'room:r1@2',
      sensitivity: 'public',
      permittedDestinations: [{ kind: 'public_room', channelIds: ['r1'], channelEpochs: { r1: 2 } }],
    }));
    expect(lineage.permittedDestinations).toEqual([
      { kind: 'public_room', channelIds: ['r1'], channelEpochs: { r1: 2 } },
    ]);
    // A second source agreeing on epoch 2 keeps it.
    lineage = accumulateDisclosureSource(lineage, source({
      ref: 'room:r1@2b',
      sensitivity: 'public',
      permittedDestinations: [{ kind: 'public_room', channelIds: ['r1'], channelEpochs: { r1: 2 } }],
    }));
    expect(lineage.permittedDestinations).toEqual([
      { kind: 'public_room', channelIds: ['r1'], channelEpochs: { r1: 2 } },
    ]);
    // A third source disagreeing on the epoch drops it to UNKNOWN (fail closed),
    // while the channel itself remains permitted.
    lineage = accumulateDisclosureSource(lineage, source({
      ref: 'room:r1@3',
      sensitivity: 'public',
      permittedDestinations: [{ kind: 'public_room', channelIds: ['r1'], channelEpochs: { r1: 3 } }],
    }));
    expect(lineage.permittedDestinations).toEqual([{ kind: 'public_room', channelIds: ['r1'] }]);
  });

  it('drops the epoch to UNKNOWN when one source records it and another does not', () => {
    expect(intersectDestinationConstraints(
      [{ kind: 'public_room', channelIds: ['r1'], channelEpochs: { r1: 2 } }],
      [{ kind: 'public_room', channelIds: ['r1'] }],
    )).toEqual([{ kind: 'public_room', channelIds: ['r1'] }]);
  });

  it('accumulates subject contacts, source channels, and provenance refs', () => {
    let lineage = beginDisclosureAccumulation(CONTEXT);
    lineage = accumulateDisclosureSource(lineage, source({
      ref: 'mem:a',
      sensitivity: 'personal',
      permittedDestinations: [{ kind: 'contact_dm', contactIds: ['c1'] }],
      subjectContactIds: ['c1'],
      sourceChannelId: 'ch1',
      provenanceRefs: ['prov:1'],
    }));
    lineage = accumulateDisclosureSource(lineage, source({
      ref: 'mem:b',
      sensitivity: 'personal',
      permittedDestinations: [{ kind: 'contact_dm', contactIds: ['c1', 'c2'] }],
      subjectContactIds: ['c2'],
      sourceChannelId: 'ch2',
    }));
    expect(lineage.subjectContactIds).toEqual(['c1', 'c2']);
    expect(lineage.sourceChannelIds).toEqual(['ch1', 'ch2']);
    expect(lineage.provenanceRefs).toEqual(['mem:a', 'mem:b', 'prov:1']);
    expect(lineage.sourceCount).toBe(2);
    // contact_dm intersected down to the shared contact c1.
    expect(lineage.permittedDestinations).toEqual([{ kind: 'contact_dm', contactIds: ['c1'] }]);
  });
});

// ── Rule 4: epoch disclosure boundary (jp36.6.3) ──────────────────────────────

describe('destinationEpochEligible (rule 4: epoch boundary)', () => {
  const roomAtEpoch2: DisclosureDestinationConstraint[] = [
    { kind: 'public_room', channelIds: ['r1'], channelEpochs: { r1: 2 } },
  ];

  it('is inert for non-room destinations (no room-classification epoch)', () => {
    expect(destinationEpochEligible(
      [{ kind: 'contact_dm', contactIds: ['c1'] }],
      { kind: 'contact_dm', contactId: 'c1' },
    )).toBe(true);
    expect(destinationEpochEligible([{ kind: 'publication' }], { kind: 'publication' })).toBe(true);
    expect(destinationEpochEligible([], { kind: 'companion_self' })).toBe(true);
  });

  it('skips the gate when the destination channel carries no tracked epoch (pre-epoch behavior)', () => {
    // No currentEpoch on the destination ⇒ identical to before epochs existed.
    expect(destinationEpochEligible(roomAtEpoch2, { kind: 'public_room', channelId: 'r1' })).toBe(true);
    // Even when the content itself carries no admitted epoch.
    expect(destinationEpochEligible(
      [{ kind: 'public_room', channelIds: ['r1'] }],
      { kind: 'public_room', channelId: 'r1' },
    )).toBe(true);
  });

  it('permits same-epoch content and denies content from a different epoch', () => {
    expect(destinationEpochEligible(roomAtEpoch2, { kind: 'public_room', channelId: 'r1', currentEpoch: 2 })).toBe(true);
    // The room advanced to a fresh epoch (e.g. narrowed then re-widened); prior-
    // epoch content is no longer auto-eligible.
    expect(destinationEpochEligible(roomAtEpoch2, { kind: 'public_room', channelId: 'r1', currentEpoch: 3 })).toBe(false);
  });

  it('fails closed when the admitted epoch is UNKNOWN but the destination is epoch-tracked', () => {
    // Content carries no channelEpochs for r1, but the destination now tracks an
    // epoch: cannot prove same-epoch admission ⇒ deny (never a widening).
    expect(destinationEpochEligible(
      [{ kind: 'public_room', channelIds: ['r1'] }],
      { kind: 'public_room', channelId: 'r1', currentEpoch: 2 },
    )).toBe(false);
  });
});

describe('assessDisclosure epoch composition (jp36.6.3)', () => {
  function publicRoomLineage(channelId: string, admittedEpoch?: number) {
    const channelEpochs = admittedEpoch !== undefined ? { [channelId]: admittedEpoch } : undefined;
    return accumulateDisclosureSource(beginDisclosureAccumulation(CONTEXT), source({
      ref: `room:${channelId}@${admittedEpoch ?? 'none'}`,
      sensitivity: 'public',
      permittedDestinations: [{
        kind: 'public_room',
        channelIds: [channelId],
        ...(channelEpochs ? { channelEpochs } : {}),
      }],
      sourceChannelId: channelId,
    }));
  }

  it('auto-shares post-change content to the same room within its epoch', () => {
    const lineage = publicRoomLineage('r1', 2);
    expect(assessDisclosure(lineage, { kind: 'public_room', channelId: 'r1', currentEpoch: 2 })).toMatchObject({
      allowed: true,
      outcome: 'auto_shareable',
    });
  });

  it('routes prior-epoch content to human review (approval_required, not auto-share)', () => {
    // Content admitted under public epoch 2; the room later opened a fresh epoch.
    const lineage = publicRoomLineage('r1', 2);
    const decision = assessDisclosure(lineage, { kind: 'public_room', channelId: 'r1', currentEpoch: 3 });
    expect(decision.allowed).toBe(false);
    expect(decision.outcome).toBe('approval_required');
    expect(decision.reason).toContain('prior classification epoch');
  });

  it('fails closed for epoch-unknown content once the destination is epoch-tracked', () => {
    const lineage = publicRoomLineage('r1', undefined);
    const decision = assessDisclosure(lineage, { kind: 'public_room', channelId: 'r1', currentEpoch: 4 });
    expect(decision.allowed).toBe(false);
    expect(decision.outcome).toBe('approval_required');
  });

  it('is unchanged from pre-epoch when neither side carries an epoch', () => {
    const lineage = publicRoomLineage('r1', undefined);
    expect(assessDisclosure(lineage, { kind: 'public_room', channelId: 'r1' }).allowed).toBe(true);
  });

  it('denies invite-only-epoch material to the same room after it widens to public', () => {
    // The headline demotion scenario: content admitted while the room was
    // invite-only (epoch 1). After widening, the room reclassifies public, so the
    // egress destination is a public_room — the kind boundary already denies, and
    // companion-self stays eligible.
    const lineage = accumulateDisclosureSource(beginDisclosureAccumulation(CONTEXT), source({
      ref: 'room:r1@invite',
      sensitivity: 'public',
      permittedDestinations: [{ kind: 'invite_only_room', channelIds: ['r1'], channelEpochs: { r1: 1 } }],
      sourceChannelId: 'r1',
    }));
    expect(assessDisclosure(lineage, { kind: 'public_room', channelId: 'r1', currentEpoch: 2 }).allowed).toBe(false);
    expect(assessDisclosure(lineage, { kind: 'companion_self' }).allowed).toBe(true);
  });
});
