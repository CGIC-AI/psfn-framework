import { describe, expect, it } from 'vitest';

import { InMemoryBiographicalProfileStore } from './in-memory-store.js';
import {
  deterministicSelfNicknameSynthesizer,
  ingestSelfNicknameEvidence,
  selfNicknameCandidateFingerprint,
  type SelfNicknameEvidence,
  type SelfNicknameSynthesizer,
} from './ingest.js';
import type {
  BiographicalClaimSource,
  BiographicalSubjectRef,
} from './types.js';

const SHA = 'a'.repeat(64);
const NOW = new Date('2026-08-10T12:00:00.000Z');

function companion(id = 'purrs'): BiographicalSubjectRef {
  return { kind: 'companion', companionId: id, subjectVersion: 1 };
}

function source(
  ref: string,
  overrides: Partial<BiographicalClaimSource> = {},
): BiographicalClaimSource {
  return {
    ref,
    revision: '2026-08-10T10:00:00.000Z',
    evidenceDigest: SHA,
    sensitivityAtProjection: 'personal',
    subjectEvidenceDigest: SHA,
    consentFingerprint: SHA,
    sourceChannelId: 'dm:with-v',
    ...overrides,
  };
}

function evidence(overrides: Partial<SelfNicknameEvidence> = {}): SelfNicknameEvidence {
  return {
    companionSubject: companion(),
    nickname: 'Sunbeam loaf',
    sources: [source('memory:m-1')],
    confidence: 0.9,
    ...overrides,
  };
}

function store() {
  return new InMemoryBiographicalProfileStore(() => NOW);
}

describe('ingestSelfNicknameEvidence — automatic sensitivity follows max live source', () => {
  it('defaults a self nickname learned in a personal DM to personal', async () => {
    const s = store();
    const result = await ingestSelfNicknameEvidence({ store: s, evidence: evidence() });
    expect(result.status).toBe('created');
    expect(result.claim.effectiveSensitivity).toBe('personal');
    expect(result.claim.value).toEqual({ kind: 'nickname', nickname: 'Sunbeam loaf', scope: 'self' });
  });

  it('raises automatic sensitivity to an intimate source and never widens below it', async () => {
    const s = store();
    const result = await ingestSelfNicknameEvidence({
      store: s,
      evidence: evidence({
        nickname: 'Pet',
        sources: [source('memory:m-1', { sensitivityAtProjection: 'intimate' })],
      }),
    });
    expect(result.claim.effectiveSensitivity).toBe('intimate');
  });

  it('takes the maximum across multiple live sources', async () => {
    const s = store();
    const result = await ingestSelfNicknameEvidence({
      store: s,
      evidence: evidence({
        nickname: 'Pet',
        sources: [
          source('memory:m-1', { sensitivityAtProjection: 'personal' }),
          source('memory:m-2', { sensitivityAtProjection: 'confidential' }),
        ],
      }),
    });
    expect(result.claim.effectiveSensitivity).toBe('confidential');
  });
});

describe('ingestSelfNicknameEvidence — many nicknames coexist', () => {
  it('preserves zero, one, or many normalized nickname claims independently', async () => {
    const s = store();
    const a = await ingestSelfNicknameEvidence({ store: s, evidence: evidence({ nickname: 'Sunbeam loaf' }) });
    const b = await ingestSelfNicknameEvidence({ store: s, evidence: evidence({ nickname: 'Sunny' }) });
    const c = await ingestSelfNicknameEvidence({ store: s, evidence: evidence({ nickname: 'Little moon' }) });

    expect([a.status, b.status, c.status]).toEqual(['created', 'created', 'created']);
    const active = await s.listClaims({ subject: companion(), kind: 'nickname', status: 'active' });
    expect(active.map(x => (x.value as { nickname: string }).nickname).sort())
      .toEqual(['Little moon', 'Sunbeam loaf', 'Sunny']);
    // Each is independently digest-bound.
    const digests = new Set(active.map(x => x.claimDigest));
    expect(digests.size).toBe(3);
  });
});

describe('ingestSelfNicknameEvidence — deterministic change gate', () => {
  it('makes no synthesis call and writes nothing when evidence is unchanged', async () => {
    const s = store();
    await ingestSelfNicknameEvidence({ store: s, evidence: evidence() });

    let calls = 0;
    const counting: SelfNicknameSynthesizer = async e => {
      calls += 1;
      return deterministicSelfNicknameSynthesizer(e);
    };
    const result = await ingestSelfNicknameEvidence({
      store: s,
      evidence: evidence(),
      synthesize: counting,
    });
    expect(result.status).toBe('unchanged');
    expect(calls).toBe(0);
    const active = await s.listClaims({ subject: companion(), kind: 'nickname', status: 'active' });
    expect(active).toHaveLength(1);
  });

  it('opens the gate (calls synthesis) for genuinely new evidence', async () => {
    const s = store();
    await ingestSelfNicknameEvidence({ store: s, evidence: evidence() });

    let calls = 0;
    const counting: SelfNicknameSynthesizer = async e => {
      calls += 1;
      return deterministicSelfNicknameSynthesizer(e);
    };
    const result = await ingestSelfNicknameEvidence({
      store: s,
      evidence: evidence({ nickname: 'Sunny' }),
      synthesize: counting,
    });
    expect(result.status).toBe('created');
    expect(calls).toBe(1);
  });

  it('append-only supersedes when the same nickname recurs over drifted sources', async () => {
    const s = store();
    const first = await ingestSelfNicknameEvidence({ store: s, evidence: evidence() });
    const firstId = first.claim.id;

    // Same nickname, but a NEW source revision → different source-set digest.
    const drifted = evidence({
      sources: [source('memory:m-1', { revision: '2026-08-10T11:00:00.000Z' })],
    });
    let calls = 0;
    const result = await ingestSelfNicknameEvidence({
      store: s,
      evidence: drifted,
      synthesize: async e => {
        calls += 1;
        return deterministicSelfNicknameSynthesizer(e);
      },
    });
    expect(result.status).toBe('superseded');
    expect(calls).toBe(1);
    expect(result.superseded?.id).toBe(firstId);
    expect(result.superseded?.status).toBe('superseded');
    expect(result.claim.status).toBe('active');
    // History is preserved; the prior terminal row is still readable.
    const prior = await s.getClaim(firstId);
    expect(prior?.status).toBe('superseded');
  });

  it('rejects a non-companion subject', async () => {
    const s = store();
    await expect(
      ingestSelfNicknameEvidence({
        store: s,
        evidence: {
          ...evidence(),
          companionSubject: { kind: 'contact', contactId: 'v', subjectVersion: 1 },
        },
      }),
    ).rejects.toThrow(/companion self subject/u);
  });
});

describe('selfNicknameCandidateFingerprint — digest stability', () => {
  it('is stable for identical canonical content and source ordering', () => {
    const a = selfNicknameCandidateFingerprint(evidence());
    const b = selfNicknameCandidateFingerprint(evidence());
    expect(a).toEqual(b);
  });

  it('changes the source-set digest (not the claim digest) when a source drifts', () => {
    const base = selfNicknameCandidateFingerprint(evidence());
    const drifted = selfNicknameCandidateFingerprint(
      evidence({ sources: [source('memory:m-1', { revision: '2026-08-10T11:00:00.000Z' })] }),
    );
    expect(drifted.claimDigest).toBe(base.claimDigest);
    expect(drifted.sourceSetDigest).not.toBe(base.sourceSetDigest);
  });
});
