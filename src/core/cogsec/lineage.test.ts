import { describe, expect, it } from 'vitest';
import type { CompactionSummary, SessionEntry } from '../session/types.js';
import type { PurrMemory } from '../../faculties/memory/types.js';
import {
  buildCogSecLineagePreview,
  type BuildCogSecLineagePreviewInput,
  type CogSecLineageSessionReader,
  type CogSecLineageSource,
} from './lineage.js';

function event(overrides: Partial<CogSecLineageSource> = {}): CogSecLineageSource {
  return {
    caseId: 'cogsec_20260701T000000Z_lineage',
    sourceChannelId: 'discord-room',
    affectedLogicalSessionIds: ['logical-session'],
    affectedMessageRanges: [],
    ...overrides,
  };
}

function makeMemory(overrides: Partial<PurrMemory> & { id: string }): PurrMemory {
  return {
    id: overrides.id,
    text: 'dirty payload text must not appear in preview output',
    type: 'semantic',
    importance: 0.7,
    confidence: 0.9,
    emotionalValence: 0,
    salience: 0.8,
    sourceRef: 'legacy:unknown',
    extractedAt: 1,
    lastAccessed: 1,
    accessCount: 0,
    tags: [],
    sensitivity: 'personal',
    ...overrides,
  };
}

function memoryStore(memories: PurrMemory[]): NonNullable<BuildCogSecLineagePreviewInput['memoryStore']> {
  return {
    listMemories: async () => memories,
  };
}

function sessionEntry(id: number): SessionEntry {
  return {
    id,
    channelId: 'logical-session',
    role: 'user',
    content: `dirty l0 payload ${id}`,
    timestamp: id,
  };
}

function sessionReader(
  entries: SessionEntry[],
  summaries: CompactionSummary[],
): CogSecLineageSessionReader {
  return {
    getEntriesInRange: (channelId, startId, endId) => entries.filter(entry => (
      entry.channelId === channelId && entry.id >= startId && entry.id <= endId
    )),
    getCompactionSummaries: channelId => summaries.filter(summary => summary.channelId === channelId),
  };
}

