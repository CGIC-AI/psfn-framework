import { describe, expect, it, vi } from 'vitest';
import { runSessionSearch } from './search-runtime.js';
import type { TranscriptSearchPort } from '../../persistence/sessions/transcript-search-port.js';

describe('runSessionSearch', () => {
  it('queries the transcript search port and applies visibility and channel scoping', async () => {
    const transcriptSearch: TranscriptSearchPort = {
      searchByKeywords: vi.fn(() => [
        {
          channelId: 'api:public-session',
          messageId: 1,
          role: 'assistant',
          timestamp: 1_000,
          channelVisibility: 'public',
          score: 0.1,
          snippet: 'Project Orion launch is public.',
          content: 'Project Orion launch is public.',
        },
        {
          channelId: 'api:private-session',
          messageId: 2,
          role: 'assistant',
          timestamp: 2_000,
          channelVisibility: 'private',
          score: 0.2,
          snippet: 'Project Orion private rollout notes.',
          content: 'Project Orion private rollout notes.',
        },
      ]),
    };

    const result = await runSessionSearch({
      transcriptSearch,
      query: 'Project Orion',
      limit: 5,
      summarize: false,
      targetChannelId: 'api:public-session',
      viewer: {
        channelId: 'api:public-search',
        trustLevel: 'regular',
        channelVisibility: 'public',
      },
    });

    expect(transcriptSearch.searchByKeywords).toHaveBeenCalledWith('Project Orion', 20);
    expect(result.totalHits).toBe(1);
    expect(result.gatedOutCount).toBe(0);
    expect(result.hits).toEqual([
      expect.objectContaining({
        channelId: 'api:public-session',
        messageId: 1,
        channelVisibility: 'public',
      }),
    ]);
    expect(result.summary).toContain('Found 1 transcript matches');
  });

  it('returns an empty search result when the transcript search port is missing', async () => {
    const result = await runSessionSearch({
      transcriptSearch: null,
      query: 'Project Orion',
      summarize: false,
    });

    expect(result.totalHits).toBe(0);
    expect(result.gatedOutCount).toBe(0);
    expect(result.hits).toEqual([]);
    expect(result.summary).toContain('No transcript matches found');
  });
});
