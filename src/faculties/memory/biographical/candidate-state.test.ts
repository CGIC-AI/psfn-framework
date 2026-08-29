import { describe, expect, it } from 'vitest';

import { InMemoryBiographicalProfileStore } from './in-memory-store.js';
import type {
  BiographicalCandidateReceiptInput,
  BiographicalCandidateTransitionInput,
} from './store-port.js';
import type { BiographicalCandidatePolicy } from '../../../system/config/biographical-candidate-policy.js';

const NOW = new Date('2026-08-28T12:00:00.000Z');
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);

const POLICY: BiographicalCandidatePolicy = {
  schemaVersion: 1,
  admittedSourceTypes: ['semantic', 'episodic', 'reflection', 'relational'],
  maximumSourceSensitivity: 'personal',
  excludedLifecycleStates: [
    'quarantined',
    'tombstoned',
    'cogsec_blocked',
    'revoked',
    'superseded',
  ],
  budgets: {
    maxPendingCandidates: 100,
    maxCandidatesPerAutomataRun: 20,
    maxSourcesPerCandidate: 8,
    maxReviewReceiptsPerCandidate: 8,
  },
  reviewTriggers: [
    'human_subject',
    'inferred_basis',
    'imported_basis',
    'relational_claim',
    'sensitivity_lowering',
  ],
  companionOnlyAutoactivation: {
    enabled: true,
    scopes: ['companion_self'],
    admittedClaimKinds: ['name', 'nickname', 'role', 'stable-preference'],
    admittedBases: ['explicit'],
    maximumSensitivity: 'personal',
  },
  projectionScopes: [
    'companion_self',
    'current_author',
    'explicitly_relevant_subject',
  ],
};

function candidateInput() {
  return {
    policy: POLICY,
    automataRunId: 'automata-run-invented-1',
    automataAuthorityRef: 'automata:biography-synthesis',
    claim: {
      id: 'claim-invented-1',
      subject: { kind: 'contact' as const, contactId: 'contact-invented-1', subjectVersion: 1 },
      kind: 'role' as const,
      value: {
        kind: 'role' as const,
        schemaVersion: 1 as const,
        roleType: 'creative' as const,
        title: 'Illustrator',
      },
      basis: 'explicit' as const,
      proposedSensitivity: 'personal' as const,
      confidence: 0.9,
      validFrom: '2026-01-01T00:00:00.000Z',
      sources: [{
        ref: 'memory:invented-1',
        revision: '7',
        evidenceDigest: DIGEST_A,
        sensitivityAtProjection: 'personal' as const,
        subjectEvidenceDigest: DIGEST_B,
        consentFingerprint: DIGEST_C,
        sourceType: 'semantic' as const,
        lifecycleStateAtProjection: 'active' as const,
      }],
      now: NOW,
    },
  };
}

function receipt(
  authority: BiographicalCandidateReceiptInput['authority'],
  decision: BiographicalCandidateReceiptInput['decision'] = 'approved',
): BiographicalCandidateReceiptInput {
  return {
    authority,
    decision,
    actorAuthorityRef: `${authority}:invented-reviewer`,
  };
}

async function transition(
  store: InMemoryBiographicalProfileStore,
  input: Omit<BiographicalCandidateTransitionInput, 'now'>,
) {
  return await store.transitionCandidate({ ...input, now: NOW });
}

describe('restart-safe biography candidate stages', () => {
  it('requires exact revisions and the companion plus human receipts before activation', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const created = await store.writeCandidate(candidateInput());
    expect(created).toMatchObject({ revision: 1, stage: 'automata_synthesis' });
    expect((await store.getClaim(created.claimId))?.status).toBe('candidate');

    const companionQueue = await transition(store, {
      candidateId: created.id,
      expectedRevision: 1,
      to: 'companion_review',
      receipts: [receipt('automata')],
    });
    const humanQueue = await transition(store, {
      candidateId: created.id,
      expectedRevision: 2,
      to: 'human_review',
      receipts: [receipt('companion')],
    });
    expect(companionQueue.revision).toBe(2);
    expect(humanQueue.revision).toBe(3);

    await expect(transition(store, {
      candidateId: created.id,
      expectedRevision: 2,
      to: 'active',
      receipts: [receipt('human')],
    })).rejects.toThrow(/stale candidate revision/u);
    await expect(transition(store, {
      candidateId: created.id,
      expectedRevision: 3,
      to: 'active',
      receipts: [receipt('companion')],
    })).rejects.toThrow(/human.*receipt/u);

    const active = await transition(store, {
      candidateId: created.id,
      expectedRevision: 3,
      to: 'active',
      receipts: [receipt('human')],
    });
    expect(active).toMatchObject({ revision: 4, stage: 'active' });
    expect((await store.getClaim(created.claimId))?.status).toBe('active');
  });

  it('rejects illegal and unknown transitions without changing durable state', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const created = await store.writeCandidate(candidateInput());

    await expect(transition(store, {
      candidateId: created.id,
      expectedRevision: 1,
      to: 'active',
      receipts: [receipt('human')],
    })).rejects.toThrow(/illegal biography candidate transition/u);
    await expect(transition(store, {
      candidateId: created.id,
      expectedRevision: 1,
      to: 'unknown' as never,
      receipts: [receipt('automata')],
    })).rejects.toThrow(/unknown biography candidate stage/u);
    expect(await store.getCandidate(created.id)).toEqual(created);
  });

  it('allows only policy-receipted companion-self autoactivation', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const input = candidateInput();
    const created = await store.writeCandidate({
      ...input,
      claim: {
        ...input.claim,
        id: 'claim-invented-self',
        subject: { kind: 'companion', companionId: 'companion-invented', subjectVersion: 1 },
        kind: 'nickname',
        value: { kind: 'nickname', nickname: 'Moth', scope: 'self' },
        proposedSensitivity: 'public',
        sources: [{ ...input.claim.sources[0], sensitivityAtProjection: 'public' }],
        validFrom: undefined,
      },
    });
    await transition(store, {
      candidateId: created.id,
      expectedRevision: 1,
      to: 'companion_review',
      receipts: [receipt('automata')],
    });
    const active = await transition(store, {
      candidateId: created.id,
      expectedRevision: 2,
      to: 'active',
      receipts: [receipt('companion'), receipt('owner_policy')],
      policy: POLICY,
    });
    expect(active.stage).toBe('active');
  });

  it.each([
    { field: 'source type', source: { sourceType: 'emotional' } },
    { field: 'sensitivity', source: { sensitivityAtProjection: 'intimate' } },
    { field: 'lifecycle', source: { lifecycleStateAtProjection: 'quarantined' } },
    { field: 'unknown', source: { sourceType: 'model_invented' } },
  ])('fails closed on excluded or $field source values', async ({ source }) => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const input = candidateInput();
    await expect(store.writeCandidate({
      ...input,
      claim: {
        ...input.claim,
        sources: [{ ...input.claim.sources[0], ...source } as never],
      },
    })).rejects.toThrow(/(candidate source|sources\[0\]).*(type|sensitivity|lifecycle)/u);
  });
});
