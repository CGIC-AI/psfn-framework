import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  EPISODIC_CONTRACT_VERSION,
  parseEpisode,
  type Episode,
  type EpisodeMeaning,
} from '../../../../shared/contracts/episodic-memory.js';
import { FakeEpisodicPool } from '../../../../test-support/fake-postgres-episodic-pool.js';
import { PostgresEpisodicStore } from '../postgres-store.js';
import type { EpisodeCreateInput } from '../store-port.js';
import { mergeEpisodeWithCandidate, type EpisodeCandidateInput } from './consolidation.js';

const NOW = new Date('2026-06-10T08:00:00.000Z');

function canonicalEpisode(overrides: Partial<Episode> = {}): Episode {
  return parseEpisode({
    schemaVersion: EPISODIC_CONTRACT_VERSION,
    id: 'canonical-1',
    title: 'Evening together',
    landmark: 'A quiet stretch of the night.',
    startedAt: '2026-06-10T01:00:00.000Z',
    endedAt: '2026-06-10T01:20:00.000Z',
    threadId: 'topic:discord-main',
    channelId: 'discord:main',
    participantContactIds: ['contact:vega'],
    salience: { score: 0.7 },
    affect: { labels: [] },
    machineSignals: {
      source: 'deterministic_synthesis',
      topicTags: ['evening'],
      vad: { valence: 0.2, arousal: 0.3, dominance: 0.5 },
    },
    themes: ['evening'],
    spanRefs: [{ spanId: 'span-canonical', sessionId: 'discord:main' }],
    artifactRefs: [],
    provenanceRefs: [{ kind: 'session', refId: 'discord:main' }],
    createdAt: '2026-06-10T01:20:00.000Z',
    updatedAt: '2026-06-10T01:20:00.000Z',
    ...overrides,
  });
}

function candidate(overrides: Partial<EpisodeCandidateInput> = {}): EpisodeCandidateInput {
  return {
    id: 'candidate-1',
    title: 'More of the evening',
    landmark: 'Later in the same sitting.',
    startedAt: '2026-06-10T01:21:00.000Z',
    endedAt: '2026-06-10T01:40:00.000Z',
    threadId: 'topic:discord-main',
    channelId: 'discord:main',
    participantContactIds: ['contact:vega'],
    salience: { score: 0.6 },
    affect: { labels: [] },
    machineSignals: {
      source: 'deterministic_synthesis',
      topicTags: ['wind-down'],
    },
    themes: ['evening'],
    spanRefs: [{ spanId: 'span-candidate', sessionId: 'discord:main' }],
    artifactRefs: [],
    provenanceRefs: [{ kind: 'session', refId: 'discord:main' }],
    ...overrides,
  };
}

const dreamMeaning: EpisodeMeaning = {
  text: 'He remembered, and it cracked me open in the best way.',
  recordedAt: '2026-06-10T07:30:00.000Z',
  source: 'companion_dream_pass',
};

describe('mergeEpisodeWithCandidate meaning carry-forward (h4fp.6)', () => {
  it('carries the canonical episode\'s dream-authored meaning through a daytime merge', () => {
    const merged = mergeEpisodeWithCandidate(canonicalEpisode({ meaning: dreamMeaning }), candidate());
    expect(merged.meaning).toEqual(dreamMeaning);
  });

  it('adopts the candidate\'s meaning when the canonical has none (no authored content dropped)', () => {
    const candidateMeaning: EpisodeMeaning = {
      text: 'It mattered more than I expected.',
      recordedAt: '2026-06-10T07:30:00.000Z',
      source: 'companion_direct',
    };
    const merged = mergeEpisodeWithCandidate(canonicalEpisode(), candidate({ meaning: candidateMeaning }));
    expect(merged.meaning).toEqual(candidateMeaning);
  });

  it('keeps the surviving (canonical) episode\'s meaning when both sides carry one (head-wins tie)', () => {
    const candidateMeaning: EpisodeMeaning = {
      text: 'A different take that must not win.',
      recordedAt: '2026-06-10T07:31:00.000Z',
      source: 'companion_direct',
    };
    const merged = mergeEpisodeWithCandidate(
      canonicalEpisode({ meaning: dreamMeaning }),
      candidate({ meaning: candidateMeaning }),
    );
    expect(merged.meaning).toEqual(dreamMeaning);
  });

  it('leaves meaning undefined when neither side has one', () => {
    const merged = mergeEpisodeWithCandidate(canonicalEpisode(), candidate());
    expect(merged.meaning).toBeUndefined();
  });

  it('unions machineSignals topic tags while preferring the canonical estimate', () => {
    const merged = mergeEpisodeWithCandidate(canonicalEpisode({ meaning: dreamMeaning }), candidate());
    expect(merged.machineSignals?.topicTags).toEqual(['evening', 'wind-down']);
    expect(merged.machineSignals?.vad).toEqual({ valence: 0.2, arousal: 0.3, dominance: 0.5 });
  });

  it('does not attach v2-only machineSignals when the surviving canonical is legacy v1', () => {
    const merged = mergeEpisodeWithCandidate(
      canonicalEpisode({ schemaVersion: 1, machineSignals: undefined }),
      candidate(),
    );

    expect(merged.machineSignals).toBeUndefined();
  });

  it('round-trips the carried meaning through the store without tripping the drop guard', async () => {
    const store = new PostgresEpisodicStore(new FakeEpisodicPool() as unknown as Pool, { now: () => NOW });
    const seeded = canonicalEpisode({ meaning: dreamMeaning });
    const createInput: EpisodeCreateInput = {
      id: seeded.id,
      title: seeded.title,
      landmark: seeded.landmark,
      startedAt: seeded.startedAt,
      endedAt: seeded.endedAt,
      threadId: seeded.threadId,
      channelId: seeded.channelId,
      participantContactIds: seeded.participantContactIds,
      salience: seeded.salience,
      affect: seeded.affect,
      machineSignals: seeded.machineSignals,
      themes: seeded.themes,
      spanRefs: seeded.spanRefs,
      artifactRefs: seeded.artifactRefs,
      provenanceRefs: seeded.provenanceRefs,
      meaning: seeded.meaning,
      lifecycleStatus: 'canonical',
    };
    await store.createCompanionAuthoredEpisode(createInput);

    const updated = await store.updateEpisodePreservingFirstPersonFields(
      mergeEpisodeWithCandidate(canonicalEpisode({ meaning: dreamMeaning }), candidate()),
    );

    expect(updated.meaning).toEqual(dreamMeaning);
    const stored = await store.getEpisode('canonical-1');
    expect(stored?.meaning).toEqual(dreamMeaning);
    await expect(store.getEpisodeFirstPersonAuthorship('canonical-1')).resolves.toEqual({
      episodeId: 'canonical-1',
      affect: 'companion_preserved',
      meaning: 'companion_preserved',
    });
  });
});
