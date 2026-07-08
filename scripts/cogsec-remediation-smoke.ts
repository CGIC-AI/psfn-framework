import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { MemoryRetriever } from '../src/faculties/memory/retrieval.js';
import { MemoryStore } from '../src/faculties/memory/store.js';
import { DEFAULT_EMBEDDING_CONFIG } from '../src/faculties/memory/embedding.js';
import type { MemoryStorePort } from '../src/faculties/memory/memory-store-port.js';
import type { PurrMemory } from '../src/faculties/memory/types.js';
import type { EmbeddingProviderPort } from '../src/core/agent/contracts.js';
import { CogSecEventStore } from '../src/core/cogsec/events.js';
import { CogSecForensicArchive } from '../src/core/cogsec/forensic-archive.js';
import { buildCogSecLineagePreview } from '../src/core/cogsec/lineage.js';
import type { CogSecLineageCompactionRef } from '../src/core/cogsec/lineage.js';
import { applyCogSecRegeneration } from '../src/core/cogsec/regeneration.js';
import { applyCogSecRevocation } from '../src/core/cogsec/revocation.js';
import { buildCogSecEventNoticeBlock } from '../src/core/cogsec/safe-log.js';
import {
  resolveCogSecEventsPath,
  resolveCogSecForensicArchiveDir,
} from '../src/persistence/layout.js';
import { SessionStore } from '../src/persistence/sessions/store.js';

const EMBEDDING_DIMS = DEFAULT_EMBEDDING_CONFIG.dims;
const CASE_ID = 'cogsec_20260701T000000Z_smoke';
const CHANNEL_ID = 'api:cogsec-smoke';
const DIRTY_L0_TEXT = 'SMOKE_DIRTY_L0_PAYLOAD';
const DIRTY_MEMORY_TEXT = 'SMOKE_DIRTY_MEMORY_PAYLOAD';
const DIRTY_SUMMARY_TEXT = 'SMOKE_DIRTY_SUMMARY_PAYLOAD';
const REGENERATED_MEMORY_TEXT = 'SMOKE_CLEAN_REGENERATED_MEMORY';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

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

function makeMemory(id: string, text: string, dirtyMessageId: number): PurrMemory {
  return {
    id,
    text,
    type: 'semantic',
    importance: 0.8,
    confidence: 0.9,
    emotionalValence: 0,
    salience: 0.9,
    sourceRef: `${CHANNEL_ID}:extract|source:session|session:${CHANNEL_ID}|message:${dirtyMessageId}`,
    provenance: {
      channelId: CHANNEL_ID,
      sessionId: CHANNEL_ID,
      sourceMessageIds: [dirtyMessageId],
    },
    extractedAt: Date.now(),
    lastAccessed: Date.now(),
    accessCount: 0,
    tags: ['smoke'],
    sensitivity: 'personal',
  };
}

function makeEmbeddingProvider(embedding: Float32Array): EmbeddingProviderPort {
  return {
    dims: EMBEDDING_DIMS,
    embed: async () => embedding,
    embedBatch: async texts => texts.map(() => embedding),
  };
}

