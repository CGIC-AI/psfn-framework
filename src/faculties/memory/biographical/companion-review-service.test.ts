import { describe, expect, it } from 'vitest';

import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import { normalizeBiographicalCandidatePolicy } from '../../../system/config/biographical-candidate-policy.js';
import type { BiographicalCandidatePolicy } from '../../../system/config/biographical-candidate-policy.js';
import { BiographyCompanionReviewService } from './companion-review-service.js';
import { InMemoryBiographicalProfileStore } from './in-memory-store.js';
import type {
  BiographicalCandidateRecord,
  BiographicalCandidateSocialContext,
  BiographicalClaimSource,
  BiographicalSubjectRef,
} from './types.js';

const NOW = new Date('2026-03-01T00:00:00.000Z');
const COMPANION_ID = 'companion-invented';
const OTHER_COMPANION_ID = 'companion-invented-other';
const CONTACT_ID = 'contact-invented';

const COMPANION: Extract<BiographicalSubjectRef, { kind: 'companion' }> = {
  kind: 'companion',
  companionId: COMPANION_ID,
  subjectVersion: 1,
};
const CONTACT: Extract<BiographicalSubjectRef, { kind: 'contact' }> = {
  kind: 'contact',
  contactId: CONTACT_ID,
  subjectVersion: 1,
};
const DYAD_CONTEXT: BiographicalCandidateSocialContext = {
  kind: 'companion_contact_dyad',
  companionId: COMPANION_ID,
  contactId: CONTACT_ID,
};
const SELF_CONTEXT: BiographicalCandidateSocialContext = {
  kind: 'companion_self',
  companionId: COMPANION_ID,
};

function policyWith(
  autoactivation: Partial<BiographicalCandidatePolicy['companionOnlyAutoactivation']> = {},
): BiographicalCandidatePolicy {
  return normalizeBiographicalCandidatePolicy({
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
    reviewTriggers: ['human_subject', 'relational_claim'],
    companionOnlyAutoactivation: {
      enabled: true,
      scopes: ['companion_self'],
      admittedClaimKinds: ['nickname', 'role', 'stable-preference'],
      admittedBases: ['explicit'],
      maximumSensitivity: 'personal',
      ...autoactivation,
    },
    projectionScopes: ['companion_self', 'current_author', 'explicitly_relevant_subject'],
  });
}

const POLICY = policyWith();
const DIGEST = 'b'.repeat(64);

function source(ref: string): BiographicalClaimSource {
  return {
    ref,
    revision: '3',
    evidenceDigest: DIGEST,
    sensitivityAtProjection: 'personal',
    subjectEvidenceDigest: DIGEST,
    consentFingerprint: DIGEST,
    sourceType: 'semantic',
    lifecycleStateAtProjection: 'active',
  };
}

function preferenceValue(target = 'concise explanations', polarity = 'prefers') {
  return {
    kind: 'stable-preference' as const,
    schemaVersion: 1 as const,
    domain: 'communication' as const,
    target,
    polarity: polarity as 'prefers',
  };
}

async function stageCandidate(input: {
  store: InMemoryBiographicalProfileStore;
  subject?: BiographicalSubjectRef;
  socialContext?: BiographicalCandidateSocialContext;
  policy?: BiographicalCandidatePolicy;
  refs?: readonly string[];
}): Promise<BiographicalCandidateRecord> {
  return await input.store.writeCandidate({
    automataRunId: 'biography-synthesis:invented',
    automataAuthorityRef: 'maintenance:biography-synthesis',
    policy: input.policy ?? POLICY,
    socialContext: input.socialContext ?? DYAD_CONTEXT,
    rationale: 'new_subject_claim',
    claim: {
      subject: input.subject ?? CONTACT,
      kind: 'stable-preference',
      value: preferenceValue(),
      basis: 'explicit',
      confidence: 0.9,
      sources: (input.refs ?? ['memory:invented-1']).map(source),
      now: NOW,
    },
  });
}

