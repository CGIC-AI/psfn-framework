import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../faculties/memory/store.js';
import { DEFAULT_EMBEDDING_CONFIG } from '../../faculties/memory/embedding.js';
import type { MemoryStorePort } from '../../faculties/memory/memory-store-port.js';
import type { PurrMemory } from '../../faculties/memory/types.js';
import { SessionStore } from '../../persistence/sessions/store.js';
import { CogSecEventStore } from './events.js';
import type { CogSecLineageCompactionRef, CogSecLineagePreview } from './lineage.js';
import { applyCogSecRevocation } from './revocation.js';

const SAFE_SUMMARY = 'Unsafe instruction-like content was sealed and removed from active cognition.';
const EMBEDDING_DIMS = DEFAULT_EMBEDDING_CONFIG.dims;

let tempRoot: string | null = null;

function makeTempRoot(): string {
  tempRoot = mkdtempSync(join(tmpdir(), 'psfn-cogsec-revocation-'));
  return tempRoot;
}

afterEach(() => {
  if (tempRoot) {
    rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

function makeEmbedding(seed = 0): Float32Array {
  const arr = new Float32Array(EMBEDDING_DIMS);
  for (let i = 0; i < EMBEDDING_DIMS; i += 1) {
    arr[i] = Math.sin(seed + i * 0.1);
  }
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIMS; i += 1) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < EMBEDDING_DIMS; i += 1) arr[i] /= norm;
  return arr;
}

function makeMemory(id: string, text: string, overrides: Partial<PurrMemory> = {}): PurrMemory {
  return {
    id,
    text,
    type: 'semantic',
    importance: 0.7,
    confidence: 0.9,
    emotionalValence: 0,
    salience: 0.8,
    sourceRef: 'discord-room:extract|source:session|session:logical-session|message:4',
    extractedAt: 1,
    lastAccessed: 1,
    accessCount: 0,
    tags: [],
    sensitivity: 'personal',
    ...overrides,
  };
}

function createEventStore(root: string, caseId: string): CogSecEventStore {
  const store = new CogSecEventStore(join(root, 'cogsec-events.json'), {
    now: () => new Date('2026-07-01T00:00:00.000Z'),
  });
  store.createEvent({
    caseId,
    type: 'memory_poisoning',
    severity: 'high',
    sourceChannelId: 'discord-room',
    affectedLogicalSessionIds: ['logical-session'],
    safeAgentSummary: SAFE_SUMMARY,
  });
  return store;
}

function basePreview(caseId: string): CogSecLineagePreview {
  return {
    caseId,
    sourceChannelId: 'discord-room',
    affectedLogicalSessionIds: ['logical-session'],
    l0Messages: [],
    transcriptProjectionRows: [],
    memories: [],
    embeddingMemoryRows: [],
    compactionSummaries: [],
    externalArtifacts: [],
    gaps: [],
  };
}

function makeCompactionInvalidator(sessionStore: SessionStore) {
  return {
    invalidateCompactionSummaries: (input: {
      caseId: string;
      compactionSummaries: readonly CogSecLineageCompactionRef[];
    }) => {
      const ids: string[] = [];
      const bySession = new Map<string, number[]>();
      for (const summary of input.compactionSummaries) {
        const current = bySession.get(summary.logicalSessionId) ?? [];
        current.push(summary.compactionId);
        bySession.set(summary.logicalSessionId, current);
      }
      for (const [channelId, compactionIds] of bySession.entries()) {
        const result = sessionStore.applyCogSecCompactionInvalidations({
          channelId,
          caseId: input.caseId,
          compactionIds,
        });
        ids.push(...result.invalidatedCompactionIds.map(id => `${channelId}:${id}`));
      }
      return { invalidatedCompactionIds: ids };
    },
  };
}

describe('applyCogSecRevocation', () => {
  it('soft-deletes tainted memories, invalidates summaries and caches, and records safe event metadata', async () => {
    const root = makeTempRoot();
    const caseId = 'cogsec_20260701T000000Z_revoke';
    const eventStore = createEventStore(root, caseId);
    const db = new Database(':memory:');
    sqliteVec.load(db);
    const memoryStore = new MemoryStore(db);
    const taintedEmbedding = makeEmbedding(1);
    const cleanEmbedding = makeEmbedding(2);
    memoryStore.insertMemory(
      makeMemory('memory-tainted', 'dirty payload memory that must be revoked'),
      taintedEmbedding,
    );
    memoryStore.insertMemory(
      makeMemory('memory-clean', 'clean deployment memory', {
        sourceRef: 'discord-room:extract|source:session|session:logical-session|message:90',
      }),
      cleanEmbedding,
    );

    const sessionStore = new SessionStore(join(root, 'sessions'));
    sessionStore.append({
      channelId: 'logical-session',
      role: 'user',
      content: 'clean row',
      timestamp: 1,
    });
    sessionStore.insertCompaction(
      'logical-session',
      'dirty summary text that must be invalidated',
      1,
    );
    const compaction = sessionStore.getCompactionSummaries('logical-session')[0];
    expect(compaction).toBeDefined();

    const activeInvalidator = {
      invalidateActiveMemoryContexts: vi.fn().mockResolvedValue({
        invalidatedContextCount: 1,
        invalidatedMemoryEntryCount: 1,
        invalidatedKeys: ['active-memory-key'],
      }),
    };
    const externalInvalidator = {
      invalidateCogSecArtifacts: vi.fn().mockResolvedValue({
        invalidatedArtifactIds: ['episode-1'],
      }),
    };
    const preview: CogSecLineagePreview = {
      ...basePreview(caseId),
      memories: [
        {
          id: 'memory-tainted',
          classification: 'tainted',
          reason: 'provenance_message_id_intersects_affected_range',
          provenanceRefs: [],
          hasEmbedding: true,
          actions: ['revoke', 'regenerate'],
        },
        {
          id: 'memory-review',
          classification: 'uncertain',
          reason: 'provenance_session_match_without_message_granularity',
          provenanceRefs: [],
          hasEmbedding: false,
          actions: ['manual_review'],
        },
      ],
      embeddingMemoryRows: [
        {
          id: 'memory-tainted',
          classification: 'tainted',
          reason: 'provenance_message_id_intersects_affected_range',
          provenanceRefs: [],
          hasEmbedding: true,
          actions: ['revoke', 'regenerate'],
        },
      ],
      compactionSummaries: [{
        logicalSessionId: 'logical-session',
        compactionId: compaction!.id,
        coveredUpTo: compaction!.coveredUpTo,
        classification: 'uncertain',
        reason: 'compaction_summary_covers_or_may_cover_affected_l0_range',
        actions: ['regenerate'],
      }],
      externalArtifacts: [
        {
          artifactClass: 'episodic_landmark',
          id: 'episode-1',
          classification: 'tainted',
          reason: 'structured_ref_matches_affected_session',
          actions: ['revoke', 'regenerate'],
        },
        {
          artifactClass: 'profile_artifact',
          id: 'profile-review',
          classification: 'uncertain',
          reason: 'structured_ref_session_match_without_message_granularity',
          actions: ['manual_review'],
        },
      ],
      gaps: [{ artifactClass: 'focus_knowledge', reason: 'external_artifact_provider_not_provided' }],
    };

    expect(memoryStore.searchByEmbedding(taintedEmbedding, 0.5, 10).map(memory => memory.id)).toContain('memory-tainted');
    expect(memoryStore.searchByText('dirty payload memory', 10).map(memory => memory.id)).toContain('memory-tainted');

    const result = await applyCogSecRevocation({
      preview,
      eventStore,
      memoryStore: memoryStore as unknown as Pick<MemoryStorePort, 'softDeleteMemory'>,
      activeMemoryInvalidator: activeInvalidator,
      compactionInvalidator: makeCompactionInvalidator(sessionStore),
      externalArtifactInvalidator: externalInvalidator,
      actor: 'operator:test',
      now: () => Date.parse('2026-07-01T00:02:00.000Z'),
    });

    expect(result.revokedMemoryIds).toEqual(['memory-tainted']);
    expect(result.manualReviewMemoryIds).toEqual(['memory-review']);
    expect(result.revokedEmbeddingMemoryIds).toEqual(['memory-tainted']);
    expect(result.invalidatedActiveMemoryKeys).toEqual(['active-memory-key']);
    expect(result.invalidatedCompactionSummaryIds).toEqual([`logical-session:${compaction!.id}`]);
    expect(result.invalidatedExternalArtifactIds).toEqual(['episode-1']);
    expect(result.manualReviewExternalArtifactIds).toEqual(['profile-review']);
    expect(result.failures).toEqual([]);

    expect(memoryStore.getById('memory-tainted')?.deletedAt).toBe(Date.parse('2026-07-01T00:02:00.000Z'));
    expect(memoryStore.getById('memory-tainted')?.deleteReason).toContain(caseId);
    expect(memoryStore.getById('memory-clean')?.deletedAt).toBeUndefined();
    expect(memoryStore.searchByEmbedding(taintedEmbedding, 0.5, 10).map(memory => memory.id)).not.toContain('memory-tainted');
    expect(memoryStore.searchByText('dirty payload memory', 10).map(memory => memory.id)).not.toContain('memory-tainted');
    expect(memoryStore.searchByText('clean deployment memory', 10).map(memory => memory.id)).toEqual(['memory-clean']);

    expect(sessionStore.getCompactionSummaries('logical-session')[0]?.summary).toBe(
      '[CogSec summary invalidated: cogsec_20260701T000000Z_revoke]',
    );
    expect(activeInvalidator.invalidateActiveMemoryContexts).toHaveBeenCalledWith({
      caseId,
      memoryIds: ['memory-tainted'],
      sessionChannelIds: ['logical-session'],
      reason: 'cogsec_revocation',
    });

    const event = eventStore.getEvent(caseId);
    expect(event?.actions).toEqual(['revoke', 'regenerate']);
    expect(event?.affectedArtifacts.memories?.ids).toEqual(['memory-tainted']);
    expect(event?.affectedArtifacts.embeddings?.ids).toEqual(['memory-tainted']);
    expect(event?.affectedArtifacts.active_memory_entries?.ids).toEqual(['active-memory-key']);
    expect(event?.affectedArtifacts.compaction_summaries?.ids).toEqual([`logical-session:${compaction!.id}`]);
    expect(event?.affectedArtifacts.episodic_landmarks?.ids).toEqual(['episode-1']);
    expect(event?.resultCounters.revokedArtifacts).toBe(5);
    expect(event?.resultCounters.lineageGaps).toBe(3);
    expect(JSON.stringify(event)).not.toContain('dirty payload memory');
    expect(JSON.stringify(event)).not.toContain('dirty summary text');
  });

  it('records safe failure details without storing raw exception text', async () => {
    const root = makeTempRoot();
    const caseId = 'cogsec_20260701T000000Z_fail';
    const eventStore = createEventStore(root, caseId);
    const preview: CogSecLineagePreview = {
      ...basePreview(caseId),
      affectedLogicalSessionIds: [],
      memories: [{
        id: 'memory-fails',
        classification: 'tainted',
        reason: 'provenance_message_id_intersects_affected_range',
        provenanceRefs: [],
        hasEmbedding: true,
        actions: ['revoke'],
      }],
      embeddingMemoryRows: [{
        id: 'memory-fails',
        classification: 'tainted',
        reason: 'provenance_message_id_intersects_affected_range',
        provenanceRefs: [],
        hasEmbedding: true,
        actions: ['revoke'],
      }],
    };
    const memoryStore = {
      softDeleteMemory: vi.fn().mockRejectedValue(new Error('raw dirty payload should not be copied')),
    };

    const result = await applyCogSecRevocation({
      preview,
      eventStore,
      memoryStore,
      activeMemoryInvalidator: {
        invalidateActiveMemoryContexts: vi.fn().mockResolvedValue({
          invalidatedContextCount: 0,
          invalidatedMemoryEntryCount: 0,
          invalidatedKeys: [],
        }),
      },
    });

    expect(result.failures).toEqual([{
      artifactClass: 'memories',
      artifactId: 'memory-fails',
      operation: 'soft_delete',
      reason: 'soft_delete_failed',
    }]);
    const event = eventStore.getEvent(caseId);
    expect(event?.failureDetails).toContain('memory-fails soft_delete soft_delete_failed');
    expect(event?.failureDetails).not.toContain('raw dirty payload');
    expect(JSON.stringify(event)).not.toContain('raw dirty payload');
  });
});
