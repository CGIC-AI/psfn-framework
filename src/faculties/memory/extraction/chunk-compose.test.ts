import { describe, expect, it } from 'vitest';
import {
  buildExtractionEntryChunks,
  formatExtractionTranscript,
  isExtractionTranscriptEntry,
} from './chunk-compose.js';
import { buildSessionMetadataWithRuntimeFallbackProvenance } from '../../../core/session/runtime-fallback-provenance.js';

describe('chunk-compose extraction transcript filtering', () => {
  it('treats only user and assistant entries as extraction transcript content', () => {
    const entries = [
      { id: 1, channelId: 'api:test', role: 'system', content: 'hidden system', timestamp: 1 },
      { id: 2, channelId: 'api:test', role: 'tool', content: 'tool payload', timestamp: 2, authorName: 'memory_write' },
      { id: 3, channelId: 'api:test', role: 'user', content: 'User said a real thing', timestamp: 3, authorName: 'V' },
      { id: 4, channelId: 'api:test', role: 'assistant', content: 'Assistant replied', timestamp: 4, authorName: 'Purr' },
    ] as const;

    expect(entries.filter(isExtractionTranscriptEntry).map(entry => entry.id)).toEqual([3, 4]);
    expect(formatExtractionTranscript(entries)).toBe([
      '[message_id:3] V: User said a real thing',
      '[message_id:4] Purr: Assistant replied',
    ].join('\n'));
  });

  it('chunks only extraction-eligible entries after filtering', () => {
    const entries = [
      { id: 1, channelId: 'api:test', role: 'user', content: 'one', timestamp: 1 },
      { id: 2, channelId: 'api:test', role: 'tool', content: 'ignore', timestamp: 2 },
      { id: 3, channelId: 'api:test', role: 'assistant', content: 'two', timestamp: 3 },
      { id: 4, channelId: 'api:test', role: 'system', content: 'ignore', timestamp: 4 },
      { id: 5, channelId: 'api:test', role: 'user', content: 'three', timestamp: 5 },
    ] as const;

    const filtered = entries.filter(isExtractionTranscriptEntry);
    expect(buildExtractionEntryChunks(filtered, 2).map(chunk => chunk.map(entry => entry.id))).toEqual([
      [1, 3],
      [5],
    ]);
  });

  it('excludes runtime-authored fallback entries from extraction transcripts (psfn-framework-zagpk)', () => {
    // The exact persisted shape: role assistant + the metadata the runtime
    // fallback path writes through buildSessionMetadataWithRuntimeFallbackProvenance.
    const fallbackMetadata = buildSessionMetadataWithRuntimeFallbackProvenance(undefined, {
      schemaVersion: 1,
      authoredBy: 'runtime',
      model: 'runtime-fallback',
      strategy: 'runtime_nonfabricating_notice',
    });
    const entries = [
      { id: 1, channelId: 'api:test', role: 'user', content: 'here is a picture', timestamp: 1, authorName: 'V' },
      {
        id: 2,
        channelId: 'api:test',
        role: 'assistant',
        content: 'I got the image attachment, but my image reader failed before I could inspect it.',
        timestamp: 2,
        authorName: 'Purr',
        metadata: fallbackMetadata,
      },
      { id: 3, channelId: 'api:test', role: 'assistant', content: 'Her genuine reply', timestamp: 3, authorName: 'Purr' },
    ] as const;

    expect(entries.filter(isExtractionTranscriptEntry).map(entry => entry.id)).toEqual([1, 3]);
    expect(formatExtractionTranscript(entries)).toBe([
      '[message_id:1] V: here is a picture',
      '[message_id:3] Purr: Her genuine reply',
    ].join('\n'));
  });

  it('fails closed on a malformed provenance marker: still excluded from extraction', () => {
    const entry = {
      id: 7,
      channelId: 'api:test',
      role: 'assistant',
      content: 'notice text',
      timestamp: 7,
      metadata: JSON.stringify({ runtimeFallbackProvenance: { schemaVersion: 999 } }),
    } as const;

    expect(isExtractionTranscriptEntry(entry)).toBe(false);
  });
});
