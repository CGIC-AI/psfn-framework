import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDriftReviewCardStore,
  type DriftReviewCardStore,
  type SecondArrowReviewCardCreateInput,
} from '../../../core/cogsec/drift/drift-review-card-store.js';
import type { PurrMemory } from '../../../faculties/memory/types.js';
import type { MemoryEvolutionLink, MemoryEvolutionLinkInput, MemoryStoreUpdatePatch } from '../../../faculties/memory/memory-store-port.js';
import {
  createAdminDriftReviewService,
  type AdminDriftConsolidationMemoryStore,
  type AdminDriftReviewService,
} from './drift-review-service.js';

const NOW_MS = Date.UTC(2026, 6, 9, 3, 0, 0);

/** Minimal in-memory stand-in for the consolidation surface of the memory store. */
class FakeConsolidationMemoryStore implements AdminDriftConsolidationMemoryStore {
  readonly memories = new Map<string, PurrMemory>();
  readonly patches: Array<{ id: string; updates: MemoryStoreUpdatePatch }> = [];
  readonly links: MemoryEvolutionLinkInput[] = [];

  seed(id: string, overrides: Partial<PurrMemory> = {}): void {
    this.memories.set(id, {
      id,
      text: `memory ${id}`,
      type: 'emotional',
      importance: 0.5,
      confidence: 0.8,
      emotionalValence: -0.4,
      salience: 0.5,
      sourceRef: 'heartbeat:test',
      extractedAt: NOW_MS - 1000,
      lastAccessed: NOW_MS - 1000,
      accessCount: 1,
      tags: [],
      sensitivity: 'personal',
      ...overrides,
    } as PurrMemory);
  }

  async getById(id: string): Promise<PurrMemory | undefined> {
    return this.memories.get(id);
  }

  async updateMemory(id: string, updates: MemoryStoreUpdatePatch): Promise<void> {
    const memory = this.memories.get(id);
    if (!memory) throw new Error(`unknown memory ${id}`);
    this.patches.push({ id, updates });
    this.memories.set(id, { ...memory, ...updates } as PurrMemory);
  }

  async recordEvolutionLink(input: MemoryEvolutionLinkInput): Promise<MemoryEvolutionLink> {
    this.links.push(input);
    return {
      id: `link-${this.links.length}`,
      sourceMemoryId: input.sourceMemoryId,
      targetMemoryId: input.targetMemoryId,
      relation: input.relation,
      confidence: input.confidence ?? 1,
      sourceType: 'unknown',
      provenanceRefs: [],
      createdAt: NOW_MS,
    };
  }
}

function secondArrowInput(
  overrides: Partial<SecondArrowReviewCardCreateInput> = {},
): SecondArrowReviewCardCreateInput {
  return {
    topicLabel: 'worried about the memory bug',
    clusterKey: 'cluster-1',
    memberMemoryIds: ['mem-1', 'mem-2', 'mem-3'],
    members: [
      { id: 'mem-1', textPreview: 'worried about the memory bug', type: 'emotional', extractedAtMs: NOW_MS - 3000, sourceType: 'heartbeat', similarityToCentroid: 0.97 },
      { id: 'mem-2', textPreview: 'the memory bug worries me', type: 'emotional', extractedAtMs: NOW_MS - 2000, sourceType: 'reflection', similarityToCentroid: 0.96 },
      { id: 'mem-3', textPreview: 'still thinking about the memory bug', type: 'emotional', extractedAtMs: NOW_MS - 1000, sourceType: 'heartbeat', similarityToCentroid: 0.95 },
    ],
    evidenceHash: 'sa-hash-1',
    compositeScore: 0.7,
    triggeredSignalIds: ['similarity_cluster', 'creation_velocity'],
    signals: [
      { id: 'similarity_cluster', triggered: true, score: 0.7, summary: '3 near-duplicates', evidence: {} },
      { id: 'creation_velocity', triggered: true, score: 0.6, summary: '9x baseline', evidence: {} },
    ],
    proposedConsolidation: {
      canonicalMemoryId: 'mem-1',
      supersededMemoryIds: ['mem-2', 'mem-3'],
      mechanism: 'memory_supersession',
    },
    atMs: NOW_MS,
    ...overrides,
  };
}

