import { describe, expect, it } from 'vitest';

import {
  projectReturnNoteEvidence,
  type ReturnNoteEvidenceItem,
} from './return-note-projection.js';
import {
  accumulateDisclosureSource,
  beginDisclosureAccumulation,
  type DisclosureDestination,
  type DisclosureDestinationConstraint,
  type DisclosureLineage,
} from '../cogsec/disclosure/index.js';
import type { SessionEntry } from '../session/types.js';
import type { SensitivityLevel } from '../../system/trust/types.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function entry(id: number, content: string): SessionEntry {
  return {
    id,
    channelId: 'internal:free-time:private',
    role: 'assistant',
    content,
    timestamp: 1_700_000_000_000 + id,
  };
}

/**
 * Build a realistic single-source disclosure lineage via the landed accumulator
 * (never hand-forged), so the projection is exercised against the exact shape
 * the runtime produces.
 */
function lineage(input: {
  ref: string;
  sensitivity: SensitivityLevel;
  permittedDestinations: readonly DisclosureDestinationConstraint[];
  subjectContactIds?: readonly string[];
  classified?: boolean;
}): DisclosureLineage {
  return accumulateDisclosureSource(
    beginDisclosureAccumulation({
      generationContextRef: `gen:${input.ref}`,
      classifierVersion: 'test',
      classifiedAt: '2026-07-20T00:00:00.000Z',
    }),
    {
      ref: input.ref,
      sensitivity: input.sensitivity,
      permittedDestinations: input.permittedDestinations,
      subjectContactIds: input.subjectContactIds ?? [],
      classified: input.classified ?? true,
    },
  );
}

const CONTACT_A: DisclosureDestination = { kind: 'contact_dm', contactId: 'contact-a' };
const CONTACT_B: DisclosureDestination = { kind: 'contact_dm', contactId: 'contact-b' };
const ROOM: DisclosureDestination = { kind: 'invite_only_room', channelId: 'room-1' };
const SELF: DisclosureDestination = { kind: 'companion_self' };
const PUBLICATION: DisclosureDestination = { kind: 'publication' };

// ── Private/self: full fidelity ──────────────────────────────────────────────

describe('projectReturnNoteEvidence — companion_self (private/self)', () => {
  it('keeps FULL fidelity: every entry is eligible, even entries with no lineage', () => {
    const evidence: ReturnNoteEvidenceItem[] = [
      { entry: entry(1, 'wrote a poem'), lineage: undefined },
      {
        entry: entry(2, 'made a picture'),
        lineage: lineage({
          ref: 'session:x',
          sensitivity: 'confidential',
          permittedDestinations: [{ kind: 'companion_self' }],
        }),
      },
    ];

    const projection = projectReturnNoteEvidence({ evidence, destination: SELF });

    expect(projection.mode).toBe('content');
    expect(projection.collapsed).toBe(false);
    expect(projection.destination).toEqual(SELF);
    expect(projection.eligibleEntries.map(e => e.id)).toEqual([1, 2]);
  });
});

// ── Publication: state, not content ──────────────────────────────────────────

describe('projectReturnNoteEvidence — publication', () => {
  it('carries STATE not content: no transcript evidence reaches the summarizer', () => {
    const evidence: ReturnNoteEvidenceItem[] = [
      {
        entry: entry(1, 'drafted a public post'),
        lineage: lineage({
          ref: 'wiki:pub',
          sensitivity: 'public',
          permittedDestinations: [{ kind: 'publication' }],
        }),
      },
    ];

    const projection = projectReturnNoteEvidence({ evidence, destination: PUBLICATION });

    expect(projection.mode).toBe('state_only');
    expect(projection.collapsed).toBe(false);
    expect(projection.eligibleEntries).toHaveLength(0);
  });
});

// ── Multi-contact isolation (acceptance criterion) ───────────────────────────

describe('projectReturnNoteEvidence — DM destination, multi-contact isolation', () => {
  it('unrelated-contact material NEVER reaches the summarizer input for a DM-targeted note', () => {
    const evidence: ReturnNoteEvidenceItem[] = [
      {
        entry: entry(1, 'note about contact A'),
        lineage: lineage({
          ref: 'mem:a',
          sensitivity: 'personal',
          permittedDestinations: [{ kind: 'contact_dm', contactIds: ['contact-a'] }],
          subjectContactIds: ['contact-a'],
        }),
      },
      {
        entry: entry(2, 'note about contact B'),
        lineage: lineage({
          ref: 'mem:b',
          sensitivity: 'personal',
          permittedDestinations: [{ kind: 'contact_dm', contactIds: ['contact-b'] }],
          subjectContactIds: ['contact-b'],
        }),
      },
    ];

    const projection = projectReturnNoteEvidence({ evidence, destination: CONTACT_A });

    expect(projection.mode).toBe('content');
    expect(projection.collapsed).toBe(false);
    // Only the contact-A entry survives; contact-B material is dropped.
    expect(projection.eligibleEntries.map(e => e.id)).toEqual([1]);
    expect(projection.eligibleEntries.map(e => e.content)).not.toContain('note about contact B');
  });

  it('a DM-permitted entry does NOT reach a different contact than the one it permits', () => {
    const evidence: ReturnNoteEvidenceItem[] = [
      {
        entry: entry(1, 'note about contact A'),
        lineage: lineage({
          ref: 'mem:a',
          sensitivity: 'personal',
          permittedDestinations: [{ kind: 'contact_dm', contactIds: ['contact-a'] }],
          subjectContactIds: ['contact-a'],
        }),
      },
    ];

    // Target contact B: contact-A material must collapse, never leak to B.
    const projection = projectReturnNoteEvidence({ evidence, destination: CONTACT_B });

    expect(projection.mode).toBe('collapsed_private');
    expect(projection.collapsed).toBe(true);
    expect(projection.destination).toEqual(SELF);
    expect(projection.eligibleEntries).toHaveLength(0);
  });
});

