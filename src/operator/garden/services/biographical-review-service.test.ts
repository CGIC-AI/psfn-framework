import { describe, expect, it } from 'vitest';

import { InMemoryBiographicalProfileStore } from '../../../faculties/memory/biographical/in-memory-store.js';
import {
  projectBiographicalContext,
  type BiographicalSourceRevalidator,
} from '../../../faculties/memory/biographical/projection.js';
import { recordCompanionPublicationChoice } from '../../../faculties/memory/biographical/publication.js';
import { createGroupConversationScope } from '../../../core/session/conversation-scope.js';
import type { BiographicalClaimSource } from '../../../faculties/memory/biographical/types.js';
import {
  AdminBiographicalReviewService,
} from './biographical-review-service.js';

const NOW = new Date('2026-08-10T12:00:00.000Z');
const SHA = 'a'.repeat(64);
const ACTOR = { kind: 'operator' as const, authorityRef: 'garden-session:verified' };

function source(): BiographicalClaimSource {
  return {
    ref: 'memory:private-v',
    revision: '7',
    evidenceDigest: SHA,
    sensitivityAtProjection: 'intimate',
    subjectEvidenceDigest: SHA,
    consentFingerprint: SHA,
    sourceChannelId: 'dm:v',
  };
}

describe('AdminBiographicalReviewService', () => {
  it('returns redacted structured detail and rejects stale exact-digest approval', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const claim = await store.writeClaim({
      subject: { kind: 'contact', contactId: 'v', subjectVersion: 1 },
      kind: 'stable-preference',
      value: {
        kind: 'stable-preference', schemaVersion: 1, domain: 'food', target: 'tea', polarity: 'likes',
      },
      basis: 'explicit',
      confidence: 1,
      sources: [source()],
      now: NOW,
    });
    const service = new AdminBiographicalReviewService({ store, queryLimit: 20, now: () => NOW });

    const detail = await service.getClaim(claim.id);
    expect(detail).toMatchObject({
      claim: {
        id: claim.id,
        status: 'candidate',
        subject: { kind: 'contact', contactId: 'v', subjectVersion: 1 },
        structuredValue: claim.value,
        effectiveSensitivity: 'intimate',
        sources: [{
          ref: 'memory:private-v',
          revision: '7',
          evidenceDigest: SHA,
          sensitivityContribution: 'intimate',
        }],
      },
      grants: [],
      rebuilds: [],
    });
    expect(JSON.stringify(detail)).not.toContain('sourceBody');
    expect(JSON.stringify(detail)).not.toContain('private memory body');

    await expect(service.review(claim.id, {
      action: 'approve',
      claimDigest: 'b'.repeat(64),
      sourceSetDigest: claim.sourceSetDigest,
    }, ACTOR)).rejects.toThrow(/stale claim digest/u);
    expect((await store.getClaim(claim.id))?.status).toBe('candidate');
    expect(await store.listReviewAudits(claim.id, 20)).toMatchObject([
      { action: 'approve', decision: 'denied', reason: 'stale-claim-digest' },
    ]);
  });

  it('keeps digest drift withheld until an exact new-digest regrant', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const originalSource = source();
    const currentSource = { ...originalSource, revision: '8' };
    const claim = await store.writeClaim({
      subject: { kind: 'companion', companionId: 'purrs', subjectVersion: 1 },
      kind: 'nickname',
      value: { kind: 'nickname', nickname: 'Sunbeam loaf', scope: 'self' },
      basis: 'explicit',
      status: 'active',
      confidence: 1,
      sources: [originalSource],
      now: NOW,
    });
    await recordCompanionPublicationChoice({
      store,
      choice: { claimId: claim.id, reason: 'initial exact choice', now: NOW },
    });
    const revalidator: BiographicalSourceRevalidator = {
      revalidate: async () => ({ status: 'valid', currentSources: [currentSource] }),
    };
    const scope = createGroupConversationScope({
      channelId: 'group:public',
      envelope: {
        channelPrivacy: 'public', audienceScope: 'few', audienceKnowledge: 'all_known', broadcast: false,
      },
    });
    const project = () => projectBiographicalContext(
      { store, revalidator, rebuildQueueMaxPending: 20 },
      {
        companionSubject: claim.subject,
        conversationScope: scope,
        now: NOW,
      },
    );

    expect((await project()).admittedClaimIds).toEqual([]);
    const pending = (await store.listRebuilds({ claimId: claim.id, status: 'pending', limit: 20 }))[0];
    if (pending?.currentSourceSetDigest === undefined) throw new Error('expected digest-drift rebuild');
    const service = new AdminBiographicalReviewService({ store, queryLimit: 20, now: () => NOW });
    await expect(service.review(claim.id, {
      action: 'regrant',
      claimDigest: claim.claimDigest,
      sourceSetDigest: claim.sourceSetDigest,
      grantedSensitivity: 'public',
    }, ACTOR)).rejects.toThrow(/stale source-set digest/u);
    expect((await project()).admittedClaimIds).toEqual([]);

    const afterRegrant = await service.review(claim.id, {
      action: 'regrant',
      claimDigest: claim.claimDigest,
      sourceSetDigest: pending.currentSourceSetDigest,
      grantedSensitivity: 'public',
    }, ACTOR);
    expect((await project()).admittedClaimIds).toEqual([claim.id]);
    expect(afterRegrant.claim).toMatchObject({
      sourceSetDigest: pending.currentSourceSetDigest,
      storedSourceSetDigest: claim.sourceSetDigest,
      effectiveSensitivity: null,
      storedEffectiveSensitivity: 'public',
      sensitivitySnapshotCurrent: false,
      withheldReasons: [],
      pendingRebuildReasons: ['source-set-drift'],
    });
    const currentGrant = afterRegrant.grants.find(grant =>
      grant.sourceSetDigest === pending.currentSourceSetDigest && grant.revokedAt === undefined
    );
    if (currentGrant === undefined) throw new Error('expected exact current-digest grant');
    await expect(service.review(claim.id, {
      action: 'regrant',
      claimDigest: claim.claimDigest,
      sourceSetDigest: pending.currentSourceSetDigest,
      grantedSensitivity: 'personal',
    }, ACTOR)).rejects.toMatchObject({ reason: 'invalid-state' });
    expect((await service.getClaim(claim.id)).grants.filter(grant =>
      grant.sourceSetDigest === pending.currentSourceSetDigest && grant.revokedAt === undefined
    )).toHaveLength(1);
    await service.review(claim.id, {
      action: 'revoke',
      claimDigest: claim.claimDigest,
      sourceSetDigest: pending.currentSourceSetDigest,
      grantId: currentGrant.id,
    }, ACTOR);
    expect((await project()).admittedClaimIds).toEqual([]);
    expect(await store.listRebuilds({ claimId: claim.id, status: 'pending', limit: 20 }))
      .toHaveLength(1);
    expect(await store.listReviewAudits(claim.id, 20)).toEqual(expect.arrayContaining([
      { action: 'regrant', decision: 'denied', reason: 'stale-source-set-digest' },
      { action: 'regrant', decision: 'allowed', reason: 'grant-recorded' },
      { action: 'revoke', decision: 'allowed', reason: 'grant-revoked' },
      { action: 'regrant', decision: 'denied', reason: 'invalid-state' },
    ].map(entry => expect.objectContaining(entry))));
  });

  it('rejects request-body actor injection before mutating or fabricating an audit', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const claim = await store.writeClaim({
      subject: { kind: 'contact', contactId: 'v', subjectVersion: 1 },
      kind: 'stable-preference',
      value: {
        kind: 'stable-preference', schemaVersion: 1, domain: 'food', target: 'tea', polarity: 'likes',
      },
      basis: 'explicit', confidence: 1, sources: [source()], now: NOW,
    });
    const service = new AdminBiographicalReviewService({ store, queryLimit: 20, now: () => NOW });

    await expect(service.review(claim.id, {
      action: 'approve',
      claimDigest: claim.claimDigest,
      sourceSetDigest: claim.sourceSetDigest,
      actor: { kind: 'operator', authorityRef: 'attacker:chosen' },
    }, ACTOR)).rejects.toMatchObject({ reason: 'malformed' });
    expect((await store.getClaim(claim.id))?.status).toBe('candidate');
    expect(await store.listReviewAudits(claim.id, 20)).toEqual([]);
  });
});
