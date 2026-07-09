import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDriftReviewCardStore,
  type DriftReviewCardCreateInput,
  type DriftReviewCardStore,
} from './drift-review-card-store.js';
import type { DriftSignalResult } from './drift-signals.js';

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
    expect(cards[0]!.contactId).toBe('contact-2');
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
});
