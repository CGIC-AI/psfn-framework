import { describe, expect, it } from 'vitest';

import { InMemoryBiographicalProfileStore } from './in-memory-store.js';
import {
  projectBiographicalContext,
  destinationFromScope,
  destinationConstraint,
  renderSelfNicknameSection,
  type BiographicalSourceRevalidator,
  type SourceRevalidationOutcome,
  type TurnBiographicalContext,
} from './projection.js';
import { recordCompanionPublicationChoice } from './publication.js';
import { ingestSelfNicknameEvidence } from './ingest.js';
import {
  BIOGRAPHICAL_SOURCE_LIFECYCLE_REASONS,
  type BiographicalSourceLifecycleReason,
} from './rebuild-contracts.js';
import {
  createDmConversationScope,
  createGroupConversationScope,
  type ConversationScope,
} from '../../../core/session/conversation-scope.js';
import type { ContextEnvelope } from '../../../system/trust/context-envelope.js';
import type {
  BiographicalClaimSource,
  BiographicalSubjectRef,
} from './types.js';

const SHA = 'a'.repeat(64);
const NOW = new Date('2026-08-10T12:00:00.000Z');
const COMPANION: BiographicalSubjectRef = { kind: 'companion', companionId: 'purrs', subjectVersion: 1 };

function envelope(channelPrivacy: ContextEnvelope['channelPrivacy']): ContextEnvelope {
  return { channelPrivacy, audienceScope: 'few', audienceKnowledge: 'all_known', broadcast: false };
}

function publicGroup(channelId = 'group:public'): ConversationScope {
  return createGroupConversationScope({ channelId, envelope: envelope('public') });
}
function inviteOnlyGroup(channelId = 'group:invite'): ConversationScope {
  return createGroupConversationScope({ channelId, envelope: envelope('invite_only') });
}
function privateGroup(channelId = 'group:private'): ConversationScope {
  return createGroupConversationScope({ channelId, envelope: envelope('private') });
}
function dmWithV(channelId = 'dm:with-v'): ConversationScope {
  return createDmConversationScope({
    channelId,
    contact: { contactId: 'v' },
    envelope: envelope('private'),
  });
}

