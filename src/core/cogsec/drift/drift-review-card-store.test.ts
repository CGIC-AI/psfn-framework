import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDriftReviewCardStore,
  type DriftReviewCard,
  type DriftReviewCardCreateInput,
  type DriftReviewCardStore,
  type SecondArrowReviewCardCreateInput,
  type SourceDriftReviewCard,
} from './drift-review-card-store.js';
import type { DriftSignalResult } from './drift-signals.js';
import type { SecondArrowSignalResult } from './second-arrow-signals.js';

function asSourceDrift(card: DriftReviewCard | undefined): SourceDriftReviewCard {
  if (!card || card.kind !== 'source_drift') {
    throw new Error(`expected a source_drift card, got ${card?.kind ?? 'nothing'}`);
  }
  return card;
}

const NOW_MS = Date.UTC(2026, 6, 9, 3, 0, 0);

function signal(overrides: Partial<DriftSignalResult> = {}): DriftSignalResult {
  return {
    id: 'valence_velocity',
    triggered: true,
    score: 0.8,
    summary: 'valence shifted -0.9 (4.8x baseline volatility)',
    evidence: { zShift: -4.8, trajectory: [{ valence: 0.6, confidence: 0.8, observedAtMs: NOW_MS }] },
    ...overrides,
  };
}

function cardInput(overrides: Partial<DriftReviewCardCreateInput> = {}): DriftReviewCardCreateInput {
  return {
    contactId: 'contact-1',
    displayName: 'Mallory',
    trustLevel: 'regular',
    evidenceHash: 'hash-1',
    compositeScore: 0.8,
    triggeredSignalIds: ['valence_velocity'],
    signals: [signal()],
    atMs: NOW_MS,
    ...overrides,
  };
}

