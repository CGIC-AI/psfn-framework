import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingProviderPort } from '../agent/contracts.js';
import { DEFAULT_EMBEDDING_CONFIG } from '../../faculties/memory/embedding.js';
import type { MemoryStorePort } from '../../faculties/memory/memory-store-port.js';
import { MemoryRetriever } from '../../faculties/memory/retrieval.js';
import { MemoryStore } from '../../faculties/memory/store.js';
import type { PurrMemory } from '../../faculties/memory/types.js';
import { SessionStore } from '../../persistence/sessions/store.js';
import { CogSecEventStore } from './events.js';
import { CogSecForensicArchive } from './forensic-archive.js';
import type { CogSecLineagePreview } from './lineage.js';
import { applyCogSecRegeneration } from './regeneration.js';

const EMBEDDING_DIMS = DEFAULT_EMBEDDING_CONFIG.dims;
const SAFE_SUMMARY = 'Unsafe instruction-like content was sealed and removed from active cognition.';

let tempRoot: string | null = null;

function makeTempRoot(): string {
  tempRoot = mkdtempSync(join(tmpdir(), 'psfn-cogsec-regeneration-'));
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

function makeEmbeddingProvider(embedding: Float32Array): EmbeddingProviderPort {
  return {
    dims: EMBEDDING_DIMS,
    embed: async () => embedding,
    embedBatch: async texts => texts.map(() => embedding),
  };
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
    sourceRef: 'api:cogsec-regeneration:extract|source:session|session:api:cogsec-regeneration|message:2',
    extractedAt: 1,
    lastAccessed: 1,
    accessCount: 0,
    tags: [],
    sensitivity: 'personal',
    ...overrides,
  };
}