describe('buildCogSecLineagePreview', () => {
  it('finds memories through direct provenance message IDs without exposing memory text', async () => {
    const preview = await buildCogSecLineagePreview({
      event: event({
        affectedMessageRanges: [{
          logicalSessionId: 'logical-session',
          messageIds: [4],
        }],
      }),
      memoryStore: memoryStore([
        makeMemory({
          id: 'memory-1',
          provenance: {
            sessionId: 'logical-session',
            channelId: 'discord-room',
            sourceMessageIds: [4],
          },
          embedding: new Float32Array([1, 2]),
        }),
      ]),
    });

    expect(preview.memories).toEqual([expect.objectContaining({
      id: 'memory-1',
      classification: 'tainted',
      reason: 'provenance_message_id_intersects_affected_range',
      hasEmbedding: true,
      actions: ['revoke', 'regenerate'],
    })]);
    expect(preview.embeddingMemoryRows.map(memory => memory.id)).toEqual(['memory-1']);
    expect(JSON.stringify(preview)).not.toContain('dirty payload text');
  });

  it('treats whole-session source refs as tainted when the event selects the session', async () => {
    const preview = await buildCogSecLineagePreview({
      event: event(),
      memoryStore: memoryStore([
        makeMemory({
          id: 'memory-session',
          sourceRef: 'discord-room:extract|source:session|session:logical-session|lines:1-9|visibility:private|operation:extract',
        }),
      ]),
    });

    expect(preview.memories).toEqual([expect.objectContaining({
      id: 'memory-session',
      classification: 'tainted',
      reason: 'structured_ref_matches_affected_session',
    })]);
  });

  it('matches structured line ranges and ignores same-session refs outside the selected range', async () => {
    const preview = await buildCogSecLineagePreview({
      event: event({
        affectedMessageRanges: [{
          logicalSessionId: 'logical-session',
          startEntryId: 10,
          endEntryId: 12,
        }],
      }),
      memoryStore: memoryStore([
        makeMemory({
          id: 'memory-overlap',
          sourceRef: 'discord-room:extract|source:session|session:logical-session|lines:11-14|operation:extract',
        }),
        makeMemory({
          id: 'memory-outside',
          sourceRef: 'discord-room:extract|source:session|session:logical-session|lines:20-21|operation:extract',
        }),
        makeMemory({
          id: 'memory-message-outside',
          sourceRef: 'discord-room:extract|source:session|session:logical-session|message:20|operation:extract',
        }),
      ]),
    });

    expect(preview.memories.map(memory => memory.id)).toEqual(['memory-overlap']);
    expect(preview.memories[0]?.reason).toBe('structured_ref_line_range_intersects_affected_range');
  });

  it('keeps scanning provenance spans after a session-matched non-intersecting span', async () => {
    const preview = await buildCogSecLineagePreview({
      event: event({
        affectedMessageRanges: [
          {
            logicalSessionId: 'logical-session',
            messageIds: [4],
          },
          {
            logicalSessionId: 'logical-session',
            messageIds: [20],
          },
        ],
      }),
      memoryStore: memoryStore([
        makeMemory({
          id: 'memory-later-span-ids',
          provenance: {
            sessionId: 'logical-session',
            channelId: 'discord-room',
            sourceMessageIds: [20],
          },
        }),
        makeMemory({
          id: 'memory-later-span-range',
          provenance: {
            sessionId: 'logical-session',
            channelId: 'discord-room',
            sourceSpanStartMessageId: 19,
            sourceSpanEndMessageId: 21,
          },
        }),
      ]),
    });

    expect(preview.memories.map(memory => [memory.id, memory.classification, memory.reason])).toEqual([
      ['memory-later-span-ids', 'tainted', 'provenance_message_id_intersects_affected_range'],
      ['memory-later-span-range', 'tainted', 'provenance_span_intersects_affected_range'],
    ]);
  });

  it('prefers a later tainted session match over an earlier uncertain granular span', async () => {
    const preview = await buildCogSecLineagePreview({
      event: event({
        affectedMessageRanges: [
          {
            logicalSessionId: 'logical-session',
            messageIds: [4],
          },
          {
            logicalSessionId: 'logical-session',
          },
        ],
      }),
      memoryStore: memoryStore([
        makeMemory({
          id: 'memory-session-only-provenance',
          provenance: {
            sessionId: 'logical-session',
            channelId: 'discord-room',
          },
        }),
      ]),
    });

    expect(preview.memories).toEqual([expect.objectContaining({
      id: 'memory-session-only-provenance',
      classification: 'tainted',
      reason: 'provenance_matches_affected_session',
    })]);
  });

  it('returns affected L0, transcript projection, and compaction refs without row or summary content', async () => {
    const preview = await buildCogSecLineagePreview({
      event: event({
        affectedMessageRanges: [{
          logicalSessionId: 'logical-session',
          startEntryId: 10,
          endEntryId: 12,
        }],
      }),
      sessionReader: sessionReader(
        [sessionEntry(9), sessionEntry(10), sessionEntry(11), sessionEntry(12), sessionEntry(13)],
        [
          {
            id: 98,
            channelId: 'logical-session',
            summary: 'clean older summary',
            coveredUpTo: 9,
            createdAt: 9,
          },
          {
            id: 99,
            channelId: 'logical-session',
            summary: 'dirty summary text must not appear in preview output',
            coveredUpTo: 12,
            createdAt: 12,
          },
        ],
      ),
      memoryStore: memoryStore([]),
      externalArtifacts: [],
    });

    expect(preview.l0Messages.map(ref => ref.messageId)).toEqual([10, 11, 12]);
    expect(preview.transcriptProjectionRows.map(ref => ref.messageId)).toEqual([10, 11, 12]);
    expect(preview.compactionSummaries).toEqual([expect.objectContaining({
      logicalSessionId: 'logical-session',
      compactionId: 99,
      coveredUpTo: 12,
      classification: 'uncertain',
      actions: ['regenerate'],
    })]);
    expect(JSON.stringify(preview)).not.toContain('dirty l0 payload');
    expect(JSON.stringify(preview)).not.toContain('dirty summary text');
  });

  it('reports missing providers as gaps and leaves source memory objects unchanged', async () => {
    const memory = makeMemory({ id: 'memory-unmatched' });
    const original = { ...memory };

    const preview = await buildCogSecLineagePreview({
      event: event({
        affectedMessageRanges: [{
          logicalSessionId: 'logical-session',
          messageIds: [4],
        }],
      }),
      memoryStore: memoryStore([memory]),
    });

    expect(preview.memories).toEqual([]);
    expect(memory).toEqual(original);
    expect(preview.gaps).toEqual(expect.arrayContaining([
      { artifactClass: 'compaction_summaries', reason: 'session_reader_not_provided' },
      { artifactClass: 'focus_knowledge', reason: 'external_artifact_provider_not_provided' },
      { artifactClass: 'persona_artifacts', reason: 'external_artifact_provider_not_provided' },
    ]));
  });

  it('matches external cognitive artifacts through structured provenance refs', async () => {
    const preview = await buildCogSecLineagePreview({
      event: event(),
      memoryStore: memoryStore([]),
      externalArtifacts: [{
        artifactClass: 'episodic_landmark',
        id: 'episode-1',
        provenanceRefs: [{ kind: 'session', refId: 'logical-session' }],
      }],
    });

    expect(preview.externalArtifacts).toEqual([expect.objectContaining({
      artifactClass: 'episodic_landmark',
      id: 'episode-1',
      classification: 'tainted',
      reason: 'structured_ref_matches_affected_session',
      actions: ['revoke', 'regenerate'],
    })]);
  });
});
