import { describe, expect, it } from 'vitest';
import {
  guardSharedWorldWikiProposal,
  type SharedWorldWikiProposalInput,
  type SharedWorldWikiRejectionCode,
} from './shared-world-caretaker-types.js';

const knownSite = (siteId: string): boolean => siteId === 'studio';

function validProposal(): SharedWorldWikiProposalInput {
  return {
    siteId: 'studio',
    actorId: 'companion-a',
    sourceRef: 'world-observation:turn-7',
    title: 'Kitchen toaster',
    body: 'A toaster is installed on the kitchen counter.',
    tags: ['Kitchen', 'appliance'],
    provenanceRefs: ['world-observation:sensor-4'],
    sensitivity: 'public',
  };
}

interface SharedWorldWikiGuardRejectionCase {
  input: SharedWorldWikiProposalInput;
  rejectionCode: Exclude<SharedWorldWikiRejectionCode, 'operator_rejected'>;
}

const REJECTION_CASES = [
  { input: { ...validProposal(), siteId: 'unknown' }, rejectionCode: 'invalid_site' },
  { input: { ...validProposal(), siteId: '../studio' }, rejectionCode: 'invalid_site' },
  {
    input: { ...validProposal(), sensitivity: 'personal' },
    rejectionCode: 'non_public_sensitivity',
  },
  { input: { ...validProposal(), provenanceRefs: [] }, rejectionCode: 'missing_provenance' },
  {
    input: { ...validProposal(), provenanceRefs: ['memory:private-7'] },
    rejectionCode: 'personal_memory_provenance',
  },
  {
    input: { ...validProposal(), sourceRef: 'episode:private-8' },
    rejectionCode: 'personal_memory_provenance',
  },
  {
    input: { ...validProposal(), body: 'My partner bought a toaster for the kitchen.' },
    rejectionCode: 'personal_fact_content',
  },
] satisfies readonly SharedWorldWikiGuardRejectionCase[];

describe('shared-world wiki proposal guard', () => {
  it('normalizes a public world fact and creates a deterministic content digest', () => {
    const first = guardSharedWorldWikiProposal(validProposal(), knownSite);
    const second = guardSharedWorldWikiProposal({
      ...validProposal(),
      actorId: 'companion-b',
      sourceRef: 'world-observation:turn-8',
      provenanceRefs: ['world-observation:sensor-9'],
    }, knownSite);

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    if (!first.accepted || !second.accepted) return;
    expect(first.proposal).toMatchObject({
      siteId: 'studio',
      documentId: 'kitchen-toaster',
      sensitivity: 'public',
      tags: ['kitchen', 'appliance'],
    });
    expect(first.proposal.body).toMatch(/\n$/u);
    // Equivalent content from two companions dedups; actor/provenance remain
    // audit fields on the first durable proposal, not digest inputs.
    expect(first.proposal.contentDigest).toBe(second.proposal.contentDigest);
  });

  it.each(REJECTION_CASES)(
    'rejects guarded input without producing a queueable proposal',
    ({ input, rejectionCode }) => {
      expect(guardSharedWorldWikiProposal(input, knownSite)).toEqual({
        accepted: false,
        rejectionCode,
      });
    },
  );
});
