import { describe, expect, it } from 'vitest';

import { createDefaultBiographicalCandidatePolicy } from '../../../system/config/biographical-candidate-policy.js';
import { InMemoryBiographicalProfileStore } from './in-memory-store.js';
import { recordCompanionPortabilityChoice } from './portability-choice.js';
import type { BiographicalSubjectRef } from './types.js';

const NOW = new Date('2026-09-24T12:00:00.000Z');
const SELF: BiographicalSubjectRef = { kind: 'companion', companionId: 'companion-invented', subjectVersion: 1 };
const ENABLED = {
  ...createDefaultBiographicalCandidatePolicy(),
  companionPortabilityChoice: { enabled: true, maximumSensitivity: 'personal' as const },
};

function source(ref: string, sensitivity: 'personal' | 'intimate') {
  return {
    ref,
    revision: NOW.toISOString(),
    evidenceDigest: 'a'.repeat(64),
    sensitivityAtProjection: sensitivity,
    subjectEvidenceDigest: 'a'.repeat(64),
    consentFingerprint: 'a'.repeat(64),
    sourceChannelId: 'channel-invented',
  };
}

describe('companion portability choice', () => {
  it('refuses unknown, inactive, and intimate claims before any write', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    await expect(recordCompanionPortabilityChoice({ store, policy: ENABLED, claimId: 'missing' }))
      .rejects.toMatchObject({ reason: 'claim_not_found' });
    const proposed = await store.writeClaim({
      subject: SELF,
      kind: 'nickname',
      value: { kind: 'nickname', nickname: 'Proposed', scope: 'self' },
      basis: 'explicit',
      status: 'candidate',
      confidence: 1,
      sources: [source('memory:proposed', 'personal')],
      now: NOW,
    });
    await expect(recordCompanionPortabilityChoice({ store, policy: ENABLED, claimId: proposed.id }))
      .rejects.toMatchObject({ reason: 'claim_not_active' });
    const intimate = await store.writeClaim({
      subject: SELF,
      kind: 'nickname',
      value: { kind: 'nickname', nickname: 'Only in the dark', scope: 'self' },
      basis: 'explicit',
      status: 'active',
      confidence: 1,
      sources: [source('memory:intimate', 'intimate')],
      now: NOW,
    });
    await expect(recordCompanionPortabilityChoice({ store, policy: ENABLED, claimId: intimate.id }))
      .rejects.toMatchObject({ reason: 'sensitivity_above_ceiling' });
    expect((await store.getClaim(intimate.id))?.portabilityScope).toBe('origin_only');
  });
});
