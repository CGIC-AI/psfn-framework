import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDriftReviewCardStore,
  type DriftReviewCardStore,
} from '../../../core/cogsec/drift/drift-review-card-store.js';
import { createAdminDriftReviewService, type AdminDriftReviewService } from './drift-review-service.js';

const NOW_MS = Date.UTC(2026, 6, 9, 3, 0, 0);

describe('createAdminDriftReviewService', () => {
  let dir: string;
  let store: DriftReviewCardStore;
  let service: AdminDriftReviewService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'drift-service-'));
    store = createDriftReviewCardStore(join(dir, 'cogsec-drift-reviews.json'), { now: () => NOW_MS });
    service = createAdminDriftReviewService({ store });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seedCard(contactId = 'contact-1', evidenceHash = `hash-${contactId}`) {
    const created = store.create({
      contactId,
      displayName: 'Mallory',
      trustLevel: 'regular',
      evidenceHash,
      compositeScore: 0.8,
      triggeredSignalIds: ['valence_velocity'],
      signals: [{
        id: 'valence_velocity',
        triggered: true,
        score: 0.8,
        summary: 'valence shifted fast',
        evidence: { zShift: -4.8 },
      }],
      atMs: NOW_MS,
    });
    if (!created.created) throw new Error('fixture card was deduplicated');
    return created.card;
  }

  it('lists cards with an open count and reads a single card', () => {
    const card = seedCard();
    const data = service.listCards();
    expect(data.cards).toHaveLength(1);
    expect(data.openCount).toBe(1);
    expect(service.getCard(card.id)?.contactId).toBe('contact-1');
    expect(service.getCard('missing')).toBeUndefined();
  });

  it('resolves an open card as the garden operator with audit fields', () => {
    const card = seedCard();
    const result = service.resolveCard({ id: card.id, resolution: 'acknowledged', note: 'checked in' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.card.status).toBe('acknowledged');
      expect(result.card.resolutionRecord?.actor).toBe('operator:garden');
      expect(result.card.resolutionRecord?.note).toBe('checked in');
    }
    expect(service.listCards().openCount).toBe(0);
  });

  it('refuses unknown ids, bad resolutions, and double resolution (fail closed)', () => {
    const card = seedCard();
    expect(service.resolveCard({ id: 'missing', resolution: 'dismissed' }))
      .toEqual({ ok: false, status: 404, message: 'Drift review card not found' });
    expect(service.resolveCard({
      id: card.id,
      resolution: 'released' as never,
    })).toMatchObject({ ok: false, status: 400 });

    const first = service.resolveCard({ id: card.id, resolution: 'dismissed' });
    expect(first.ok).toBe(true);
    expect(service.resolveCard({ id: card.id, resolution: 'acknowledged' }))
      .toMatchObject({ ok: false, status: 409 });
  });
});
