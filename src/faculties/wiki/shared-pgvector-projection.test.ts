import { describe, expect, it, vi } from 'vitest';
import type { SharedWorldWikiStore } from './store.js';
import type { EmbeddingProviderPort } from '../../shared/contracts/embedding-provider.js';
import {
  resolveSharedWikiProjectionDecision,
  runSharedWorldWikiWrite,
  SharedWikiPgvectorProjectionStore,
} from './shared-pgvector-projection.js';
import type { WikiDocument } from './types.js';

vi.mock('../../persistence/postgres.js', () => ({
  createPostgresPool: vi.fn(),
  queryRows: vi.fn(async () => []),
  withPostgresClient: vi.fn(async () => undefined),
}));

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

describe('SharedWikiPgvectorProjectionStore usage attribution', () => {
  it('classifies a shared projection by site and canonical document id', async () => {
    const embedBatch = vi.fn(async () => [new Float32Array(8)]);
    const embedding = {
      dims: 8,
      embed: vi.fn(),
      embedBatch,
    } as unknown as EmbeddingProviderPort;
    const store = new SharedWikiPgvectorProjectionStore({} as never, embedding);
    const document: WikiDocument = {
      schemaVersion: 1,
      id: 'room-state',
      title: 'Room state',
      bodyPath: 'documents/room-state.md',
      bodyFormat: 'markdown',
      tags: [],
      sourceClass: 'companion_authored_note',
      provenanceRefs: [],
      sensitivity: 'personal',
      scope: 'shared_world:studio',
      createdAt: '2026-08-17T00:00:00.000Z',
      updatedAt: '2026-08-17T00:00:00.000Z',
      updatedBy: 'agent',
      version: 1,
      bodySha256: 'sha',
      body: 'The satellite is online.',
    };

    await expect(store.syncDocument('studio', document)).resolves.toMatchObject({ status: 'ran' });
    expect(embedBatch).toHaveBeenCalledWith(['The satellite is online.'], {
      usageProvenance: {
        callType: 'scheduled',
        purpose: 'wiki.shared_projection',
        originType: 'scheduled',
        originStage: 'wiki.shared_projection',
        service: 'wiki',
        process: 'shared-projection',
        runtimeLaneClass: 'maintenance_reflection',
        workloadType: 'shared_wiki_projection',
        workloadId: expect.stringMatching(/^shared-wiki-projection:[a-f0-9]{64}$/),
      },
    });
    const options = embedBatch.mock.calls[0]?.[1];
    expect(options?.usageProvenance?.workloadId).not.toContain('studio');
    expect(options?.usageProvenance?.workloadId).not.toContain(document.id);
  });
});