function makeCompactionInvalidator(sessionStore: SessionStore) {
  return {
    invalidateCompactionSummaries: (input: {
      caseId: string;
      compactionSummaries: readonly CogSecLineageCompactionRef[];
    }) => {
      const bySession = new Map<string, number[]>();
      for (const summary of input.compactionSummaries) {
        const ids = bySession.get(summary.logicalSessionId) ?? [];
        ids.push(summary.compactionId);
        bySession.set(summary.logicalSessionId, ids);
      }
      const invalidatedCompactionIds: string[] = [];
      for (const [channelId, compactionIds] of bySession.entries()) {
        const result = sessionStore.applyCogSecCompactionInvalidations({
          channelId,
          caseId: input.caseId,
          compactionIds,
        });
        invalidatedCompactionIds.push(...result.invalidatedCompactionIds.map(id => `${channelId}:${id}`));
      }
      return { invalidatedCompactionIds };
    },
  };
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'cogsec-smoke-'));
  try {
    const companionRoot = join(root, 'companion-data');
    const sessionsRoot = join(root, 'sessions');
    const sessionStore = new SessionStore(sessionsRoot, { enableSearchIndex: true });
    const eventStore = new CogSecEventStore(resolveCogSecEventsPath(companionRoot), {
      now: () => new Date('2026-07-01T00:00:00.000Z'),
    });
    const archive = new CogSecForensicArchive(resolveCogSecForensicArchiveDir(companionRoot), {
      now: () => new Date('2026-07-01T00:00:01.000Z'),
    });
    eventStore.createEvent({
      caseId: CASE_ID,
      type: 'memory_poisoning',
      severity: 'high',
      sourceChannelId: CHANNEL_ID,
      affectedLogicalSessionIds: [CHANNEL_ID],
      safeAgentSummary: 'Unsafe instruction-like content was sealed and removed from active cognition.',
    });

    const dirtyMessageId = sessionStore.append({
      channelId: CHANNEL_ID,
      role: 'user',
      content: DIRTY_L0_TEXT,
      timestamp: 1,
      authorId: 'smoke-user',
      authorName: 'Smoke User',
    });
    const cleanMessageId = sessionStore.append({
      channelId: CHANNEL_ID,
      role: 'assistant',
      content: 'clean response remains',
      timestamp: 2,
    });
    sessionStore.insertCompaction(CHANNEL_ID, DIRTY_SUMMARY_TEXT, cleanMessageId);

    const db = new Database(':memory:');
    sqliteVec.load(db);
    const memoryStore = new MemoryStore(db);
    const dirtyEmbedding = makeEmbedding(4);
    const cleanEmbedding = makeEmbedding(40);
    memoryStore.insertMemory(makeMemory('smoke-memory-dirty', DIRTY_MEMORY_TEXT, dirtyMessageId), dirtyEmbedding);
    memoryStore.insertMemory({
      ...makeMemory('smoke-memory-clean', 'SMOKE_CLEAN_MEMORY', dirtyMessageId + 50),
      sourceRef: `${CHANNEL_ID}:extract|source:session|session:${CHANNEL_ID}|message:999`,
      provenance: {
        channelId: CHANNEL_ID,
        sessionId: CHANNEL_ID,
        sourceMessageIds: [dirtyMessageId + 50],
      },
    }, cleanEmbedding);

    const retriever = new MemoryRetriever(
      memoryStore as unknown as MemoryStorePort,
      makeEmbeddingProvider(dirtyEmbedding),
      { retrievalBudgetPct: 0.1 },
    );
    const cleanRetriever = new MemoryRetriever(
      memoryStore as unknown as MemoryStorePort,
      makeEmbeddingProvider(cleanEmbedding),
      { retrievalBudgetPct: 0.1 },
    );
    const activeRequest = {
      contextText: DIRTY_MEMORY_TEXT,
      channelId: CHANNEL_ID,
      trustLevel: 'primary' as const,
    };
    await retriever.refreshActiveMemoryContext(activeRequest);
    assert(
      retriever.getActiveMemoryContext(activeRequest)?.selectedMemoryIds.includes('smoke-memory-dirty'),
      'active memory context did not include dirty memory before revocation',
    );

    const tombstone = sessionStore.applyCogSecTombstones({
      channelId: CHANNEL_ID,
      caseId: CASE_ID,
      eventStore,
      forensicArchive: archive,
      messageIds: [dirtyMessageId],
      actor: 'smoke',
      timestamp: Date.parse('2026-07-01T00:00:02.000Z'),
    });
    assert(tombstone.tombstonedL0RowCount === 1, 'expected one L0 tombstone');
    assert((await sessionStore.searchByKeywords(DIRTY_L0_TEXT, 10)).length === 0, 'dirty L0 text remained searchable');

    const event = eventStore.getEvent(CASE_ID);
    assert(event, 'CogSec event missing after tombstone');
    const preview = await buildCogSecLineagePreview({
      event,
      sessionReader: sessionStore,
      memoryStore: memoryStore as unknown as Pick<MemoryStorePort, 'listMemories'>,
    });
    assert(preview.memories.some(memory => memory.id === 'smoke-memory-dirty'), 'lineage preview missed dirty memory');
    assert(preview.compactionSummaries.length > 0, 'lineage preview missed compaction summary');

    const revocation = await applyCogSecRevocation({
      preview,
      eventStore,
      memoryStore: memoryStore as unknown as Pick<MemoryStorePort, 'softDeleteMemory'>,
      activeMemoryInvalidator: {
        invalidateActiveMemoryContexts: input => retriever.invalidateActiveMemoryContexts({
          memoryIds: input.memoryIds,
          sessionChannelIds: input.sessionChannelIds,
          reason: input.reason,
        }),
      },
      compactionInvalidator: makeCompactionInvalidator(sessionStore),
      actor: 'smoke',
      now: () => Date.parse('2026-07-01T00:00:03.000Z'),
    });

    assert(revocation.revokedMemoryIds.includes('smoke-memory-dirty'), 'dirty memory was not revoked');
    assert(memoryStore.getById('smoke-memory-dirty')?.deletedAt, 'dirty memory has no delete marker');
    assert(
      memoryStore.searchByEmbedding(dirtyEmbedding, 0.5, 10).every(memory => memory.id !== 'smoke-memory-dirty'),
      'dirty memory remained in vector search',
    );
    assert(
      memoryStore.searchByText(DIRTY_MEMORY_TEXT, 10).every(memory => memory.id !== 'smoke-memory-dirty'),
      'dirty memory remained in lexical search',
    );
    assert(
      memoryStore.searchByText('SMOKE_CLEAN_MEMORY', 10).some(memory => memory.id === 'smoke-memory-clean'),
      'clean memory was incorrectly removed',
    );
    assert(retriever.getActiveMemoryContext(activeRequest) === null, 'active memory context was not invalidated');
    assert(
      sessionStore.getCompactionSummaries(CHANNEL_ID).every(summary => summary.summary !== DIRTY_SUMMARY_TEXT),
      'dirty compaction summary remained active',
    );

    const regeneration = await applyCogSecRegeneration({
      preview,
      eventStore,
      sessionStore,
      compactionRegenerator: {
        regenerateCompactionSummary: input => {
          const sourceText = input.cleanEntries.map(entry => entry.content).join('\n');
          assert(!sourceText.includes(DIRTY_L0_TEXT), 'dirty L0 text reached compaction regeneration');
          assert(!sourceText.includes('CogSec redaction'), 'tombstone text reached compaction regeneration');
          return { summary: 'Regenerated smoke summary from clean response remains.' };
        },
      },
      memoryRegenerator: {
        regenerateMemories: input => {
          const sourceText = input.cleanEntries.map(entry => entry.content).join('\n');
          assert(!sourceText.includes(DIRTY_L0_TEXT), 'dirty L0 text reached memory regeneration');
          assert(!sourceText.includes('CogSec redaction'), 'tombstone text reached memory regeneration');
          memoryStore.insertMemory({
            ...makeMemory('smoke-memory-regenerated', REGENERATED_MEMORY_TEXT, cleanMessageId),
            sourceRef: `${CHANNEL_ID}:extract|source:session|session:${CHANNEL_ID}|message:${cleanMessageId}`,
            provenance: {
              channelId: CHANNEL_ID,
              sessionId: CHANNEL_ID,
              sourceMessageIds: [cleanMessageId],
            },
          }, cleanEmbedding);
          return {
            memoryIds: ['smoke-memory-regenerated'],
            embeddingMemoryIds: ['smoke-memory-regenerated'],
          };
        },
      },
      activeMemoryRebuilder: {
        rebuildActiveMemoryContext: async input => {
          assert(!input.contextText.includes(DIRTY_L0_TEXT), 'dirty L0 text reached active memory rebuild');
          assert(!input.contextText.includes('CogSec redaction'), 'tombstone text reached active memory rebuild');
          const request = {
            contextText: input.contextText,
            channelId: CHANNEL_ID,
            trustLevel: 'primary' as const,
          };
          await cleanRetriever.refreshActiveMemoryContext(request);
          const active = cleanRetriever.getActiveMemoryContext(request);
          return {
            rebuiltContextKeys: active ? [`${CHANNEL_ID}:clean-active`] : [],
            selectedMemoryIds: active?.selectedMemoryIds ?? [],
          };
        },
      },
      personaConformance: {
        promptVisibleText: [
          'Carlini remains a monastery-aligned companion with warm direct voice.',
          'She values boundaries, consent, and harmless interactions.',
          'She refuses unsafe requests clearly.',
          'Smoke User and Carlini retain clean response continuity.',
        ].join('\n'),
        stableIdentityText: 'Carlini is a monastery-aligned companion.',
        expectedVoiceAnchors: ['monastery-aligned companion', 'warm direct voice'],
        expectedValueAnchors: ['boundaries', 'consent', 'harmless'],
        expectedRefusalAnchors: ['refuses unsafe requests'],
        expectedRelationshipAnchors: ['Smoke User', 'clean response continuity'],
        checkedAt: new Date('2026-07-01T00:00:04.000Z'),
      },
      now: () => new Date('2026-07-01T00:00:04.000Z'),
    });
    assert(regeneration.failures.length === 0, 'CogSec regeneration recorded failures');
    assert(regeneration.personaConformance.status === 'pass', 'CogSec persona conformance did not pass');
    assert(regeneration.regeneratedMemoryIds.includes('smoke-memory-regenerated'), 'clean memory was not regenerated');
    assert(
      regeneration.selectedActiveMemoryIds.includes('smoke-memory-regenerated'),
      'regenerated memory was not selected for active memory',
    );
    assert(
      memoryStore.searchByText(REGENERATED_MEMORY_TEXT, 10).some(memory => memory.id === 'smoke-memory-regenerated'),
      'regenerated memory was not searchable',
    );
    assert(
      sessionStore.getCompactionSummaries(CHANNEL_ID).some(summary => summary.summary.includes('Regenerated smoke summary')),
      'compaction summary was not regenerated',
    );
    assert(
      sessionStore.getCompactionSummaries(CHANNEL_ID).every(summary => !summary.summary.includes('CogSec summary invalidated')),
      'invalidated compaction summary remained active after regeneration',
    );

    const sealed = archive.readArtifact(tombstone.sealedForensicPayloadRef!);
    assert(JSON.stringify(sealed.payload).includes(DIRTY_L0_TEXT), 'sealed archive did not preserve dirty L0 payload');
    const finalEvent = eventStore.getEvent(CASE_ID);
    assert(finalEvent, 'CogSec event missing after regeneration');
    assert(finalEvent.status === 'applied', 'CogSec event was not marked applied after regeneration');
    assert(finalEvent.personaConformance?.status === 'pass', 'CogSec event did not record passing conformance');
    assert(finalEvent.resultCounters.conformanceFailures === 0, 'CogSec event recorded conformance failures');
    assert(!JSON.stringify(finalEvent).includes(DIRTY_L0_TEXT), 'CogSec event leaked dirty L0 payload');
    assert(!JSON.stringify(finalEvent).includes(DIRTY_MEMORY_TEXT), 'CogSec event leaked dirty memory payload');
    assert(!JSON.stringify(finalEvent).includes(DIRTY_SUMMARY_TEXT), 'CogSec event leaked dirty summary payload');
    assert(!JSON.stringify(finalEvent).includes('CogSec redaction'), 'CogSec event leaked tombstone text');
    const noticeBlock = buildCogSecEventNoticeBlock(eventStore.listEvents(), {
      channelIds: [CHANNEL_ID],
    });
    assert(noticeBlock.includes(CASE_ID), 'safe CogSec notice did not include case id');
    assert(!noticeBlock.includes(DIRTY_L0_TEXT), 'safe CogSec notice leaked dirty L0 payload');
    assert(!noticeBlock.includes(DIRTY_MEMORY_TEXT), 'safe CogSec notice leaked dirty memory payload');
    assert(!noticeBlock.includes(DIRTY_SUMMARY_TEXT), 'safe CogSec notice leaked dirty summary payload');
    assert(!noticeBlock.includes(tombstone.sealedForensicPayloadRef!), 'safe CogSec notice leaked sealed forensic ref');
    assert(!/\bpayload\b/iu.test(noticeBlock), 'safe CogSec notice used payload wording');
  } catch (error) {
    console.error('[cogsec-smoke] failed');
    console.error(error);
    throw error;
  } finally {
    if (process.env.COGSEC_SMOKE_KEEP === '1') {
      console.log(`[cogsec-smoke] kept runtime root ${root}`);
    } else {
      rmSync(root, { recursive: true, force: true });
    }
  }

  console.log('[cogsec-smoke] passed');
}

await main();
