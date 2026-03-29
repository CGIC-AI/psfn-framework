import { describe, expect, it } from 'vitest';
import {
  buildExtractionEntryChunks,
  formatExtractionTranscript,
  isExtractionTranscriptEntry,
} from './chunk-compose.js';

describe('chunk-compose extraction transcript filtering', () => {
  it('treats only user and assistant entries as extraction transcript content', () => {
    const entries = [
      { id: 1, channelId: 'api:test', role: 'system', content: 'hidden system', timestamp: 1 },
      { id: 2, channelId: 'api:test', role: 'tool', content: 'tool payload', timestamp: 2, authorName: 'memory_write' },
      { id: 3, channelId: 'api:test', role: 'user', content: 'User said a real thing', timestamp: 3, authorName: 'V' },
      { id: 4, channelId: 'api:test', role: 'assistant', content: 'Assistant replied', timestamp: 4, authorName: 'Purr' },
    ] as const;

    expect(entries.filter(isExtractionTranscriptEntry).map(entry => entry.id)).toEqual([3, 4]);
    expect(formatExtractionTranscript(entries)).toBe(['V: User said a real thing', 'Purr: Assistant replied'].join('\n'));
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
});
