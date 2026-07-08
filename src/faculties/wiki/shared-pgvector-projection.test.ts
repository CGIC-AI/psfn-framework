import { describe, expect, it, vi } from 'vitest';
import type { SharedWorldWikiStore } from './store.js';
import {
  resolveSharedWikiProjectionDecision,
  runSharedWorldWikiWrite,
} from './shared-pgvector-projection.js';

function fakeStore(siteId = 'studio'): SharedWorldWikiStore {
  return { siteId } as unknown as SharedWorldWikiStore;
}

describe('resolveSharedWikiProjectionDecision (write-surface gate)', () => {
  it('projects when Postgres and an embedder are available', () => {
    expect(resolveSharedWikiProjectionDecision({
      databaseUrl: 'postgres://x',
      embeddingAvailable: true,
      multiCompanion: true,
    })).toEqual({ action: 'project' });
  });

  it('flag-off without Postgres skips honestly (single-companion local surface keeps working)', () => {
    expect(resolveSharedWikiProjectionDecision({
      embeddingAvailable: true,
      multiCompanion: false,
    })).toEqual({ action: 'skip', reason: 'postgres_not_configured' });
  });

  it('flag-off without an embedder skips honestly', () => {
    expect(resolveSharedWikiProjectionDecision({
      databaseUrl: 'postgres://x',
      embeddingAvailable: false,
      multiCompanion: false,
    })).toEqual({ action: 'skip', reason: 'embedding_unavailable' });
  });

  it('multi-companion without Postgres fails closed (shared writes must be fleet-visible)', () => {
    expect(() => resolveSharedWikiProjectionDecision({
      embeddingAvailable: true,
      multiCompanion: true,
    })).toThrow(/postgresDatabaseUrl.*multi-companion/i);
  });

  it('multi-companion with a blank URL fails closed too (no whitespace loophole)', () => {
    expect(() => resolveSharedWikiProjectionDecision({
      databaseUrl: '   ',
      embeddingAvailable: true,
      multiCompanion: true,
    })).toThrow(/fail closed/i);
  });

  it('multi-companion without an embedder fails closed', () => {
    expect(() => resolveSharedWikiProjectionDecision({
      databaseUrl: 'postgres://x',
      embeddingAvailable: false,
      multiCompanion: true,
    })).toThrow(/embedding provider.*multi-companion/i);
  });
});

describe('runSharedWorldWikiWrite (write + projection coupling)', () => {
  it('flag-off without Postgres: the write runs and the outcome reports skipped, never silent success', async () => {
    const write = vi.fn(() => ({ ok: true }));
    const { report, projection } = await runSharedWorldWikiWrite({
      context: { multiCompanion: false },
      store: fakeStore('studio'),
      write,
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(report).toEqual({ ok: true });
    expect(projection).toMatchObject({
      siteId: 'studio',
      status: 'skipped',
      reason: 'postgres_not_configured',
    });
  });

  it('multi-companion without Postgres: fails closed BEFORE the filesystem write', async () => {
    const write = vi.fn(() => ({ ok: true }));
    await expect(runSharedWorldWikiWrite({
      context: { multiCompanion: true },
      store: fakeStore('studio'),
      write,
    })).rejects.toThrow(/fail closed/i);
    expect(write).not.toHaveBeenCalled();
  });

  it('multi-companion without an embedder: fails closed BEFORE the filesystem write', async () => {
    const write = vi.fn(() => ({ ok: true }));
    await expect(runSharedWorldWikiWrite({
      context: { databaseUrl: 'postgres://x', multiCompanion: true },
      store: fakeStore('studio'),
      write,
    })).rejects.toThrow(/embedding provider/i);
    expect(write).not.toHaveBeenCalled();
  });
});
