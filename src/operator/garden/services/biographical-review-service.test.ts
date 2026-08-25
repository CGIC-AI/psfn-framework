import { describe, expect, it, vi } from 'vitest';

import { requireGardenRouteAuthorization } from '../../../boundary/fleet-auth/garden-route-authorization.js';
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
import type { FleetGardenRequestContext } from '../garden-request-context.js';

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

function fleetContext(
  contactId: string,
  accessMode: FleetGardenRequestContext['actor']['accessMode'] = 'multi_admin',
  assurance: FleetGardenRequestContext['actor']['sessionAssurance'] = 'oauth',
): FleetGardenRequestContext {
  const authorization = requireGardenRouteAuthorization('GET /api/admin/biographical-claims');
  return {
    kind: 'fleet_principal',
    requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    decisionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    authorizationEventId: 'event-biographical-test',
    resolvedAt: NOW.toISOString(),
    versions: {
      authorityGeneration: 1,
      globalAuthEpoch: 1,
      sessionAuthnVersion: 1,
      sessionAuthzVersion: 1,
      bindingVersion: 1,
      grantVersion: 1,
      policyVersion: 1,
    },
    issuedAt: 1,
    expiresAt: 2,
    actor: {
      kind: 'fleet_principal',
      principalId: 'principal-biographical-test',
      provider: 'discord',
      providerSubjectId: '266127174426165249',
      contactId,
      contactBindingId: 'binding-biographical-test',
      role: 'owner',
      operatorGrantId: 'grant-biographical-test',
      sessionRecordId: 'session-biographical-test',
      sessionAssurance: assurance,
      accessMode,
    },
    action: authorization.action,
    resource: {
      routeId: 'GET /api/admin/biographical-claims',
      scope: authorization.resource.scope,
      area: authorization.resource.area,
      companionId: '11111111-1111-4111-8111-111111111111',
      pathParams: {},
      query: {},
    },
    subjectRelation: authorization.subjectRelation,
    authorization,
  };
}

