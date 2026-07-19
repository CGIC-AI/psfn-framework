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