describe('createDriftReviewCardStore', () => {
  let dir: string;
  let filePath: string;
  let store: DriftReviewCardStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'drift-cards-'));
    filePath = join(dir, 'cogsec-drift-reviews.json');
    store = createDriftReviewCardStore(filePath, { now: () => NOW_MS });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates, lists (open first, newest first), and reads back cards', () => {
    const first = store.create(cardInput());
    expect(first.created).toBe(true);
    const second = store.create(cardInput({
      contactId: 'contact-2',
      evidenceHash: 'hash-2',
      atMs: NOW_MS + 1000,
    }));
    expect(second.created).toBe(true);

    const cards = store.list();
    expect(cards).toHaveLength(2);
    expect(asSourceDrift(cards[0]).contactId).toBe('contact-2');
    expect(store.getById(cards[0]!.id)?.evidenceHash).toBe('hash-2');
    // Evidence survives the round-trip for the Garden card renderer.
    expect(cards[1]!.signals[0]!.evidence.zShift).toBe(-4.8);
  });

  it('is idempotent by evidence hash (retry replay cannot duplicate a card)', () => {
    const first = store.create(cardInput());
    const replay = store.create(cardInput());
    expect(replay.created).toBe(false);
    expect(replay.created === false && replay.reason).toBe('duplicate_evidence');
    expect(replay.card.id).toBe(first.card.id);
    expect(store.list()).toHaveLength(1);
  });

  it('refuses to stack a second open card for the same contact', () => {
    store.create(cardInput());
    const nextDay = store.create(cardInput({ evidenceHash: 'hash-next-day' }));
    expect(nextDay.created).toBe(false);
    expect(nextDay.created === false && nextDay.reason).toBe('open_card_for_contact');
    expect(store.list()).toHaveLength(1);
  });

  it('allows a new card for the contact once the previous one is resolved', () => {
    const first = store.create(cardInput());
    expect(first.created).toBe(true);
    store.resolve({ id: first.card.id, resolution: 'dismissed', actor: 'operator:garden' });
    const next = store.create(cardInput({ evidenceHash: 'hash-next-day' }));
    expect(next.created).toBe(true);
    expect(store.list()).toHaveLength(2);
  });

  it('resolves open cards with an audit record and fails closed on re-resolution', () => {
    const created = store.create(cardInput());
    const resolved = store.resolve({
      id: created.card.id,
      resolution: 'acknowledged',
      actor: 'operator:garden',
      note: 'watching this contact',
      atMs: NOW_MS + 5000,
    });
    expect(resolved.status).toBe('acknowledged');
    expect(resolved.resolutionRecord).toEqual({
      resolution: 'acknowledged',
      actor: 'operator:garden',
      note: 'watching this contact',
      atMs: NOW_MS + 5000,
    });
    expect(() => store.resolve({
      id: created.card.id,
      resolution: 'dismissed',
      actor: 'operator:garden',
    })).toThrow(/not 'open'/);
    expect(() => store.resolve({
      id: 'missing',
      resolution: 'dismissed',
      actor: 'operator:garden',
    })).toThrow(/not found/);
  });

  it('is shared across instances over the same file (Garden + lane processes)', () => {
    const created = store.create(cardInput());
    const gardenSide = createDriftReviewCardStore(filePath, { now: () => NOW_MS });
    expect(gardenSide.getById(created.card.id)?.status).toBe('open');
    gardenSide.resolve({ id: created.card.id, resolution: 'dismissed', actor: 'operator:garden' });
    expect(store.getById(created.card.id)?.status).toBe('dismissed');
  });

  it('fails closed on corrupt or unknown-shaped files', () => {
    writeFileSync(filePath, JSON.stringify({ version: 2, entries: [] }), 'utf8');
    expect(() => store.list()).toThrow(/Unsupported drift review card file shape/);

    writeFileSync(filePath, JSON.stringify({
      version: 1,
      entries: [{ id: 'x', unexpected: true }],
    }), 'utf8');
    expect(() => store.list()).toThrow(/unsupported keys/);
  });

  it('persists pretty JSON atomically at the configured path', () => {
    store.create(cardInput());
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { version: number; entries: unknown[] };
    expect(raw.version).toBe(1);
    expect(raw.entries).toHaveLength(1);
  });

  it('normalizes pre-kind (htm9.14) cards on disk to source_drift', () => {
    const created = store.create(cardInput());
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { version: number; entries: Record<string, unknown>[] };
    delete raw.entries[0]!.kind;
    writeFileSync(filePath, JSON.stringify(raw), 'utf8');
    const reloaded = store.getById(created.card.id);
    expect(reloaded?.kind).toBe('source_drift');
  });

  // ── Second-arrow (htm9.15) cards in the same store ──

  function secondArrowSignal(overrides: Partial<SecondArrowSignalResult> = {}): SecondArrowSignalResult {
    return {
      id: 'similarity_cluster',
      triggered: true,
      score: 0.7,
      summary: '5 near-duplicate writes',
      evidence: { meanMutualSimilarity: 0.93 },
      ...overrides,
    };
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
      signals: [secondArrowSignal(), secondArrowSignal({ id: 'creation_velocity', summary: '9x baseline' })],
      proposedConsolidation: {
        canonicalMemoryId: 'mem-1',
        supersededMemoryIds: ['mem-2', 'mem-3'],
        mechanism: 'memory_supersession',
      },
      atMs: NOW_MS,
      ...overrides,
    };
  }

  it('creates second-arrow cards alongside source-drift cards and round-trips the cluster evidence', () => {
    store.create(cardInput());
    const created = store.createSecondArrow(secondArrowInput());
    expect(created.created).toBe(true);
    expect(store.list()).toHaveLength(2);

    const reloaded = store.getById(created.card.id);
    if (!reloaded || reloaded.kind !== 'second_arrow') throw new Error('expected a second_arrow card');
    expect(reloaded.topicLabel).toBe('worried about the memory bug');
    expect(reloaded.memberMemoryIds).toEqual(['mem-1', 'mem-2', 'mem-3']);
    expect(reloaded.members[1]!.similarityToCentroid).toBe(0.96);
    expect(reloaded.proposedConsolidation).toEqual({
      canonicalMemoryId: 'mem-1',
      supersededMemoryIds: ['mem-2', 'mem-3'],
      mechanism: 'memory_supersession',
    });
  });

  it('is idempotent by evidence hash and dedupes onto open cards with overlapping members', () => {
    const first = store.createSecondArrow(secondArrowInput());
    const replay = store.createSecondArrow(secondArrowInput());
    expect(replay.created).toBe(false);
    expect(replay.created === false && replay.reason).toBe('duplicate_evidence');
    expect(replay.card.id).toBe(first.card.id);

    // Next night the cluster picked up a fourth member: still ONE open card.
    const grown = store.createSecondArrow(secondArrowInput({
      evidenceHash: 'sa-hash-2',
      clusterKey: 'cluster-1b',
      memberMemoryIds: ['mem-2', 'mem-3', 'mem-4', 'mem-5'],
    }));
    expect(grown.created).toBe(false);
    expect(grown.created === false && grown.reason).toBe('open_card_overlap');
    expect(store.list()).toHaveLength(1);

    // A disjoint cluster is a different stack and gets its own card.
    const disjoint = store.createSecondArrow(secondArrowInput({
      evidenceHash: 'sa-hash-3',
      clusterKey: 'cluster-2',
      memberMemoryIds: ['mem-7', 'mem-8', 'mem-9'],
      proposedConsolidation: {
        canonicalMemoryId: 'mem-7',
        supersededMemoryIds: ['mem-8', 'mem-9'],
        mechanism: 'memory_supersession',
      },
    }));
    expect(disjoint.created).toBe(true);
  });

  it('enforces kind-compatible resolutions (consolidated is second-arrow only)', () => {
    const sourceDrift = store.create(cardInput());
    expect(() => store.resolve({
      id: sourceDrift.card.id,
      resolution: 'consolidated',
      actor: 'operator:garden',
    })).toThrow(/does not accept resolution 'consolidated'/);

    const secondArrow = store.createSecondArrow(secondArrowInput());
    const resolved = store.resolve({
      id: secondArrow.card.id,
      resolution: 'consolidated',
      actor: 'operator:garden',
      atMs: NOW_MS + 1000,
    });
    expect(resolved.status).toBe('consolidated');
    expect(resolved.resolutionRecord?.resolution).toBe('consolidated');
  });

  it('fails closed on malformed second-arrow cards (self-superseding proposal, bad members)', () => {
    expect(() => store.createSecondArrow(secondArrowInput({
      proposedConsolidation: {
        canonicalMemoryId: 'mem-1',
        supersededMemoryIds: ['mem-1', 'mem-2'],
        mechanism: 'memory_supersession',
      },
    }))).toThrow(/must not supersede its own canonical memory/);

    const created = store.createSecondArrow(secondArrowInput());
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as { version: number; entries: Record<string, unknown>[] };
    const entry = raw.entries.find((candidate) => candidate.id === created.card.id)!;
    (entry.members as Record<string, unknown>[])[0]!.extractedAtMs = 'yesterday';
    writeFileSync(filePath, JSON.stringify(raw), 'utf8');
    expect(() => store.list()).toThrow(/extractedAtMs must be a finite number/);
  });
});
