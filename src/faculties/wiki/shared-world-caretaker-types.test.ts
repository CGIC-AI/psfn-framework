import { describe, expect, it } from 'vitest';
import { guardSharedWorldWikiProposal } from './shared-world-caretaker-types.js';

const knownSite = (siteId: string): boolean => siteId === 'studio';

function validProposal() {
  return {
    siteId: 'studio',
    actorId: 'companion-a',
    sourceRef: 'world-observation:turn-7',
    title: 'Kitchen toaster',
    body: 'A toaster is installed on the kitchen counter.',
    tags: ['Kitchen', 'appliance'],
    provenanceRefs: ['world-observation:sensor-4'],
    sensitivity: 'public' as const,
  };
}

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

  it.each([
    [{ ...validProposal(), siteId: 'unknown' }, 'invalid_site'],
    [{ ...validProposal(), siteId: '../studio' }, 'invalid_site'],
    [{ ...validProposal(), sensitivity: 'personal' as const }, 'non_public_sensitivity'],
    [{ ...validProposal(), provenanceRefs: [] }, 'missing_provenance'],
    [{ ...validProposal(), provenanceRefs: ['memory:private-7'] }, 'personal_memory_provenance'],
    [{ ...validProposal(), sourceRef: 'episode:private-8' }, 'personal_memory_provenance'],
    [{ ...validProposal(), body: 'My partner bought a toaster for the kitchen.' }, 'personal_fact_content'],
  ])('rejects guarded input without producing a queueable proposal', (input, rejectionCode) => {
    expect(guardSharedWorldWikiProposal(input, knownSite)).toEqual({ accepted: false, rejectionCode });
  });
});