function model(
  responses: readonly unknown[],
  responseFor?: (prompt: string) => number,
): {
  port: LLMProviderPort;
  prompts: { system: string; user: string }[];
} {
  const prompts: { system: string; user: string }[] = [];
  let index = 0;
  const port = {
    complete: async (request: { systemPrompt?: string; messages?: { content: string }[] }) => {
      const user = request.messages?.map(message => message.content).join('\n') ?? '';
      prompts.push({ system: request.systemPrompt ?? '', user });
      const chosen = responseFor?.(user) ?? Math.min(index, responses.length - 1);
      const body = responses[chosen];
      index += 1;
      return {
        content: typeof body === 'string' ? body : JSON.stringify(body),
        model: 'test-model',
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  } as unknown as LLMProviderPort;
  return { port, prompts };
}

function buildService(input: {
  store: InMemoryBiographicalProfileStore;
  responses: readonly unknown[];
  companionId?: string;
  policy?: BiographicalCandidatePolicy;
  responseFor?: (prompt: string) => number;
}): {
  service: BiographyCompanionReviewService;
  prompts: { system: string; user: string }[];
} {
  const llm = model(input.responses, input.responseFor);
  return {
    service: new BiographyCompanionReviewService({
      profileStore: input.store,
      llmClient: llm.port,
      companionId: input.companionId ?? COMPANION_ID,
      candidatePolicy: () => input.policy ?? POLICY,
      now: () => NOW,
      newRunId: () => 'biography-review:test-run',
    }),
    prompts: llm.prompts,
  };
}

describe('BiographyCompanionReviewService', () => {
  it('escalates an approved human-derived candidate to human review, never to active', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const candidate = await stageCandidate({ store });
    const { service } = buildService({
      store,
      responses: [{ action: 'approve', reason: 'evidence_supports_claim' }],
    });

    const telemetry = await service.run();

    expect(telemetry).toMatchObject({
      approved: 1,
      escalatedToHumanReview: 1,
      autoactivated: 0,
    });
    const reviewed = await store.getCandidate(candidate.id);
    expect(reviewed?.stage).toBe('human_review');
    // No hidden activation: the claim is still not in the portable projection.
    expect((await store.getClaim(candidate.claimId))?.status).toBe('candidate');
    expect(reviewed?.receipts.filter(receipt => receipt.authority === 'companion')).toHaveLength(2);
    expect(reviewed?.receipts.some(receipt => receipt.reason === 'reviewer_approved')).toBe(true);
  });

  it('autoactivates only a companion-derived candidate the owner policy admits', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const candidate = await stageCandidate({
      store,
      subject: COMPANION,
      socialContext: SELF_CONTEXT,
    });
    const { service } = buildService({
      store,
      responses: [{ action: 'approve', reason: 'evidence_supports_claim' }],
    });

    const telemetry = await service.run();

    expect(telemetry).toMatchObject({ approved: 1, autoactivated: 1, escalatedToHumanReview: 0 });
    expect((await store.getCandidate(candidate.id))?.stage).toBe('active');
  });

  it('falls through to human review when owner policy does not admit the claim kind', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const restrictive = policyWith({ admittedClaimKinds: ['nickname'] });
    const candidate = await stageCandidate({
      store,
      subject: COMPANION,
      socialContext: SELF_CONTEXT,
      policy: restrictive,
    });
    const { service } = buildService({
      store,
      policy: restrictive,
      responses: [{ action: 'approve', reason: 'evidence_supports_claim' }],
    });

    const telemetry = await service.run();

    expect(telemetry).toMatchObject({ autoactivated: 0, escalatedToHumanReview: 1 });
    expect((await store.getCandidate(candidate.id))?.stage).toBe('human_review');
  });

  it('lets the companion refuse a proposal about itself', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const candidate = await stageCandidate({
      store,
      subject: COMPANION,
      socialContext: SELF_CONTEXT,
    });
    const { service } = buildService({
      store,
      responses: [{ action: 'reject', reason: 'evidence_does_not_support_claim' }],
    });

    const telemetry = await service.run();

    expect(telemetry).toMatchObject({ rejected: 1, autoactivated: 0 });
    const reviewed = await store.getCandidate(candidate.id);
    expect(reviewed?.stage).toBe('rejected');
    expect(reviewed?.receipts.some(receipt => (
      receipt.authority === 'companion'
      && receipt.decision === 'rejected'
      && receipt.reason === 'reviewer_rejected'
    ))).toBe(true);
  });

  it('routes a sensitive flag to a human and a fatal flag to rejection, never lowering the bar', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    // Companion-derived and otherwise autoactivatable: the flag must still win.
    const escalate = await stageCandidate({
      store,
      subject: COMPANION,
      socialContext: SELF_CONTEXT,
      refs: ['memory:invented-flag-1'],
    });
    const fatal = await stageCandidate({
      store,
      subject: COMPANION,
      socialContext: SELF_CONTEXT,
      refs: ['memory:invented-flag-2'],
    });
    const { service } = buildService({
      store,
      // Keyed on the bound evidence so the assertion does not depend on the
      // order the store returns two candidates staged in the same instant.
      responses: [
        { action: 'flag', flag: 'sensitive', reason: 'material_is_sensitive', forceRejection: false },
        { action: 'flag', flag: 'ambiguous', reason: 'material_is_ambiguous', forceRejection: true },
      ],
      responseFor: prompt => (prompt.includes('memory:invented-flag-1') ? 0 : 1),
    });

    const telemetry = await service.run();

    expect(telemetry).toMatchObject({ flagged: 2, autoactivated: 0, escalatedToHumanReview: 1 });
    expect((await store.getCandidate(escalate.id))?.stage).toBe('human_review');
    expect((await store.getCandidate(fatal.id))?.stage).toBe('rejected');
  });

  it('supersedes rather than mutates when the companion revises a proposal', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const candidate = await stageCandidate({ store });
    const { service } = buildService({
      store,
      responses: [{
        action: 'revise',
        reason: 'value_misread',
        proposals: [{
          kind: 'stable-preference',
          value: preferenceValue('worked examples'),
          basis: 'explicit',
          confidence: 0.8,
          sourceRefs: ['memory:invented-1'],
        }],
      }],
    });

    const telemetry = await service.run();

    expect(telemetry).toMatchObject({ revised: 1 });
    const all = await store.listCandidates({ limit: 10 });
    expect(all).toHaveLength(2);
    const original = all.find(record => record.id === candidate.id);
    const replacement = all.find(record => record.id !== candidate.id);
    // The original proposal, its receipts and its provenance survive intact.
    expect(original?.stage).toBe('superseded');
    expect(original?.claimDigest).toBe(candidate.claimDigest);
    expect(original?.receipts.some(receipt => receipt.reason === 'synthesized')).toBe(true);
    expect(original?.receipts.some(receipt => (
      receipt.authority === 'companion' && receipt.reason === 'reviewer_revised'
    ))).toBe(true);
    // The replacement records what changed and restarts downstream review.
    expect(replacement?.supersedesCandidateId).toBe(candidate.id);
    expect(replacement?.stage).toBe('companion_review');
    expect(replacement?.sourceSetDigest).toBe(candidate.sourceSetDigest);
  });

  it('splits one proposal into several and reassigns only within authorized contexts', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    await stageCandidate({ store, refs: ['memory:invented-1', 'memory:invented-2'] });
    const { service } = buildService({
      store,
      responses: [{
        action: 'split',
        reason: 'evidence_belongs_to_separate_claims',
        proposals: [
          {
            kind: 'stable-preference',
            value: preferenceValue('worked examples'),
            basis: 'explicit',
            confidence: 0.8,
            sourceRefs: ['memory:invented-1'],
          },
          {
            kind: 'stable-preference',
            value: preferenceValue('short answers'),
            basis: 'explicit',
            confidence: 0.8,
            sourceRefs: ['memory:invented-2'],
            socialContext: SELF_CONTEXT,
          },
        ],
      }],
    });

    await service.run();

    const all = await store.listCandidates({ limit: 10 });
    expect(all).toHaveLength(3);
    const replacements = all.filter(record => record.supersedesCandidateId !== undefined);
    expect(replacements).toHaveLength(2);
    expect(new Set(replacements.map(record => record.socialContext?.kind))).toEqual(
      new Set(['companion_contact_dyad', 'companion_self']),
    );
  });

  it('fails closed on wrong-companion, unbound-source and unauthorized-context attempts', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const candidate = await stageCandidate({ store });

    // Wrong companion: never reviewed, and never rendered into a prompt.
    const wrong = buildService({
      store,
      companionId: OTHER_COMPANION_ID,
      responses: [{ action: 'approve', reason: 'evidence_supports_claim' }],
    });
    const wrongTelemetry = await wrong.service.run();
    expect(wrongTelemetry).toMatchObject({ candidatesOutsideAuthority: 1, approved: 0 });
    expect(wrong.prompts).toHaveLength(0);
    expect((await store.getCandidate(candidate.id))?.stage).toBe('automata_synthesis');

    // A source the candidate never bound cannot be smuggled into a revision.
    const unbound = buildService({
      store,
      responses: [{
        action: 'revise',
        reason: 'value_misread',
        proposals: [{
          kind: 'stable-preference',
          value: preferenceValue('worked examples'),
          basis: 'explicit',
          confidence: 0.8,
          sourceRefs: ['memory:never-bound'],
        }],
      }],
    });
    expect(await unbound.service.run()).toMatchObject({ malformedDecisions: 1, revised: 0 });
    expect((await store.getCandidate(candidate.id))?.stage).toBe('automata_synthesis');

    // A social context outside the authorized set cannot be named.
    const foreign = buildService({
      store,
      responses: [{
        action: 'reassign',
        reason: 'wrong_social_context',
        proposals: [{
          kind: 'stable-preference',
          value: preferenceValue(),
          basis: 'explicit',
          confidence: 0.8,
          sourceRefs: ['memory:invented-1'],
          socialContext: {
            kind: 'companion_contact_dyad',
            companionId: COMPANION_ID,
            contactId: 'contact-invented-stranger',
          },
        }],
      }],
    });
    expect(await foreign.service.run()).toMatchObject({ malformedDecisions: 1 });
    expect(await store.listCandidates({ limit: 10 })).toHaveLength(1);
  });

  it('rejects an unknown action, an unknown reason, and a smuggled stage field', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    await stageCandidate({ store });
    for (const response of [
      { action: 'activate', reason: 'evidence_supports_claim' },
      { action: 'approve', reason: 'because I said so' },
      { action: 'approve', reason: 'evidence_supports_claim', stage: 'active' },
      { action: 'approve', reason: 'evidence_supports_claim', proposedSensitivity: 'public' },
      'not json at all',
    ]) {
      const { service } = buildService({ store, responses: [response] });
      expect(await service.run()).toMatchObject({ malformedDecisions: 1, approved: 0 });
    }
    expect((await store.listCandidates({ limit: 10 }))[0]?.stage).toBe('automata_synthesis');
  });

  it('replays its own decision instead of re-reviewing or duplicating a receipt', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const original = await stageCandidate({ store });
    const first = buildService({
      store,
      responses: [{
        action: 'revise',
        reason: 'value_misread',
        proposals: [{
          kind: 'stable-preference',
          value: preferenceValue('worked examples'),
          basis: 'explicit',
          confidence: 0.8,
          sourceRefs: ['memory:invented-1'],
        }],
      }],
    });
    await first.service.run();
    const replacement = (await store.listCandidates({ limit: 10 }))
      .find(record => record.id !== original.id);
    expect(replacement?.stage).toBe('companion_review');

    // The next pass still lists the companion's own replacement, and must
    // recognize its own receipt rather than reviewing its own work again.
    const retry = buildService({
      store,
      responses: [{ action: 'approve', reason: 'evidence_supports_claim' }],
    });
    const telemetry = await retry.service.run();

    expect(telemetry).toMatchObject({
      candidatesConsidered: 1,
      candidatesReplayed: 1,
      approved: 0,
    });
    expect(retry.prompts).toHaveLength(0);
    const afterRetry = await store.getCandidate(replacement!.id);
    expect(afterRetry?.revision).toBe(replacement?.revision);
    expect(afterRetry?.receipts).toHaveLength(replacement?.receipts.length ?? 0);
  });

  it('shows the reviewer evidence references and never a source body', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    await stageCandidate({ store });
    const { service, prompts } = buildService({
      store,
      responses: [{ action: 'approve', reason: 'evidence_supports_claim' }],
    });
    await service.run();

    const rendered = prompts.map(prompt => `${prompt.system}\n${prompt.user}`).join('\n');
    expect(rendered).toContain('memory:invented-1');
    expect(rendered).toContain('Derivation: human_derived');
    expect(rendered).toContain('Authorized contexts:');
    // The reviewer is told what it cannot do, in the prompt and in the schema.
    expect(rendered).toContain('I cannot make a proposal less sensitive');
    expect(rendered).toContain('bodies stay in their origin room');
  });
});