describe('createAdminDriftReviewService', () => {
  let dir: string;
  let store: DriftReviewCardStore;
  let memoryStore: FakeConsolidationMemoryStore;
  let service: AdminDriftReviewService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'drift-service-'));
    store = createDriftReviewCardStore(join(dir, 'cogsec-drift-reviews.json'), { now: () => NOW_MS });
    memoryStore = new FakeConsolidationMemoryStore();
    service = createAdminDriftReviewService({ store, memoryStore });
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

  function seedSecondArrowCard(overrides: Partial<SecondArrowReviewCardCreateInput> = {}) {
    const created = store.createSecondArrow(secondArrowInput(overrides));
    if (!created.created) throw new Error('fixture card was deduplicated');
    return created.card;
  }

  it('lists cards with an open count and reads a single card', () => {
    const card = seedCard();
    const data = service.listCards();
    expect(data.cards).toHaveLength(1);
    expect(data.openCount).toBe(1);
    const fetched = service.getCard(card.id);
    expect(fetched?.kind === 'source_drift' && fetched.contactId).toBe('contact-1');
    expect(service.getCard('missing')).toBeUndefined();
  });

  it('resolves an open card as the garden operator with audit fields', async () => {
    const card = seedCard();
    const result = await service.resolveCard({ id: card.id, resolution: 'acknowledged', note: 'checked in' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.card.status).toBe('acknowledged');
      expect(result.card.resolutionRecord?.actor).toBe('operator:garden');
      expect(result.card.resolutionRecord?.note).toBe('checked in');
    }
    expect(service.listCards().openCount).toBe(0);
  });

  it('refuses unknown ids, bad resolutions, and double resolution (fail closed)', async () => {
    const card = seedCard();
    await expect(service.resolveCard({ id: 'missing', resolution: 'dismissed' })).resolves
      .toEqual({ ok: false, status: 404, message: 'Drift review card not found' });
    await expect(service.resolveCard({
      id: card.id,
      resolution: 'released' as never,
    })).resolves.toMatchObject({ ok: false, status: 400 });

    const first = await service.resolveCard({ id: card.id, resolution: 'dismissed' });
    expect(first.ok).toBe(true);
    await expect(service.resolveCard({ id: card.id, resolution: 'acknowledged' })).resolves
      .toMatchObject({ ok: false, status: 409 });
  });

  // ── Second-arrow consolidation approval (htm9.15) ──

  it('refuses consolidated on a source-drift card (kind-incompatible resolution)', async () => {
    const card = seedCard();
    await expect(service.resolveCard({ id: card.id, resolution: 'consolidated' })).resolves
      .toMatchObject({ ok: false, status: 400 });
    expect(memoryStore.patches).toHaveLength(0);
  });

  it('applies the proposed supersession on approval, with evolution links and audit trail', async () => {
    memoryStore.seed('mem-1');
    memoryStore.seed('mem-2');
    memoryStore.seed('mem-3');
    const card = seedSecondArrowCard();

    const result = await service.resolveCard({ id: card.id, resolution: 'consolidated', note: 'stack confirmed' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.card.status).toBe('consolidated');
      expect(result.consolidatedMemoryIds).toEqual(['mem-2', 'mem-3']);
    }
    // Losers superseded by the canonical — never deleted.
    expect(memoryStore.patches).toEqual([
      { id: 'mem-2', updates: { supersededBy: 'mem-1' } },
      { id: 'mem-3', updates: { supersededBy: 'mem-1' } },
    ]);
    expect(memoryStore.memories.get('mem-2')?.deletedAt).toBeUndefined();
    // Evolution links record the operator-approved supersession.
    expect(memoryStore.links).toHaveLength(2);
    expect(memoryStore.links[0]).toMatchObject({
      sourceMemoryId: 'mem-1',
      targetMemoryId: 'mem-2',
      relation: 'supersedes',
      sourceRef: `garden:drift-review:${card.id}`,
    });
  });

  it('refuses stale proposals without mutating anything (fail closed)', async () => {
    memoryStore.seed('mem-1');
    memoryStore.seed('mem-2', { supersededBy: 'mem-elsewhere' });
    memoryStore.seed('mem-3');
    const card = seedSecondArrowCard();

    const superseded = await service.resolveCard({ id: card.id, resolution: 'consolidated' });
    expect(superseded).toMatchObject({ ok: false, status: 409 });
    expect(memoryStore.patches).toHaveLength(0);
    expect(service.getCard(card.id)?.status).toBe('open');

    // Deleted canonical is refused too.
    memoryStore.seed('mem-2');
    memoryStore.seed('mem-1', { deletedAt: NOW_MS });
    const deleted = await service.resolveCard({ id: card.id, resolution: 'consolidated' });
    expect(deleted).toMatchObject({ ok: false, status: 409 });
    expect(memoryStore.patches).toHaveLength(0);
  });

  it('skips members already superseded by the canonical (retry convergence)', async () => {
    memoryStore.seed('mem-1');
    memoryStore.seed('mem-2', { supersededBy: 'mem-1' });
    memoryStore.seed('mem-3');
    const card = seedSecondArrowCard();

    const result = await service.resolveCard({ id: card.id, resolution: 'consolidated' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.consolidatedMemoryIds).toEqual(['mem-3']);
    expect(memoryStore.patches).toEqual([{ id: 'mem-3', updates: { supersededBy: 'mem-1' } }]);
  });

  it('refuses consolidation when no memory store is wired (cards stay evidence-only)', async () => {
    const evidenceOnly = createAdminDriftReviewService({ store });
    const card = seedSecondArrowCard({ evidenceHash: 'sa-hash-evidence-only', clusterKey: 'cluster-eo', memberMemoryIds: ['mem-9', 'mem-10', 'mem-11'], proposedConsolidation: { canonicalMemoryId: 'mem-9', supersededMemoryIds: ['mem-10', 'mem-11'], mechanism: 'memory_supersession' } });
    const result = await evidenceOnly.resolveCard({ id: card.id, resolution: 'consolidated' });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(evidenceOnly.getCard(card.id)?.status).toBe('open');
    // Acknowledge/dismiss still work without memory access.
    await expect(evidenceOnly.resolveCard({ id: card.id, resolution: 'acknowledged' })).resolves
      .toMatchObject({ ok: true });
  });
});