function source(ref: string, overrides: Partial<BiographicalClaimSource> = {}): BiographicalClaimSource {
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

class MemoryRevalidator implements BiographicalSourceRevalidator {
  private readonly current = new Map<string, BiographicalClaimSource>();
  private readonly invalid = new Map<string, BiographicalSourceLifecycleReason>();
  seed(sources: readonly BiographicalClaimSource[]): void {
    for (const s of sources) this.current.set(s.ref, s);
  }
  drift(ref: string, patch: Partial<BiographicalClaimSource>): void {
    const existing = this.current.get(ref);
    if (existing) this.current.set(ref, { ...existing, ...patch });
  }
  invalidate(ref: string, reason: BiographicalSourceLifecycleReason): void {
    this.invalid.set(ref, reason);
  }
  async revalidate(sources: readonly BiographicalClaimSource[]): Promise<SourceRevalidationOutcome> {
    const out: BiographicalClaimSource[] = [];
    for (const s of sources) {
      const reason = this.invalid.get(s.ref);
      if (reason !== undefined) return { status: 'invalid', reason, sourceRef: s.ref };
      const c = this.current.get(s.ref);
      if (!c) return { status: 'invalid', reason: 'missing', sourceRef: s.ref };
      out.push(c);
    }
    return { status: 'valid', currentSources: out };
  }
}

interface Harness {
  store: InMemoryBiographicalProfileStore;
  revalidator: MemoryRevalidator;
}

function harness(): Harness {
  return { store: new InMemoryBiographicalProfileStore(() => NOW), revalidator: new MemoryRevalidator() };
}

async function seed(h: Harness, nickname: string, ref: string) {
  const sources = [source(ref)];
  h.revalidator.seed(sources);
  return ingestSelfNicknameEvidence({
    store: h.store,
    evidence: {
      companionSubject: COMPANION,
      nickname,
      sources,
      confidence: 0.9,
      now: NOW,
    },
  });
}

async function publish(h: Harness, claimId: string, reason = 'publish') {
  return recordCompanionPublicationChoice({ store: h.store, choice: { claimId, reason, now: NOW } });
}

async function project(h: Harness, scope: ConversationScope, turn?: Partial<TurnBiographicalContext>) {
  return projectBiographicalContext(
    { store: h.store, revalidator: h.revalidator, rebuildQueueMaxPending: 8 },
    { companionSubject: COMPANION, conversationScope: scope, now: NOW, ...turn },
  );
}

describe('destinationFromScope / destinationConstraint — destination policy shapes', () => {
  it('maps each scope kind to its outward destination and constraint', () => {
    expect(destinationFromScope(publicGroup('group:public'))).toEqual({ kind: 'public_room', channelId: 'group:public' });
    expect(destinationFromScope(inviteOnlyGroup('group:invite'))).toEqual({ kind: 'invite_only_room', channelId: 'group:invite' });
    expect(destinationFromScope(privateGroup('group:private'))).toEqual({ kind: 'companion_self' });
    expect(destinationFromScope(dmWithV('dm:with-v'))).toEqual({ kind: 'contact_dm', contactId: 'v' });

    expect(destinationConstraint({ kind: 'public_room', channelId: 'group:public' }))
      .toEqual({ kind: 'public_room', channelIds: ['group:public'] });
    expect(destinationConstraint({ kind: 'contact_dm', contactId: 'v' }))
      .toEqual({ kind: 'contact_dm', contactIds: ['v'] });
    expect(destinationConstraint({ kind: 'companion_self' })).toBeNull();
  });
});

describe('projectBiographicalContext — public group (partner absent)', () => {
  it('projects only the exact nicknames the companion chose to publish', async () => {
    const h = harness();
    const a = await seed(h, 'Sunbeam loaf', 'memory:m-1');
    const b = await seed(h, 'Sunny', 'memory:m-2');
    await publish(h, a.claim.id);

    const result = await project(h, publicGroup());

    expect(result.admittedClaimIds).toEqual([a.claim.id]);
    expect(result.promptSection).toContain('Sunbeam loaf');
    expect(result.promptSection).not.toContain('Sunny');
    // The un-chosen nickname is withheld for the exact reason.
    expect(result.withheld).toContainEqual({
      claimId: b.claim.id,
      reason: 'no-publication-choice',
      detail: 'the companion has not recorded an exact publication choice lowering this nickname to public',
    });
  });

  it('approval of one nickname never authorizes another', async () => {
    const h = harness();
    const a = await seed(h, 'Sunbeam loaf', 'memory:m-1');
    const b = await seed(h, 'Sunny', 'memory:m-2');
    await publish(h, a.claim.id);

    const result = await project(h, publicGroup());
    expect(result.admittedClaimIds).toEqual([a.claim.id]);
    // The other claim remained personal despite the sibling grant.
    const refreshedB = await h.store.getClaim(b.claim.id);
    expect(refreshedB?.effectiveSensitivity).toBe('personal');
  });

  it('never lets raw private source references cross into the prompt', async () => {
    const h = harness();
    const a = await seed(h, 'Sunbeam loaf', 'memory:secret-dm-1');
    await publish(h, a.claim.id);

    const result = await project(h, publicGroup());
    expect(result.promptSection).not.toContain('memory:secret-dm-1');
    expect(result.promptSection).not.toContain('dm:with-v');
  });

  it('renders multiple approved nicknames in deterministic order with no canonical selection', async () => {
    const h = harness();
    const loaf = await seed(h, 'Sunbeam loaf', 'memory:m-1');
    const sunny = await seed(h, 'Sunny', 'memory:m-2');
    const moon = await seed(h, 'Little moon', 'memory:m-3');
    await publish(h, loaf.claim.id);
    await publish(h, sunny.claim.id);
    await publish(h, moon.claim.id);

    const result = await project(h, publicGroup());
    // All three approved nicknames render; none is selected as canonical.
    expect(result.admittedClaimIds).toHaveLength(3);
    const section = renderSelfNicknameSection(
      (await h.store.listClaims({ subject: COMPANION, kind: 'nickname', status: 'active' }))
        .filter(c => result.admittedClaimIds.includes(c.id)),
    );
    const loafPos = section.indexOf('Sunbeam loaf');
    const moonPos = section.indexOf('Little moon');
    const sunnyPos = section.indexOf('Sunny');
    // Deterministic ascending normalized order: little moon < sunbeam loaf < sunny.
    expect(moonPos).toBeLessThan(loafPos);
    expect(loafPos).toBeLessThan(sunnyPos);
  });

  it('admits nothing when the companion has chosen no public nicknames', async () => {
    const h = harness();
    await seed(h, 'Sunbeam loaf', 'memory:m-1');
    const result = await project(h, publicGroup());
    expect(result.admittedClaimIds).toEqual([]);
    expect(result.promptSection).toBe('');
    expect(result.disclosureSources).toEqual([]);
  });
});

describe('projectBiographicalContext — atomicity of prompt text and lineage', () => {
  it('every rendered nickname contributes sensitivity, destination, source, and grant refs', async () => {
    const h = harness();
    const a = await seed(h, 'Sunbeam loaf', 'memory:m-1');
    const grant = await publish(h, a.claim.id);

    const result = await project(h, publicGroup('group:public'));
    expect(result.disclosureSources).toHaveLength(1);
    const [contribution] = result.disclosureSources;
    expect(contribution.ref).toBe(`biographical:${a.claim.id}`);
    expect(contribution.sensitivity).toBe('public');
    expect(contribution.permittedDestinations).toEqual([
      { kind: 'public_room', channelIds: ['group:public'] },
    ]);
    expect(contribution.provenanceRefs).toContain(`biographical-claim:${a.claim.id}`);
    expect(contribution.provenanceRefs).toContain(`biographical-grant:${grant.id}`);
    expect(contribution.provenanceRefs).toContain('memory:m-1');
    expect(contribution.classified).toBe(true);
  });

  it('admittedClaimIds and disclosureSources are 1:1 (no prompt without lineage)', async () => {
    const h = harness();
    const a = await seed(h, 'Sunbeam loaf', 'memory:m-1');
    const b = await seed(h, 'Sunny', 'memory:m-2');
    await publish(h, a.claim.id);
    await publish(h, b.claim.id);

    const result = await project(h, publicGroup());
    expect(result.admittedClaimIds.length).toBe(result.disclosureSources.length);
    expect(result.disclosureSources.every(c => c.sensitivity === 'public')).toBe(true);
  });
});

describe('projectBiographicalContext — source revalidation fails closed', () => {
  it('withholds on source-drift and invalidates only the matching publication grant', async () => {
    const h = harness();
    const a = await seed(h, 'Sunbeam loaf', 'memory:m-1');
    const b = await seed(h, 'Sunny', 'memory:m-2');
    await publish(h, a.claim.id);
    await publish(h, b.claim.id);

    // Drift only the source backing nickname A.
    h.revalidator.drift('memory:m-1', { revision: '2026-08-10T11:00:00.000Z' });

    const result = await project(h, publicGroup());
    expect(result.admittedClaimIds).toEqual([b.claim.id]);
    expect(result.withheld).toContainEqual({
      claimId: a.claim.id,
      reason: 'source-drift',
      detail: 'source-set digest drifted and exact grants no longer apply',
      rebuildReason: 'source-set-drift',
      rebuildStatus: 'queued',
    });
    expect(result.promptSection).toContain('Sunny');
    expect(result.promptSection).not.toContain('Sunbeam loaf');
  });

  it('withholds on a missing source and queues rebuild', async () => {
    const h = harness();
    const a = await seed(h, 'Sunbeam loaf', 'memory:m-1');
    await publish(h, a.claim.id);
    h.revalidator.invalidate('memory:m-1', 'deleted');

    const result = await project(h, publicGroup());
    expect(result.admittedClaimIds).toEqual([]);
    expect(result.withheld).toContainEqual({
      claimId: a.claim.id,
      reason: 'source-invalid',
      detail: 'a source lifecycle check failed closed',
      sourceLifecycleReason: 'deleted',
      sourceRef: 'memory:m-1',
      rebuildReason: 'deleted',
      rebuildStatus: 'queued',
    });
    expect(await h.store.listRebuilds({ status: 'pending', limit: 8 })).toMatchObject([
      { claimId: a.claim.id, reason: 'deleted', sourceRef: 'memory:m-1', status: 'pending' },
    ]);
  });

  it.each(BIOGRAPHICAL_SOURCE_LIFECYCLE_REASONS.filter(reason =>
    reason !== 'sensitivity-increased'
    && reason !== 'sensitivity-decreased'
    && reason !== 'contact-archived'
    && reason !== 'contact-merged'
  ))('fails closed and queues the structured %s reason', async reason => {
    const h = harness();
    const a = await seed(h, 'Sunbeam loaf', 'memory:m-1');
    h.revalidator.invalidate('memory:m-1', reason);

    const result = await project(h, dmWithV());

    expect(result.admittedClaimIds).toEqual([]);
    expect(result.withheld[0]).toMatchObject({
      claimId: a.claim.id,
      reason: 'source-invalid',
      sourceLifecycleReason: reason,
      rebuildReason: reason,
      rebuildStatus: 'queued',
    });
    expect(await h.store.listRebuilds({ status: 'pending', limit: 8 })).toMatchObject([
      { claimId: a.claim.id, reason, status: 'pending' },
    ]);
  });

  it('tightens immediately when current source sensitivity increases', async () => {
    const h = harness();
    const a = await seed(h, 'Sunbeam loaf', 'memory:m-1');
    h.revalidator.drift('memory:m-1', { sensitivityAtProjection: 'confidential' });

    const result = await project(h, dmWithV());

    expect(result.admittedClaimIds).toEqual([]);
    expect(result.withheld).toContainEqual({
      claimId: a.claim.id,
      reason: 'source-drift',
      detail: 'source sensitivity increased and tightened access immediately',
      sourceLifecycleReason: 'sensitivity-increased',
      rebuildReason: 'sensitivity-increased',
      rebuildStatus: 'queued',
    });
  });

  it('does not auto-widen when current source sensitivity decreases', async () => {
    const h = harness();
    const originalSource = source('memory:m-1', { sensitivityAtProjection: 'confidential' });
    const claim = await h.store.writeClaim({
      subject: COMPANION,
      kind: 'nickname',
      value: { kind: 'nickname', nickname: 'Sunbeam loaf', scope: 'self' },
      basis: 'observed',
      status: 'active',
      confidence: 0.9,
      sources: [originalSource],
      now: NOW,
    });
    h.revalidator.seed([originalSource]);
    h.revalidator.drift('memory:m-1', { sensitivityAtProjection: 'public' });

    const result = await project(h, dmWithV());

    expect(result.admittedClaimIds).toEqual([]);
    expect(result.withheld).toContainEqual({
      claimId: claim.id,
      reason: 'source-drift',
      detail: 'source sensitivity decreased but access remains restricted pending audited rebuild',
      sourceLifecycleReason: 'sensitivity-decreased',
      rebuildReason: 'sensitivity-decreased',
      rebuildStatus: 'queued',
    });
  });
});

describe('projectBiographicalContext — destination policy', () => {
  it('projects personal self-nicknames in the origin DM without a publication grant', async () => {
    const h = harness();
    const a = await seed(h, 'Sunbeam loaf', 'memory:m-1');
    const result = await project(h, dmWithV());
    expect(result.admittedClaimIds).toEqual([a.claim.id]);
    expect(result.disclosureSources[0]?.sensitivity).toBe('personal');
    expect(result.disclosureSources[0]?.permittedDestinations).toEqual([
      { kind: 'contact_dm', contactIds: ['v'] },
    ]);
  });

  it('projects personal self-nicknames in an invite-only group', async () => {
    const h = harness();
    const a = await seed(h, 'Sunbeam loaf', 'memory:m-1');
    const result = await project(h, inviteOnlyGroup());
    expect(result.admittedClaimIds).toEqual([a.claim.id]);
    expect(result.disclosureSources[0]?.permittedDestinations).toEqual([
      { kind: 'invite_only_room', channelIds: ['group:invite'] },
    ]);
  });

  it('projects nothing outward in a private group', async () => {
    const h = harness();
    const a = await seed(h, 'Sunbeam loaf', 'memory:m-1');
    await publish(h, a.claim.id);
    const result = await project(h, privateGroup());
    expect(result.admittedClaimIds).toEqual([]);
    expect(destinationFromScope(privateGroup())).toEqual({ kind: 'companion_self' });
  });

  it('honors the prompt token budget by omitting lowest-priority claims last', async () => {
    const h = harness();
    const loaf = await seed(h, 'Sunbeam loaf', 'memory:m-1');
    const sunny = await seed(h, 'Sunny', 'memory:m-2');
    await publish(h, loaf.claim.id);
    await publish(h, sunny.claim.id);

    // Deterministic estimator: framing counts once, then each nickname line.
    // A budget admitting the framing plus exactly one line trims the second.
    const estimateTokens = (): number => 10;
    const result = await project(h, publicGroup(), { tokenBudget: 25, estimateTokens });
    expect(result.admittedClaimIds).toHaveLength(1);
    // Highest-priority (first in deterministic order) survives.
    expect(result.admittedClaimIds).toEqual([loaf.claim.id]);
    expect(result.withheld.some(w => w.reason === 'token-budget-exhausted')).toBe(true);
  });
});

describe('projectBiographicalContext — fail-closed guards', () => {
  it('rejects a non-companion subject', async () => {
    const h = harness();
    await expect(
      projectBiographicalContext(
        { store: h.store, revalidator: h.revalidator, rebuildQueueMaxPending: 8 },
        {
          companionSubject: { kind: 'contact', contactId: 'v', subjectVersion: 1 },
          conversationScope: publicGroup(),
          now: NOW,
        },
      ),
    ).rejects.toThrow(/companion self subject/u);
  });

  it('does not select relational self-nicknames (out of scope for this tracer)', async () => {
    const h = harness();
    // Write a relational nickname directly (the ingest tracer only emits self).
    await h.store.writeClaim({
      subject: COMPANION,
      relatedSubject: { kind: 'contact', contactId: 'v', subjectVersion: 1 },
      kind: 'nickname',
      value: { kind: 'nickname', nickname: 'Kitten', scope: 'relational' },
      basis: 'observed',
      status: 'active',
      confidence: 0.9,
      sources: [source('memory:m-1')],
      now: NOW,
    });
    h.revalidator.seed([source('memory:m-1')]);
    const result = await project(h, publicGroup());
    expect(result.admittedClaimIds).toEqual([]);
  });
});
