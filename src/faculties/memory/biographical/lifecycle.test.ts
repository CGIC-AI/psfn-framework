import { describe, expect, it, vi } from 'vitest';

import { InMemoryBiographicalProfileStore } from './in-memory-store.js';
import {
  applyBiographicalContactLifecycle,
  deserializeBiographicalRebuildRequest,
  executeBiographicalRebuild,
} from './lifecycle.js';
import type { BiographicalClaimSource, BiographicalSubjectRef } from './types.js';

const NOW = new Date('2026-08-10T12:00:00.000Z');
const SHA = 'a'.repeat(64);
const COMPANION: BiographicalSubjectRef = {
  kind: 'companion', companionId: 'purrs', subjectVersion: 1,
};
const SOURCE = { kind: 'contact', contactId: 'source', subjectVersion: 1 } as const;
const TARGET = { kind: 'contact', contactId: 'target', subjectVersion: 2 } as const;

function source(ref: string): BiographicalClaimSource {
  return {
    ref,
    revision: '1',
    evidenceDigest: SHA,
    sensitivityAtProjection: 'personal',
    subjectEvidenceDigest: SHA,
    consentFingerprint: SHA,
  };
}

async function writePreference(
  store: InMemoryBiographicalProfileStore,
  subject: BiographicalSubjectRef,
  target: string,
) {
  return await store.writeClaim({
    subject,
    kind: 'stable-preference',
    value: {
      kind: 'stable-preference', schemaVersion: 1, domain: 'food', target, polarity: 'likes',
    },
    basis: 'explicit',
    status: 'active',
    confidence: 1,
    sources: [source(`memory:${target}`)],
    now: NOW,
  });
}

describe('durable biographical rebuild lifecycle', () => {
  it('coalesces deterministically, enforces capacity, and bypasses synthesis on no change', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const tea = await writePreference(store, SOURCE, 'tea');
    const coffee = await writePreference(store, SOURCE, 'coffee');
    const first = await store.enqueueRebuild({
      claim: tea, reason: 'revision-drift', sourceRef: 'memory:tea', maxPending: 1, now: NOW,
    });
    const duplicate = await store.enqueueRebuild({
      claim: tea, reason: 'revision-drift', sourceRef: 'memory:tea', maxPending: 1, now: NOW,
    });
    const full = await store.enqueueRebuild({
      claim: coffee, reason: 'revision-drift', sourceRef: 'memory:coffee', maxPending: 1, now: NOW,
    });
    expect([first.status, duplicate.status, full.status])
      .toEqual(['queued', 'coalesced', 'capacity-exhausted']);

    const request = first.request;
    if (request === undefined) throw new Error('expected queued rebuild request');
    const synthesize = vi.fn(async () => undefined);
    await expect(executeBiographicalRebuild({
      store,
      request,
      revalidator: { revalidate: async () => ({ status: 'valid', currentSources: tea.sources }) },
      synthesize,
      now: NOW,
    })).resolves.toBe('no-change');
    expect(synthesize).not.toHaveBeenCalled();
    expect(await store.listRebuilds({ status: 'completed', limit: 1 })).toMatchObject([
      { id: request.id, completion: 'no-change' },
    ]);
  });

  it('fails closed when restored queue data has an unknown reason or mismatched id', () => {
    expect(() => deserializeBiographicalRebuildRequest({
      id: SHA,
      claimId: 'claim-1',
      subject: SOURCE,
      kind: 'stable-preference',
      reason: 'model-invented',
      priorSourceSetDigest: SHA,
      status: 'pending',
      queuedAt: NOW.toISOString(),
    })).toThrow(/reason is not supported/u);
    expect(() => deserializeBiographicalRebuildRequest({
      id: SHA,
      claimId: 'claim-1',
      subject: SOURCE,
      kind: 'stable-preference',
      reason: 'deleted',
      priorSourceSetDigest: SHA,
      status: 'pending',
      queuedAt: NOW.toISOString(),
    })).toThrow(/deterministic payload/u);
  });

  it('merges to one canonical profile without copying source claims or contact bleed', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const oldClaim = await writePreference(store, SOURCE, 'tea');
    const targetClaim = await writePreference(store, TARGET, 'coffee');
    const relational = await store.writeClaim({
      subject: COMPANION,
      relatedSubject: SOURCE,
      kind: 'nickname',
      value: { kind: 'nickname', nickname: 'Sunbeam loaf', scope: 'relational' },
      basis: 'explicit',
      status: 'active',
      confidence: 1,
      sources: [source('memory:shared-language')],
      now: NOW,
    });

    const result = await applyBiographicalContactLifecycle({
      store,
      lifecycle: {
        action: 'merge', sourceSubject: SOURCE, targetSubject: TARGET, maxPending: 4, now: NOW,
      },
    });

    expect(result.retiredClaimIds).toEqual([oldClaim.id, relational.id].sort());
    expect((await store.getClaim(oldClaim.id))?.status).toBe('superseded');
    expect((await store.getClaim(relational.id))?.status).toBe('superseded');
    expect(await store.listClaims({ subject: SOURCE })).toEqual([]);
    expect(await store.listClaims({ subject: TARGET })).toMatchObject([{ id: targetClaim.id }]);
    expect(await store.listRebuilds({ status: 'pending', limit: 4 })).toMatchObject([
      { reason: 'contact-merged', targetSubject: TARGET },
      { reason: 'contact-merged', targetSubject: TARGET },
    ]);
  });

  it('rolls archive back rather than dropping required work when queue capacity is exhausted', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const tea = await writePreference(store, SOURCE, 'tea');
    const coffee = await writePreference(store, SOURCE, 'coffee');

    await expect(applyBiographicalContactLifecycle({
      store,
      lifecycle: { action: 'archive', sourceSubject: SOURCE, maxPending: 1, now: NOW },
    })).rejects.toThrow(/operation bound exceeded/u);
    expect((await store.getClaim(tea.id))?.status).toBe('active');
    expect((await store.getClaim(coffee.id))?.status).toBe('active');
    expect(await store.listRebuilds({ status: 'pending', limit: 4 })).toEqual([]);
  });

  it('completes archive work as invalidated without synthesis', async () => {
    const store = new InMemoryBiographicalProfileStore(() => NOW);
    const claim = await writePreference(store, SOURCE, 'tea');
    const queued = await store.enqueueRebuild({
      claim, reason: 'contact-archived', maxPending: 1, now: NOW,
    });
    const request = queued.request;
    if (request === undefined) throw new Error('expected queued archive request');
    const synthesize = vi.fn(async () => undefined);

    await expect(executeBiographicalRebuild({
      store,
      request,
      revalidator: { revalidate: async () => ({ status: 'valid', currentSources: claim.sources }) },
      synthesize,
      now: NOW,
    })).resolves.toBe('invalidated');
    expect(synthesize).not.toHaveBeenCalled();
    expect(await store.listRebuilds({ status: 'completed', limit: 1 })).toMatchObject([
      { id: request.id, completion: 'invalidated' },
    ]);
  });
});
