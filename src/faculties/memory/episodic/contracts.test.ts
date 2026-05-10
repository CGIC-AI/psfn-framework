import { describe, expect, it } from 'vitest';
import {
  parseEpisode,
  serializeEpisode,
  type Episode,
} from '../../../shared/contracts/episodic-memory.js';

describe('episodic memory contracts', () => {
  function contractEpisode(overrides: Partial<Episode> = {}): Episode {
    return {
      schemaVersion: 1,
      id: 'episode-1',
      title: 'Landmark title',
      landmark: 'A concise landmark suitable for Garden and retrieval consumers.',
      startedAt: '2026-03-30T10:00:00.000Z',
      endedAt: '2026-03-30T10:05:00.000Z',
      threadId: 'thread-alpha',
      channelId: 'discord:general',
      participantContactIds: ['contact:vega'],
      salience: { score: 0.7, novelty: 0.4 },
      affect: { valence: 0.1, arousal: 0.3, labels: ['steady'] },
      themes: ['collaboration'],
      spanRefs: [{ spanId: 'span-1' }],
      artifactRefs: [],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-1' }],
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('round-trips a stable serialized episode contract', () => {
    const episode = contractEpisode();

    expect(JSON.parse(serializeEpisode(episode))).toEqual(episode);
    expect(parseEpisode(JSON.parse(serializeEpisode(episode)) as unknown)).toEqual(episode);
  });

  it('rejects unknown fields instead of accepting drifting contract shapes', () => {
    const episode = {
      ...contractEpisode(),
      vectorCacheKey: 'not-l0.1',
    };

    expect(() => parseEpisode(episode)).toThrow('episode contains unknown field "vectorCacheKey"');
  });
});