describe('AdminBiographicalReviewService', () => {
  it('applies D1 subject authorization to multi-admin biography reads and reviews', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const own = await store.writeClaim({
      subject: { kind: 'contact', contactId: 'contact-v', subjectVersion: 1 },
      kind: 'stable-preference',
      value: {
        kind: 'stable-preference', schemaVersion: 1, domain: 'food', target: 'tea', polarity: 'likes',
      },
      basis: 'explicit', confidence: 1, sources: [source()], now: NOW,
    });
    const coSubject = await store.writeClaim({
      subject: { kind: 'companion', companionId: 'purrs', subjectVersion: 1 },
      relatedSubject: { kind: 'contact', contactId: 'contact-v', subjectVersion: 1 },
      kind: 'relationship',
      value: { kind: 'relationship', relationshipType: 'friend' },
      basis: 'explicit', confidence: 1, sources: [source()], now: NOW,
    });
    const unrelated = await store.writeClaim({
      subject: { kind: 'contact', contactId: 'contact-other', subjectVersion: 1 },
      kind: 'stable-preference',
      value: {
        kind: 'stable-preference', schemaVersion: 1, domain: 'food', target: 'coffee', polarity: 'likes',
      },
      basis: 'explicit', confidence: 1, sources: [source()], now: NOW,
    });
    const unrelatedPublic = await store.writeClaim({
      subject: { kind: 'contact', contactId: 'contact-public', subjectVersion: 1 },
      kind: 'name',
      value: { kind: 'name', name: 'Public contact', role: 'primary' },
      basis: 'explicit', proposedSensitivity: 'public', confidence: 1,
      sources: [{ ...source(), sensitivityAtProjection: 'public' }], now: NOW,
    });
    const companionOnly = await store.writeClaim({
      subject: { kind: 'companion', companionId: 'purrs', subjectVersion: 1 },
      kind: 'name',
      value: { kind: 'name', name: 'Purrs', role: 'primary' },
      basis: 'explicit', confidence: 1, sources: [source()], now: NOW,
    });
    const service = new AdminBiographicalReviewService({ store, queryLimit: 20, now: () => NOW });
    const scoped = fleetContext('contact-v');

    expect((await service.listClaims(scoped)).claims.map(claim => claim.id).sort())
      .toEqual([own.id, coSubject.id, unrelatedPublic.id, companionOnly.id].sort());
    await expect(service.getClaim(coSubject.id, scoped)).resolves
      .toMatchObject({ claim: { id: coSubject.id } });
    await expect(service.getClaim(unrelated.id, scoped)).rejects
      .toMatchObject({ reason: 'claim-not-found' });
    await expect(service.getClaim(unrelatedPublic.id, scoped)).resolves
      .toMatchObject({ claim: { id: unrelatedPublic.id } });
    await expect(service.getClaim(companionOnly.id, scoped)).resolves
      .toMatchObject({ claim: { id: companionOnly.id } });

    await expect(service.review(unrelated.id, {
      action: 'approve',
      claimDigest: unrelated.claimDigest,
      sourceSetDigest: unrelated.sourceSetDigest,
    }, ACTOR, scoped)).rejects.toMatchObject({ reason: 'claim-not-found' });
    expect((await store.getClaim(unrelated.id))?.status).toBe('candidate');
    expect(await store.listReviewAudits(unrelated.id, 20)).toEqual([]);

    await expect(service.review(own.id, {
      action: 'approve',
      claimDigest: own.claimDigest,
      sourceSetDigest: own.sourceSetDigest,
    }, ACTOR, scoped)).resolves.toMatchObject({ claim: { id: own.id, status: 'active' } });

    expect((await service.listClaims(fleetContext('contact-v', 'sole_admin'))).claims)
      .toHaveLength(5);
    expect((await service.listClaims(fleetContext('contact-v', 'multi_admin', 'escalated'))).claims)
      .toHaveLength(5);
  });

  it('fails closed on foreign claims whose pending rebuild invalidates sensitivity', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const claim = await store.writeClaim({
      id: 'claim-foreign-drifted',
      subject: { kind: 'contact', contactId: 'contact-other', subjectVersion: 1 },
      kind: 'name',
      value: { kind: 'name', name: 'Foreign contact', role: 'primary' },
      basis: 'explicit',
      proposedSensitivity: 'public',
      status: 'active',
      confidence: 1,
      sources: [{ ...source(), sensitivityAtProjection: 'public' }],
      now: NOW,
    });
    const currentSourceSetDigest = 'b'.repeat(64);
    await store.enqueueRebuild({
      claim,
      reason: 'sensitivity-increased',
      currentSourceSetDigest,
      maxPending: 20,
      now: NOW,
    });
    const service = new AdminBiographicalReviewService({ store, queryLimit: 20, now: () => NOW });
    const scoped = fleetContext('contact-v');

    await expect(service.listClaims(scoped)).resolves.toEqual({ claims: [] });
    await expect(service.getClaim(claim.id, scoped)).rejects
      .toMatchObject({ reason: 'claim-not-found' });
    await expect(service.review(claim.id, {
      action: 'regrant',
      claimDigest: claim.claimDigest,
      sourceSetDigest: currentSourceSetDigest,
      grantedSensitivity: 'public',
    }, ACTOR, scoped)).rejects.toMatchObject({ reason: 'claim-not-found' });
    expect(await store.listGrantsForClaim(claim.id)).toEqual([]);
    expect(await store.listReviewAudits(claim.id, 20)).toEqual([]);
    expect((await store.getClaim(claim.id))?.status).toBe('active');
  });

  it('does not audit a hidden claim when sensitivity drifts before the transaction', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const claim = await store.writeClaim({
      id: 'claim-foreign-racing-drift',
      subject: { kind: 'contact', contactId: 'contact-other', subjectVersion: 1 },
      kind: 'name',
      value: { kind: 'name', name: 'Foreign contact', role: 'primary' },
      basis: 'explicit',
      proposedSensitivity: 'public',
      status: 'active',
      confidence: 1,
      sources: [{ ...source(), sensitivityAtProjection: 'public' }],
      now: NOW,
    });
    const originalRunClaimTransaction = store.runClaimTransaction.bind(store);
    vi.spyOn(store, 'runClaimTransaction').mockImplementation(async (subject, kind, operation) => {
      await store.enqueueRebuild({
        claim,
        reason: 'sensitivity-increased',
        currentSourceSetDigest: 'b'.repeat(64),
        maxPending: 20,
        now: NOW,
      });
      return await originalRunClaimTransaction(subject, kind, operation);
    });
    const service = new AdminBiographicalReviewService({ store, queryLimit: 20, now: () => NOW });

    await expect(service.review(claim.id, {
      action: 'regrant',
      claimDigest: claim.claimDigest,
      sourceSetDigest: claim.sourceSetDigest,
      grantedSensitivity: 'public',
    }, ACTOR, fleetContext('contact-v'))).rejects
      .toMatchObject({ reason: 'claim-not-found' });
    expect(await store.listGrantsForClaim(claim.id)).toEqual([]);
    expect(await store.listReviewAudits(claim.id, 20)).toEqual([]);
    expect((await store.getClaim(claim.id))?.status).toBe('active');
  });

  it('continues paging until the authorized result limit is filled', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    for (const [id, contactId] of [
      ['claim-a-hidden', 'contact-hidden-a'],
      ['claim-b-hidden', 'contact-hidden-b'],
    ] as const) {
      await store.writeClaim({
        id,
        subject: { kind: 'contact', contactId, subjectVersion: 1 },
        kind: 'stable-preference',
        value: {
          kind: 'stable-preference', schemaVersion: 1, domain: 'food', target: id, polarity: 'likes',
        },
        basis: 'explicit', confidence: 1, sources: [source()], now: NOW,
      });
    }
    const own = await store.writeClaim({
      id: 'claim-c-own',
      subject: { kind: 'contact', contactId: 'contact-v', subjectVersion: 1 },
      kind: 'name',
      value: { kind: 'name', name: 'Viewer', role: 'primary' },
      basis: 'explicit', confidence: 1, sources: [source()], now: NOW,
    });
    const foreignPublic = await store.writeClaim({
      id: 'claim-d-public',
      subject: { kind: 'contact', contactId: 'contact-public', subjectVersion: 1 },
      kind: 'name',
      value: { kind: 'name', name: 'Public contact', role: 'primary' },
      basis: 'explicit', proposedSensitivity: 'public', confidence: 1,
      sources: [{ ...source(), sensitivityAtProjection: 'public' }], now: NOW,
    });
    const service = new AdminBiographicalReviewService({ store, queryLimit: 2, now: () => NOW });

    expect((await service.listClaims(fleetContext('contact-v'))).claims.map(claim => claim.id))
      .toEqual([own.id, foreignPublic.id]);
  });

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