// ── Fail-closed collapse ─────────────────────────────────────────────────────

describe('projectReturnNoteEvidence — fail-closed collapse', () => {
  it('collapses to private/self when an entry has NO lineage (outward destination)', () => {
    const evidence: ReturnNoteEvidenceItem[] = [
      { entry: entry(1, 'made something'), lineage: undefined },
    ];

    const projection = projectReturnNoteEvidence({ evidence, destination: CONTACT_A });

    expect(projection.mode).toBe('collapsed_private');
    expect(projection.collapsed).toBe(true);
    expect(projection.destination).toEqual(SELF);
    expect(projection.eligibleEntries).toHaveLength(0);
    expect(projection.reason).toContain('collapsed');
  });

  it('collapses when an admitted source lacked usable lineage (unclassified taint)', () => {
    const evidence: ReturnNoteEvidenceItem[] = [
      {
        entry: entry(1, 'mixed material'),
        lineage: lineage({
          ref: 'tool:web',
          sensitivity: 'personal',
          permittedDestinations: [{ kind: 'contact_dm', contactIds: ['contact-a'] }],
          subjectContactIds: ['contact-a'],
          classified: false,
        }),
      },
    ];

    const projection = projectReturnNoteEvidence({ evidence, destination: CONTACT_A });

    expect(projection.mode).toBe('collapsed_private');
    expect(projection.collapsed).toBe(true);
    expect(projection.eligibleEntries).toHaveLength(0);
  });

  it('drops an entry above the destination auto-shareable ceiling (no content leak beyond ceiling)', () => {
    // invite_only_room ceiling is `personal`; a `confidential` entry, even when
    // the room is permitted, must not auto-release — it is dropped.
    const evidence: ReturnNoteEvidenceItem[] = [
      {
        entry: entry(1, 'confidential room note'),
        lineage: lineage({
          ref: 'mem:secret',
          sensitivity: 'confidential',
          permittedDestinations: [{ kind: 'invite_only_room', channelIds: ['room-1'] }],
        }),
      },
    ];

    const projection = projectReturnNoteEvidence({ evidence, destination: ROOM });

    expect(projection.mode).toBe('collapsed_private');
    expect(projection.collapsed).toBe(true);
    expect(projection.eligibleEntries).toHaveLength(0);
  });

  it('collapses on an empty evidence set for an outward destination', () => {
    const projection = projectReturnNoteEvidence({ evidence: [], destination: CONTACT_A });
    expect(projection.mode).toBe('collapsed_private');
    expect(projection.collapsed).toBe(true);
  });
});

// ── Per-destination projection matrix (mixed eligibility) ────────────────────

describe('projectReturnNoteEvidence — per-destination matrix', () => {
  const mixed: ReturnNoteEvidenceItem[] = [
    {
      entry: entry(1, 'shareable-to-A personal note'),
      lineage: lineage({
        ref: 'mem:a',
        sensitivity: 'personal',
        permittedDestinations: [
          { kind: 'contact_dm', contactIds: ['contact-a'] },
          { kind: 'invite_only_room', channelIds: ['room-1'] },
        ],
        subjectContactIds: ['contact-a'],
      }),
    },
    {
      entry: entry(2, 'public room-safe note'),
      lineage: lineage({
        ref: 'mem:pub',
        sensitivity: 'public',
        permittedDestinations: [
          { kind: 'invite_only_room', channelIds: ['room-1'] },
          { kind: 'contact_dm', contactIds: ['contact-a'] },
        ],
        subjectContactIds: ['contact-a'],
      }),
    },
    {
      entry: entry(3, 'private-only note'),
      lineage: lineage({
        ref: 'mem:priv',
        sensitivity: 'confidential',
        permittedDestinations: [{ kind: 'companion_self' }],
      }),
    },
  ];

  it('contact_dm A: keeps both A-permitted entries, drops the private-only one', () => {
    const projection = projectReturnNoteEvidence({ evidence: mixed, destination: CONTACT_A });
    expect(projection.mode).toBe('content');
    expect(projection.eligibleEntries.map(e => e.id)).toEqual([1, 2]);
  });

  it('invite_only_room: keeps only entries at/below the personal ceiling that permit the room', () => {
    const projection = projectReturnNoteEvidence({ evidence: mixed, destination: ROOM });
    expect(projection.mode).toBe('content');
    // entry 1 (personal, room-permitted) and entry 2 (public, room-permitted)
    // survive; entry 3 (private-only) is dropped.
    expect(projection.eligibleEntries.map(e => e.id)).toEqual([1, 2]);
  });

  it('companion_self: full fidelity keeps all three entries', () => {
    const projection = projectReturnNoteEvidence({ evidence: mixed, destination: SELF });
    expect(projection.mode).toBe('content');
    expect(projection.eligibleEntries.map(e => e.id)).toEqual([1, 2, 3]);
  });
});
