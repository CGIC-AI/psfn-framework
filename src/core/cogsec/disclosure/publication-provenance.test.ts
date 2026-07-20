import { describe, expect, it } from 'vitest';
import { buildShareCandidate } from './capsule.js';
import {
  classifyProvenanceSourceRef,
  projectPublicationProvenance,
} from './publication-provenance.js';

describe('classifyProvenanceSourceRef', () => {
  it('classifies refs by durable prefix, defaulting to other', () => {
    expect(classifyProvenanceSourceRef('memory:abc')).toBe('memory');
    expect(classifyProvenanceSourceRef('session:dm:contact-1')).toBe('conversation');
    expect(classifyProvenanceSourceRef('project:p1:artifact-2')).toBe('project');
    expect(classifyProvenanceSourceRef('wiki:doc-9')).toBe('project');
    expect(classifyProvenanceSourceRef('tool:web_search:call-3')).toBe('tool');
    expect(classifyProvenanceSourceRef('something-else')).toBe('other');
  });
});

describe('projectPublicationProvenance', () => {
  it('returns null for a non-publication confirmation (e.g. artifact.share params)', () => {
    const params = {
      artifactRefs: ['fingerprint-1'],
      artifactCount: 1,
      sensitivity: 'personal',
      classificationFingerprint: 'fp',
      destination: { channelId: 'c1', channelType: 'discord', surface: 'conversation' },
    };
    expect(projectPublicationProvenance(params)).toBeNull();
  });

  it('returns null for non-record params', () => {
    expect(projectPublicationProvenance(null)).toBeNull();
    expect(projectPublicationProvenance(undefined)).toBeNull();
    expect(projectPublicationProvenance('nope')).toBeNull();
    expect(projectPublicationProvenance(42)).toBeNull();
    expect(projectPublicationProvenance([])).toBeNull();
  });

  it('projects a top-level ShareCandidate into a content-free provenance view', () => {
    const candidate = buildShareCandidate({
      candidateId: 'cand-1',
      content: { body: 'a private reflection', mediaRefs: [] },
      proposedDestinations: [{ kind: 'publication' }, { kind: 'contact_dm', contactIds: ['contact-7'] }],
      effectiveSensitivity: 'intimate',
      provenanceRefs: ['memory:m1', 'session:dm:contact-7', 'tool:web:call-2', 'weird-ref'],
      subjectContactIds: ['contact-7'],
      createdAt: '2026-07-19T00:00:00.000Z',
    });

    const view = projectPublicationProvenance(candidate as unknown);
    expect(view).not.toBeNull();
    const prov = view!;
    expect(prov.isPublicationCandidate).toBe(true);
    expect(prov.malformed).toBe(false);
    expect(prov.candidateId).toBe('cand-1');
    expect(prov.contentHash).toBe(candidate.contentHash);
    expect(prov.effectiveSensitivity).toBe('intimate');
    expect(prov.status.effectiveSensitivity).toBe('present');

    // Content-free: the view never carries the candidate body.
    expect(JSON.stringify(prov)).not.toContain('a private reflection');

    // Admitted-source list classified by kind.
    expect(prov.status.sources).toBe('present');
    expect(prov.sourceCount).toBe(4);
    expect(prov.sources.map(s => s.kind)).toEqual(['memory', 'conversation', 'tool', 'other']);
    expect(prov.sources.every(s => s.sensitivity === 'unknown')).toBe(true);
    expect(prov.sourceKindCounts).toEqual([
      { kind: 'memory', count: 1 },
      { kind: 'conversation', count: 1 },
      { kind: 'tool', count: 1 },
      { kind: 'other', count: 1 },
    ]);

    expect(prov.status.subjectContactIds).toBe('present');
    expect(prov.subjectContactIds).toEqual(['contact-7']);

    expect(prov.status.destinations).toBe('present');
    expect(prov.destinations).toEqual([
      { kind: 'publication', channelIds: [], contactIds: [] },
      { kind: 'contact_dm', channelIds: [], contactIds: ['contact-7'] },
    ]);
  });

  it('reads a nested shareCandidate key from confirmation params', () => {
    const candidate = buildShareCandidate({
      candidateId: 'cand-2',
      content: { body: 'body', mediaRefs: [] },
      proposedDestinations: [{ kind: 'publication' }],
      effectiveSensitivity: 'public',
      provenanceRefs: ['memory:m2'],
      subjectContactIds: [],
      createdAt: '2026-07-19T00:00:00.000Z',
    });
    const view = projectPublicationProvenance({ shareCandidate: candidate });
    expect(view).not.toBeNull();
    expect(view!.candidateId).toBe('cand-2');
    expect(view!.sources.map(s => s.ref)).toEqual(['memory:m2']);
  });

  it('reads per-source sensitivity/subject/classified from a DisclosureLineage sourceSnapshots carrier', () => {
    const disclosureProvenance = {
      effectiveSensitivity: 'confidential',
      subjectContactIds: ['contact-9'],
      permittedDestinations: [{ kind: 'invite_only_room', channelIds: ['room-1'] }],
      sourceCount: 2,
      hasUnclassifiedSource: true,
      sourceSnapshots: [
        {
          ref: 'memory:m3',
          sensitivity: 'intimate',
          subjectContactIds: ['contact-9'],
          classified: true,
        },
        {
          ref: 'tool:web:call-1',
          sensitivity: 'confidential',
          subjectContactIds: [],
          classified: false,
        },
      ],
    };
    const view = projectPublicationProvenance({ disclosureProvenance });
    expect(view).not.toBeNull();
    const prov = view!;
    expect(prov.malformed).toBe(false);
    expect(prov.effectiveSensitivity).toBe('confidential');
    expect(prov.sourceCount).toBe(2);
    expect(prov.hasUnclassifiedSource).toBe(true);
    expect(prov.sources).toEqual([
      { ref: 'memory:m3', kind: 'memory', sensitivity: 'intimate', subjectContactIds: ['contact-9'], classified: true },
      { ref: 'tool:web:call-1', kind: 'tool', sensitivity: 'confidential', subjectContactIds: [], classified: false },
    ]);
    expect(prov.destinations).toEqual([
      { kind: 'invite_only_room', channelIds: ['room-1'], contactIds: [] },
    ]);
  });

  it('derives hasUnclassifiedSource from snapshots when not explicitly carried', () => {
    const view = projectPublicationProvenance({
      disclosureProvenance: {
        effectiveSensitivity: 'personal',
        subjectContactIds: [],
        sourceSnapshots: [
          { ref: 'memory:m1', sensitivity: 'personal', subjectContactIds: [], classified: false },
        ],
      },
    });
    expect(view!.hasUnclassifiedSource).toBe(true);
  });

  it('fails closed to a malformed view when a keyed provenance object is not a record', () => {
    const view = projectPublicationProvenance({ shareCandidate: 'garbled' });
    expect(view).not.toBeNull();
    const prov = view!;
    expect(prov.malformed).toBe(true);
    expect(prov.candidateId).toBeNull();
    expect(prov.contentHash).toBeNull();
    expect(prov.effectiveSensitivity).toBe('unknown');
    expect(prov.sourceCount).toBe('unknown');
    expect(prov.sources).toEqual([]);
    expect(prov.status).toEqual({
      sources: 'unknown',
      subjectContactIds: 'unknown',
      effectiveSensitivity: 'unknown',
      destinations: 'unknown',
    });
  });

  it('degrades individual malformed dimensions to unknown without discarding the candidate', () => {
    // schemaVersion marks a publication candidate even though every provenance
    // field is malformed — the operator must still see it is a candidate.
    const view = projectPublicationProvenance({
      schemaVersion: 1,
      candidateId: 'cand-x',
      effectiveSensitivity: 'not-a-level',
      provenanceRefs: 'not-an-array',
      subjectContactIds: [42],
      proposedDestinations: [{ kind: 'no_such_kind' }],
    });
    expect(view).not.toBeNull();
    const prov = view!;
    expect(prov.malformed).toBe(false);
    expect(prov.candidateId).toBe('cand-x');
    expect(prov.effectiveSensitivity).toBe('unknown');
    expect(prov.status.effectiveSensitivity).toBe('unknown');
    expect(prov.status.sources).toBe('unknown');
    expect(prov.sourceCount).toBe('unknown');
    expect(prov.status.subjectContactIds).toBe('unknown');
    expect(prov.status.destinations).toBe('unknown');
    expect(prov.hasUnclassifiedSource).toBe('unknown');
  });

  it('marks an empty-but-present provenance object without fabricating data', () => {
    const view = projectPublicationProvenance({
      disclosureProvenance: {
        provenanceRefs: [],
        subjectContactIds: [],
        proposedDestinations: [],
      },
    });
    expect(view).not.toBeNull();
    const prov = view!;
    expect(prov.malformed).toBe(false);
    expect(prov.status.sources).toBe('present');
    expect(prov.sources).toEqual([]);
    expect(prov.sourceCount).toBe(0);
    expect(prov.effectiveSensitivity).toBe('unknown');
    expect(prov.status.effectiveSensitivity).toBe('unknown');
  });
});