describe('applyCogSecRegeneration', () => {
  it('regenerates clean cognitive artifacts without reusing tombstones or sealed content', async () => {
    const root = makeTempRoot();
    const caseId = 'cogsec_20260701T000000Z_regen';
    const channelId = 'api:cogsec-regeneration';
    const dirtyText = 'DIRTY_REGENERATION_SOURCE_TEXT';
    const cleanText = 'clean recovery source text';
    const sessionStore = new SessionStore(join(root, 'sessions'), { enableSearchIndex: true });
    const eventStore = new CogSecEventStore(join(root, 'cogsec-events.json'), {
      now: () => new Date('2026-07-01T00:00:00.000Z'),
    });
    const archive = new CogSecForensicArchive(join(root, 'forensic'));
    eventStore.createEvent({
      caseId,
      type: 'memory_poisoning',
      severity: 'high',
      sourceChannelId: channelId,
      affectedLogicalSessionIds: [channelId],
      safeAgentSummary: SAFE_SUMMARY,
    });

    const cleanBeforeId = sessionStore.append({
      channelId,
      role: 'user',
      content: cleanText,
      timestamp: 1,
      authorName: 'Clean User',
    });
    const dirtyId = sessionStore.append({
      channelId,
      role: 'user',
      content: dirtyText,
      timestamp: 2,
      authorName: 'Dirty User',
    });
    const cleanAfterId = sessionStore.append({
      channelId,
      role: 'assistant',
      content: 'clean assistant follow-up',
      timestamp: 3,
    });
    sessionStore.insertCompaction(channelId, 'dirty summary should be removed', cleanAfterId);
    const compaction = sessionStore.getCompactionSummaries(channelId)[0];
    expect(compaction).toBeDefined();

    sessionStore.applyCogSecTombstones({
      channelId,
      caseId,
      eventStore,
      forensicArchive: archive,
      messageIds: [dirtyId],
      actor: 'test',
      timestamp: Date.parse('2026-07-01T00:01:00.000Z'),
    });
    sessionStore.applyCogSecCompactionInvalidations({
      channelId,
      caseId,
      compactionIds: [compaction!.id],
    });
    await expect(sessionStore.searchByKeywords(dirtyText, 10)).resolves.toHaveLength(0);
    await expect(sessionStore.searchByKeywords('CogSec redaction', 10)).resolves.toHaveLength(0);

    const db = new Database(':memory:');
    sqliteVec.load(db);
    const memoryStore = new MemoryStore(db);
    const cleanEmbedding = makeEmbedding(3);
    memoryStore.insertMemory(makeMemory('revoked-memory', 'dirty memory already revoked', {
      deletedAt: Date.parse('2026-07-01T00:02:00.000Z'),
      deletedBy: 'cogsec',
      deleteReason: `CogSec revocation ${caseId}`,
    }), makeEmbedding(2));
    const retriever = new MemoryRetriever(
      memoryStore as unknown as MemoryStorePort,
      makeEmbeddingProvider(cleanEmbedding),
      { retrievalBudgetPct: 0.1 },
    );

    const preview: CogSecLineagePreview = {
      caseId,
      sourceChannelId: channelId,
      affectedLogicalSessionIds: [channelId],
      l0Messages: [{
        logicalSessionId: channelId,
        sourceChannelId: channelId,
        messageId: dirtyId,
        classification: 'tainted',
        reason: 'operator_selected_l0_message',
        actions: ['seal', 'tombstone'],
      }],
      transcriptProjectionRows: [{
        channelId,
        messageId: dirtyId,
        classification: 'tainted',
        reason: 'projection_row_for_affected_l0_message',
        actions: ['search_exclude', 'regenerate'],
      }],
      memories: [{
        id: 'revoked-memory',
        classification: 'tainted',
        reason: 'provenance_message_id_intersects_affected_range',
        provenanceRefs: [],
        hasEmbedding: true,
        actions: ['revoke', 'regenerate'],
      }],
      embeddingMemoryRows: [{
        id: 'revoked-memory',
        classification: 'tainted',
        reason: 'provenance_message_id_intersects_affected_range',
        provenanceRefs: [],
        hasEmbedding: true,
        actions: ['revoke', 'regenerate'],
      }],
      compactionSummaries: [{
        logicalSessionId: channelId,
        compactionId: compaction!.id,
        coveredUpTo: compaction!.coveredUpTo,
        classification: 'uncertain',
        reason: 'compaction_summary_covers_or_may_cover_affected_l0_range',
        actions: ['regenerate'],
      }],
      externalArtifacts: [],
      gaps: [],
    };

    const compactionRegenerator = {
      regenerateCompactionSummary: vi.fn(async (input) => {
        const contents = input.cleanEntries.map(entry => entry.content);
        expect(contents).toContain(cleanText);
        expect(contents).toContain('clean assistant follow-up');
        expect(contents).not.toContain(dirtyText);
        expect(contents.some(content => content.includes('CogSec redaction'))).toBe(false);
        return { summary: 'Regenerated clean summary from clean recovery source text.' };
      }),
    };
    const memoryRegenerator = {
      regenerateMemories: vi.fn(async (input) => {
        const contents = input.cleanEntries.map(entry => entry.content);
        expect(contents).toContain(cleanText);
        expect(contents).not.toContain(dirtyText);
        expect(contents.some(content => content.includes('CogSec redaction'))).toBe(false);
        const memory = makeMemory('regenerated-memory', 'regenerated clean memory from clean recovery source text', {
          sourceRef: `${channelId}:extract|source:session|session:${channelId}|message:${cleanBeforeId}`,
          provenance: {
            channelId,
            sessionId: channelId,
            sourceMessageIds: [cleanBeforeId],
          },
        });
        memoryStore.insertMemory(memory, cleanEmbedding);
        return {
          memoryIds: [memory.id],
          embeddingMemoryIds: [memory.id],
        };
      }),
    };
    const activeMemoryRebuilder = {
      rebuildActiveMemoryContext: vi.fn(async (input) => {
        expect(input.contextText).toContain(cleanText);
        expect(input.contextText).not.toContain(dirtyText);
        expect(input.contextText).not.toContain('CogSec redaction');
        const request = {
          contextText: input.contextText,
          channelId,
          trustLevel: 'primary' as const,
        };
        await retriever.refreshActiveMemoryContext(request);
        const active = retriever.getActiveMemoryContext(request);
        return {
          rebuiltContextKeys: active ? [`${channelId}:active`] : [],
          selectedMemoryIds: active?.selectedMemoryIds ?? [],
        };
      }),
    };

    const result = await applyCogSecRegeneration({
      preview,
      eventStore,
      sessionStore,
      compactionRegenerator,
      memoryRegenerator,
      activeMemoryRebuilder,
      personaConformance: {
        promptVisibleText: [
          'Carlini remains a monastery-aligned companion with warm direct voice.',
          'She values boundaries, consent, and harmless interactions.',
          'She refuses unsafe requests clearly.',
          'Clean User and Carlini retain clean recovery source text continuity.',
        ].join('\n'),
        stableIdentityText: 'Carlini is a monastery-aligned companion.',
        expectedVoiceAnchors: ['monastery-aligned companion', 'warm direct voice'],
        expectedValueAnchors: ['boundaries', 'consent', 'harmless'],
        expectedRefusalAnchors: ['refuses unsafe requests'],
        expectedRelationshipAnchors: ['Clean User', 'clean recovery source text continuity'],
        checkedAt: new Date('2026-07-01T00:03:00.000Z'),
      },
      now: () => new Date('2026-07-01T00:03:00.000Z'),
    });

    expect(result.failures).toEqual([]);
    expect(result.personaConformance.status).toBe('pass');
    expect(result.rebuiltProjection).toBe(true);
    expect(result.regeneratedCompactionSummaryIds).toEqual([`${channelId}:${compaction!.id}`]);
    expect(result.regeneratedMemoryIds).toEqual(['regenerated-memory']);
    expect(result.regeneratedEmbeddingMemoryIds).toEqual(['regenerated-memory']);
    expect(result.selectedActiveMemoryIds).toContain('regenerated-memory');
    expect(sessionStore.getCompactionSummaries(channelId)[0]?.summary).toBe(
      'Regenerated clean summary from clean recovery source text.',
    );
    await expect(sessionStore.searchByKeywords(dirtyText, 10)).resolves.toHaveLength(0);
    await expect(sessionStore.searchByKeywords('CogSec redaction', 10)).resolves.toHaveLength(0);
    await expect(sessionStore.searchByKeywords(cleanText, 10)).resolves.toHaveLength(1);
    expect(memoryStore.searchByText('dirty memory', 10).map(memory => memory.id)).not.toContain('revoked-memory');
    expect(memoryStore.searchByText('regenerated clean memory', 10).map(memory => memory.id)).toContain('regenerated-memory');

    const event = eventStore.getEvent(caseId);
    expect(event?.status).toBe('applied');
    expect(event?.personaConformance?.status).toBe('pass');
    expect(event?.resultCounters.conformanceFailures).toBe(0);
    expect(event?.actions).toContain('regenerate');
    expect(event?.affectedArtifacts.memories?.ids).toContain('regenerated-memory');
    expect(event?.affectedArtifacts.embeddings?.ids).toContain('regenerated-memory');
    expect(event?.affectedArtifacts.compaction_summaries?.ids).toContain(`${channelId}:${compaction!.id}`);
    expect(event?.affectedArtifacts.transcript_projection_rows?.ids).toContain(`${channelId}:${dirtyId}`);
    expect(event?.affectedArtifacts.search_index_rows?.ids).toContain(`${channelId}:${dirtyId}`);
    expect(event?.affectedArtifacts.active_memory_entries?.ids).toContain(`${channelId}:active`);
    expect(event?.resultCounters.regeneratedArtifacts).toBeGreaterThan(0);
    expect(JSON.stringify(event)).not.toContain(dirtyText);
    expect(JSON.stringify(event)).not.toContain('dirty summary should be removed');
    expect(JSON.stringify(event)).not.toContain('CogSec redaction');
  });

  it('fails the CogSec event when persona conformance detects generic-assistant drift', async () => {
    const root = makeTempRoot();
    const caseId = 'cogsec_20260701T000000Z_regen_conformance_fail';
    const channelId = 'api:cogsec-conformance-fail';
    const sessionStore = new SessionStore(join(root, 'sessions'), { enableSearchIndex: true });
    sessionStore.append({
      channelId,
      role: 'assistant',
      content: 'clean context row',
      timestamp: 1,
    });
    const eventStore = new CogSecEventStore(join(root, 'cogsec-events.json'), {
      now: () => new Date('2026-07-01T00:00:00.000Z'),
    });
    eventStore.createEvent({
      caseId,
      type: 'persona_poisoning',
      severity: 'high',
      sourceChannelId: channelId,
      affectedLogicalSessionIds: [channelId],
      safeAgentSummary: SAFE_SUMMARY,
    });
    const preview: CogSecLineagePreview = {
      caseId,
      sourceChannelId: channelId,
      affectedLogicalSessionIds: [channelId],
      l0Messages: [],
      transcriptProjectionRows: [],
      memories: [],
      embeddingMemoryRows: [],
      compactionSummaries: [],
      externalArtifacts: [],
      gaps: [],
    };

    const result = await applyCogSecRegeneration({
      preview,
      eventStore,
      sessionStore,
      personaConformance: {
        promptVisibleText: [
          'Carlini remains a monastery-aligned companion.',
          'She keeps boundaries and refuses unsafe requests.',
          'Vega continuity is intact.',
          'The regenerated profile also calls Carlini a helpful AI assistant.',
        ].join('\n'),
        stableIdentityText: 'Carlini is a monastery-aligned companion.',
        expectedVoiceAnchors: ['monastery-aligned companion'],
        expectedValueAnchors: ['boundaries'],
        expectedRefusalAnchors: ['refuses unsafe requests'],
        expectedRelationshipAnchors: ['Vega'],
        checkedAt: new Date('2026-07-01T00:03:00.000Z'),
      },
      now: () => new Date('2026-07-01T00:03:00.000Z'),
    });

    expect(result.failures).toEqual([]);
    expect(result.personaConformance.status).toBe('fail');
    expect(result.personaConformance.checks).toContainEqual(expect.objectContaining({
      id: 'assistant_genericness',
      status: 'fail',
      reasonCodes: expect.arrayContaining(['generic_assistant_marker_visible']),
    }));
    const event = eventStore.getEvent(caseId);
    expect(event?.status).toBe('failed');
    expect(event?.appliedAt).toBeUndefined();
    expect(event?.failureDetails).toBe('CogSec persona conformance failed 1 check(s).');
    expect(event?.personaConformance?.status).toBe('fail');
    expect(event?.resultCounters.conformanceFailures).toBe(1);
    expect(JSON.stringify(event)).not.toContain('helpful AI assistant');
  });

  it('records safe regeneration failures without copying raw error text', async () => {
    const root = makeTempRoot();
    const caseId = 'cogsec_20260701T000000Z_regen_fail';
    const channelId = 'api:cogsec-regeneration-fail';
    const sessionStore = new SessionStore(join(root, 'sessions'), { enableSearchIndex: true });
    sessionStore.append({
      channelId,
      role: 'user',
      content: 'clean row',
      timestamp: 1,
    });
    const eventStore = new CogSecEventStore(join(root, 'cogsec-events.json'), {
      now: () => new Date('2026-07-01T00:00:00.000Z'),
    });
    eventStore.createEvent({
      caseId,
      type: 'content_poisoning',
      severity: 'medium',
      sourceChannelId: channelId,
      affectedLogicalSessionIds: [channelId],
      safeAgentSummary: SAFE_SUMMARY,
    });
    const preview: CogSecLineagePreview = {
      caseId,
      sourceChannelId: channelId,
      affectedLogicalSessionIds: [channelId],
      l0Messages: [],
      transcriptProjectionRows: [],
      memories: [{
        id: 'memory-needs-regeneration',
        classification: 'tainted',
        reason: 'provenance_matches_affected_session',
        provenanceRefs: [],
        hasEmbedding: true,
        actions: ['revoke', 'regenerate'],
      }],
      embeddingMemoryRows: [],
      compactionSummaries: [],
      externalArtifacts: [],
      gaps: [],
    };

    const result = await applyCogSecRegeneration({
      preview,
      eventStore,
      sessionStore,
      memoryRegenerator: {
        regenerateMemories: vi.fn(async () => {
          throw new Error('raw dirty text must not be copied');
        }),
      },
    });

    expect(result.failures).toEqual([{
      artifactClass: 'memories',
      artifactId: channelId,
      operation: 'regenerate',
      reason: 'memory_regeneration_failed',
    }]);
    const event = eventStore.getEvent(caseId);
    expect(event?.status).toBe('failed');
    expect(event?.failureDetails).toContain('memory_regeneration_failed');
    expect(event?.failureDetails).not.toContain('raw dirty text');
    expect(JSON.stringify(event)).not.toContain('raw dirty text');
  });
});
