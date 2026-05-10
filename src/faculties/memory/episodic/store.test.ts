import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { EpisodicStore, type EpisodeCreateInput } from './store.js';

describe('EpisodicStore', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function makeStore(): EpisodicStore {
    db = new Database(':memory:');
    return new EpisodicStore(db, {
      now: () => new Date('2026-04-01T00:00:00.000Z'),
      idFactory: () => 'generated-id',
    });
  }

  function baseEpisode(overrides: Partial<EpisodeCreateInput> = {}): EpisodeCreateInput {
    return {
      title: 'First explicit preference exchange',
      landmark: 'A concise landmark of what made the exchange worth remembering.',
      startedAt: '2026-03-30T10:00:00.000Z',
      endedAt: '2026-03-30T10:05:00.000Z',
      threadId: 'thread-alpha',
      channelId: 'discord:general',
      participantContactIds: ['contact:vega'],
      salience: { score: 0.72, novelty: 0.4, emotionalIntensity: 0.35 },
      affect: { valence: 0.2, arousal: 0.3, dominance: 0.5, labels: ['focused'] },
      themes: ['collaboration', 'preference-learning'],
      spanRefs: [{
        spanId: 'span-1',
        threadId: 'thread-alpha',
        channelId: 'discord:general',
        startedAt: '2026-03-30T10:00:00.000Z',
        endedAt: '2026-03-30T10:05:00.000Z',
      }],
      artifactRefs: [],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-1' }],
      ...overrides,
    };
  }

  it('creates and reloads stable L0.1 episode contracts', () => {
    const store = makeStore();
    const episode = store.createEpisode(baseEpisode({ id: 'episode-1' }));

    expect(episode.schemaVersion).toBe(1);
    expect(episode.id).toBe('episode-1');
    expect(episode.spanRefs[0].spanId).toBe('span-1');
    expect(episode.artifactRefs).toEqual([]);

    const reloaded = store.getEpisode('episode-1');
    expect(reloaded).toEqual(episode);
  });

  it('allows multiple episodes on one day and searches by overlapping time window', () => {
    const store = makeStore();
    store.createEpisode(baseEpisode({
      id: 'episode-morning',
      startedAt: '2026-03-30T09:00:00.000Z',
      endedAt: '2026-03-30T09:20:00.000Z',
      spanRefs: [{ spanId: 'span-morning' }],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-morning' }],
    }));
    store.createEpisode(baseEpisode({
      id: 'episode-evening',
      startedAt: '2026-03-30T21:00:00.000Z',
      endedAt: '2026-03-30T21:15:00.000Z',
      spanRefs: [{ spanId: 'span-evening' }],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-evening' }],
    }));

    const results = store.searchByTime({
      from: '2026-03-30T00:00:00.000Z',
      to: '2026-03-30T23:59:59.999Z',
    });

    expect(results.map(episode => episode.id)).toEqual(['episode-morning', 'episode-evening']);
  });

  it('searches by thread without mixing unrelated same-day episodes', () => {
    const store = makeStore();
    store.createEpisode(baseEpisode({ id: 'thread-alpha-1', threadId: 'thread-alpha' }));
    store.createEpisode(baseEpisode({
      id: 'thread-beta-1',
      threadId: 'thread-beta',
      spanRefs: [{ spanId: 'span-beta', threadId: 'thread-beta' }],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-beta' }],
    }));

    const results = store.searchByThread('thread-beta');

    expect(results.map(episode => episode.id)).toEqual(['thread-beta-1']);
  });

  it('stores long arcs as graph edges between episodes', () => {
    const store = makeStore();
    store.createEpisode(baseEpisode({ id: 'episode-1' }));
    store.createEpisode(baseEpisode({
      id: 'episode-2',
      startedAt: '2026-04-02T10:00:00.000Z',
      endedAt: '2026-04-02T10:10:00.000Z',
      spanRefs: [{ spanId: 'span-2' }],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-2' }],
    }));

    const arc = store.writeEpisodeArc({
      id: 'arc-1',
      sourceEpisodeId: 'episode-1',
      targetEpisodeId: 'episode-2',
      arcKind: 'continuation',
      salience: 0.8,
      confidence: 0.7,
      themes: ['collaboration'],
      spanRefs: [{ spanId: 'span-2' }],
      artifactRefs: [],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-2' }],
    });

    expect(store.getEpisodeArc('arc-1')).toEqual(arc);
    expect(store.listEpisodeArcsForEpisode('episode-1', { direction: 'outgoing' })).toEqual([arc]);
    expect(store.listEpisodeArcsForEpisode('episode-2', { direction: 'incoming' })).toEqual([arc]);
  });

  it('keeps same-day shared moments distinct while linking month-spanning life arcs', () => {
    const store = makeStore();
    const createSharedMoment = (
      id: string,
      title: string,
      startedAt: string,
      endedAt: string,
      threadId: string,
      themes: string[],
    ) => store.createEpisode(baseEpisode({
      id,
      title,
      landmark: `${title} remained a bounded shared moment with its own raw L0 span.`,
      startedAt,
      endedAt,
      threadId,
      channelId: 'discord:dm',
      participantContactIds: ['contact:vega', 'contact:partner'],
      themes,
      spanRefs: [{
        spanId: `span-${id}`,
        threadId,
        channelId: 'discord:dm',
        startedAt,
        endedAt,
      }],
      provenanceRefs: [{ kind: 'l0_span', refId: `span-${id}` }],
    }));

    createSharedMoment(
      'episode-pregnancy-12-week',
      'Pregnancy timeline 12-week scan',
      '2026-05-01T14:00:00.000Z',
      '2026-05-01T14:20:00.000Z',
      'thread-pregnancy-timeline',
      ['pregnancy', 'timeline', 'scan'],
    );
    createSharedMoment(
      'episode-birthday-brunch',
      'Birthday brunch plan',
      '2026-05-10T09:00:00.000Z',
      '2026-05-10T09:18:00.000Z',
      'thread-birthday',
      ['birthday', 'brunch'],
    );
    createSharedMoment(
      'episode-anniversary-dinner',
      'Anniversary dinner reservation',
      '2026-05-10T18:00:00.000Z',
      '2026-05-10T18:15:00.000Z',
      'thread-anniversary',
      ['anniversary', 'dinner'],
    );
    createSharedMoment(
      'episode-our-song',
      'Our song came on after dinner',
      '2026-05-10T22:00:00.000Z',
      '2026-05-10T22:06:00.000Z',
      'thread-anniversary',
      ['anniversary', 'our-song', 'music'],
    );
    createSharedMoment(
      'episode-pregnancy-16-week',
      'Pregnancy timeline 16-week continuity',
      '2026-05-29T16:00:00.000Z',
      '2026-05-29T16:22:00.000Z',
      'thread-pregnancy-timeline',
      ['pregnancy', 'timeline', 'appointment'],
    );

    const pregnancyArc = store.writeEpisodeArc({
      id: 'arc-pregnancy-month',
      sourceEpisodeId: 'episode-pregnancy-12-week',
      targetEpisodeId: 'episode-pregnancy-16-week',
      arcKind: 'continuation',
      salience: 0.86,
      confidence: 0.82,
      themes: ['pregnancy', 'timeline'],
      spanRefs: [{ spanId: 'span-episode-pregnancy-16-week' }],
      artifactRefs: [],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-episode-pregnancy-16-week' }],
    });
    const songArc = store.writeEpisodeArc({
      id: 'arc-anniversary-song',
      sourceEpisodeId: 'episode-anniversary-dinner',
      targetEpisodeId: 'episode-our-song',
      arcKind: 'recurrence',
      salience: 0.78,
      confidence: 0.74,
      themes: ['anniversary', 'our-song'],
      spanRefs: [{ spanId: 'span-episode-our-song' }],
      artifactRefs: [],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-episode-our-song' }],
    });

    const sameDay = store.searchByTime({
      from: '2026-05-10T00:00:00.000Z',
      to: '2026-05-10T23:59:59.999Z',
    });
    expect(sameDay.map(episode => episode.id)).toEqual([
      'episode-birthday-brunch',
      'episode-anniversary-dinner',
      'episode-our-song',
    ]);
    expect(new Set(sameDay.map(episode => episode.threadId))).toEqual(new Set([
      'thread-birthday',
      'thread-anniversary',
    ]));

    expect(store.searchByThread('thread-pregnancy-timeline').map(episode => episode.id)).toEqual([
      'episode-pregnancy-12-week',
      'episode-pregnancy-16-week',
    ]);
    expect(store.listEpisodeArcsForEpisode('episode-pregnancy-12-week', { direction: 'outgoing' }))
      .toEqual([pregnancyArc]);
    expect(store.listEpisodeArcsForEpisode('episode-anniversary-dinner', { direction: 'outgoing' }))
      .toEqual([songArc]);

    const allEpisodes = store.listEpisodes({ limit: 10 });
    expect(allEpisodes).toHaveLength(5);
    expect(allEpisodes.every(episode => episode.spanRefs.length === 1)).toBe(true);
    expect(allEpisodes.some(episode => (
      Date.parse(episode.endedAt) - Date.parse(episode.startedAt) > 24 * 60 * 60 * 1000
    ))).toBe(false);
  });

  it('rejects episodes that lose L0 span and artifact provenance', () => {
    const store = makeStore();

    expect(() => store.createEpisode(baseEpisode({
      spanRefs: [],
      artifactRefs: [],
      provenanceRefs: [],
    }))).toThrow('episode must preserve at least one L0 span or artifact reference');
  });

  it('fails closed on malformed persisted episode JSON', () => {
    const store = makeStore();
    store.createEpisode(baseEpisode({ id: 'episode-1' }));
    db?.prepare(`
      INSERT INTO l01_episodes (
        id,
        thread_id,
        channel_id,
        started_at,
        ended_at,
        salience_score,
        episode_json,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'bad-episode',
      null,
      null,
      '2026-04-03T00:00:00.000Z',
      '2026-04-03T00:00:00.000Z',
      0.5,
      JSON.stringify({ schemaVersion: 999, id: 'bad-episode' }),
      '2026-04-03T00:00:00.000Z',
      '2026-04-03T00:00:00.000Z',
    );

    expect(() => store.getEpisode('bad-episode')).toThrow('malformed persisted episode "bad-episode"');
  });

  it('rejects graph edges that point at unknown episodes', () => {
    const store = makeStore();
    store.createEpisode(baseEpisode({ id: 'episode-1' }));

    expect(() => store.writeEpisodeArc({
      sourceEpisodeId: 'episode-1',
      targetEpisodeId: 'missing-episode',
      arcKind: 'causal',
      salience: 0.4,
      confidence: 0.9,
      themes: [],
      spanRefs: [{ spanId: 'span-1' }],
      artifactRefs: [],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-1' }],
    })).toThrow('episodeArc.targetEpisodeId references unknown episode "missing-episode"');
  });
});
