import { describe, expect, it } from 'vitest';
import {
  EPISODIC_CONTRACT_VERSION,
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

  it('accepts a legacy v1 episode and preserves its version on read (no silent upgrade)', () => {
    const legacy = contractEpisode({ schemaVersion: 1 });
    const parsed = parseEpisode(JSON.parse(serializeEpisode(legacy)) as unknown);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.machineSignals).toBeUndefined();
  });

  it('carries a machine-signals sidecar at v2 without touching felt affect', () => {
    const episode = contractEpisode({
      schemaVersion: EPISODIC_CONTRACT_VERSION,
      affect: { labels: [] },
      machineSignals: {
        source: 'deterministic_synthesis',
        topicTags: ['focused', 'positive'],
        vad: { valence: 0.25, arousal: 0.3, dominance: 0.5 },
      },
    });
    const parsed = parseEpisode(JSON.parse(serializeEpisode(episode)) as unknown);
    expect(parsed).toEqual(episode);
    expect(parsed.affect).toEqual({ labels: [] });
    expect(parsed.machineSignals?.source).toBe('deterministic_synthesis');
  });

  it('version-gates the machine-signals sidecar: a v1 record carrying it is rejected', () => {
    const drifted = {
      ...contractEpisode({ schemaVersion: 1 }),
      machineSignals: { source: 'deterministic_synthesis', topicTags: [] },
    };
    expect(() => parseEpisode(drifted)).toThrow('episode.machineSignals requires schemaVersion 2 or later');
  });

  it('rejects unknown machine-signals fields instead of drifting', () => {
    const drifted = contractEpisode({
      schemaVersion: EPISODIC_CONTRACT_VERSION,
      affect: { labels: [] },
      machineSignals: {
        source: 'deterministic_synthesis',
        topicTags: [],
        // @ts-expect-error intentionally invalid extra field
        emotion: 'joy',
      },
    });
    expect(() => parseEpisode(drifted)).toThrow('episode.machineSignals contains unknown field "emotion"');
  });
});
