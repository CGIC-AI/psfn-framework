import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { EpisodicStore } from './store.js';
import {
  type EpisodeCreateInput,
} from './store-port.js';

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

  it('batch-loads episodes and arcs while preserving arc filters, dedupe, and per-episode limits', () => {
    const store = makeStore();
    const first = store.createEpisode(baseEpisode({ id: 'episode-1' }));
    store.createEpisode(baseEpisode({
      id: 'episode-2',
      startedAt: '2026-04-02T10:00:00.000Z',
      endedAt: '2026-04-02T10:10:00.000Z',
      spanRefs: [{ spanId: 'span-2' }],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-2' }],
    }));
    const third = store.createEpisode(baseEpisode({
      id: 'episode-3',
      startedAt: '2026-04-03T10:00:00.000Z',
      endedAt: '2026-04-03T10:10:00.000Z',
      spanRefs: [{ spanId: 'span-3' }],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-3' }],
    }));

    const older = store.writeEpisodeArc({
      id: 'arc-older',
      sourceEpisodeId: 'episode-1',
      targetEpisodeId: 'episode-2',
      arcKind: 'continuation',
      salience: 0.7,
      confidence: 0.7,
      themes: ['collaboration'],
      spanRefs: [{ spanId: 'span-2' }],
      artifactRefs: [],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-2' }],
      updatedAt: '2026-04-02T00:00:00.000Z',
    });
    const newer = store.writeEpisodeArc({
      id: 'arc-newer',
      sourceEpisodeId: 'episode-3',
      targetEpisodeId: 'episode-1',
      arcKind: 'continuation',
      salience: 0.8,
      confidence: 0.8,
      themes: ['collaboration'],
      spanRefs: [{ spanId: 'span-3' }],
      artifactRefs: [],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-3' }],
      updatedAt: '2026-04-03T00:00:00.000Z',
    });
    store.writeEpisodeArc({
      id: 'arc-other-kind',
      sourceEpisodeId: 'episode-2',
      targetEpisodeId: 'episode-3',
      arcKind: 'causal',
      salience: 0.6,
      confidence: 0.6,
      themes: ['collaboration'],
      spanRefs: [{ spanId: 'span-3' }],
      artifactRefs: [],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-3' }],
      updatedAt: '2026-04-04T00:00:00.000Z',
    });

    expect(store.getEpisodesByIds(['episode-3', 'missing', 'episode-1', 'episode-3']))
      .toEqual([third, first]);
    expect(store.listEpisodeArcsForEpisodes(['episode-1', 'episode-2'], {
      direction: 'both',
      arcKind: 'continuation',
      limit: 1,
    })).toEqual([newer, older]);
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

  function activeClaimKeyDuplicates(): unknown[] {
    if (!db) throw new Error('store database is not open');
    return db.prepare(`
      SELECT claim_key
      FROM l01_episode_message_claims
      WHERE status = 'active'
      GROUP BY claim_key
      HAVING COUNT(*) > 1
    `).all();
  }

  it('claims source messages and enforces one live episode per message at the database level', () => {
    const store = makeStore();
    store.createEpisode(baseEpisode({ id: 'episode-1' }));
    store.createEpisode(baseEpisode({
      id: 'episode-2',
      startedAt: '2026-03-30T11:00:00.000Z',
      endedAt: '2026-03-30T11:05:00.000Z',
      spanRefs: [{ spanId: 'span-2' }],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-2' }],
    }));

    const claims = store.claimEpisodeMessages({
      episodeId: 'episode-1',
      sessionId: 'terminal:daily',
      claims: [
        { claimKey: 'l0-message:terminal:daily:1', turnId: 'turn-1', channelId: 'terminal:daily' },
        { claimKey: 'l0-message:terminal:daily:2', turnId: 'turn-2', channelId: 'terminal:daily' },
      ],
    });
    expect(claims).toHaveLength(2);
    expect(claims.every(claim => claim.status === 'active' && claim.episodeId === 'episode-1')).toBe(true);

    // Re-claiming the same messages for the same episode is idempotent.
    expect(store.claimEpisodeMessages({
      episodeId: 'episode-1',
      claims: [{ claimKey: 'l0-message:terminal:daily:1' }],
    })).toHaveLength(1);

    // A different episode can never claim an already-claimed message.
    expect(() => store.claimEpisodeMessages({
      episodeId: 'episode-2',
      claims: [{ claimKey: 'l0-message:terminal:daily:2' }],
    })).toThrow('source message "l0-message:terminal:daily:2" is already claimed by episode "episode-1"');

    // Even raw SQL that bypasses the store API hits the partial unique index.
    expect(() => db?.prepare(`
      INSERT INTO l01_episode_message_claims (
        episode_id, claim_key, turn_id, channel_id, session_id, status, claimed_at
      )
      VALUES ('episode-2', 'l0-message:terminal:daily:1', NULL, NULL, NULL, 'active', '2026-04-01T00:00:00.000Z')
    `).run()).toThrow(/UNIQUE constraint failed/);

    expect(activeClaimKeyDuplicates()).toEqual([]);
    expect(() => store.claimEpisodeMessages({ episodeId: 'episode-1', claims: [] }))
      .toThrow('claimEpisodeMessages requires at least one source message claim');
    expect(() => store.claimEpisodeMessages({
      episodeId: 'missing-episode',
      claims: [{ claimKey: 'l0-message:terminal:daily:9' }],
    })).toThrow('claim.episodeId references unknown episode "missing-episode"');
  });

  it('tracks candidate lifecycle: candidates stay live, filter by status, and confirm to canonical', () => {
    const store = makeStore();
    store.createEpisode(baseEpisode({ id: 'candidate-1', lifecycleStatus: 'candidate' }));
    store.createEpisode(baseEpisode({
      id: 'canonical-1',
      startedAt: '2026-03-30T12:00:00.000Z',
      endedAt: '2026-03-30T12:05:00.000Z',
      spanRefs: [{ spanId: 'span-2' }],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-2' }],
    }));

    // Candidates are live memory: visible in unfiltered lists and searches.
    expect(store.listEpisodes({ limit: 10 }).map(episode => episode.id))
      .toEqual(['candidate-1', 'canonical-1']);
    const window = { from: '2026-03-30T00:00:00.000Z', to: '2026-03-30T23:59:59.999Z' };
    expect(store.searchByTime(window).map(episode => episode.id))
      .toEqual(['candidate-1', 'canonical-1']);
    expect(store.searchByTime({ ...window, lifecycleStatus: 'candidate' }).map(episode => episode.id))
      .toEqual(['candidate-1']);
    expect(store.searchByTime({ ...window, lifecycleStatus: 'canonical' }).map(episode => episode.id))
      .toEqual(['canonical-1']);

    // Sleep-cycle confirmation promotes the candidate; idempotent re-confirm.
    store.confirmEpisodeCanonical('candidate-1');
    store.confirmEpisodeCanonical('candidate-1');
    expect(store.searchByTime({ ...window, lifecycleStatus: 'candidate' })).toEqual([]);
    expect(store.searchByTime({ ...window, lifecycleStatus: 'canonical' }).map(episode => episode.id))
      .toEqual(['candidate-1', 'canonical-1']);
  });

  it('fails closed on invalid lifecycle transitions', () => {
    const store = makeStore();
    store.createEpisode(baseEpisode({ id: 'candidate-1', lifecycleStatus: 'candidate' }));
    store.createEpisode(baseEpisode({
      id: 'consolidated',
      startedAt: '2026-03-30T12:00:00.000Z',
      endedAt: '2026-03-30T12:05:00.000Z',
      spanRefs: [{ spanId: 'span-2' }],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-2' }],
    }));

    expect(() => store.createEpisode(baseEpisode({
      id: 'bad',
      lifecycleStatus: 'confirmed' as never,
    }))).toThrow('episode lifecycleStatus is not supported: confirmed');
    expect(() => store.confirmEpisodeCanonical('missing-episode'))
      .toThrow('episode "missing-episode" does not exist');

    store.transferEpisodeMessageClaims({
      sourceEpisodeIds: ['candidate-1'],
      targetEpisodeId: 'consolidated',
      reason: 'nightly consolidation into a thematic episode',
    });
    expect(() => store.confirmEpisodeCanonical('candidate-1'))
      .toThrow('episode "candidate-1" is no longer live and cannot be confirmed canonical');
  });

  it('transfers claims to a consolidated episode and supersedes candidates without deleting them', () => {
    const store = makeStore();
    store.createEpisode(baseEpisode({ id: 'candidate-1' }));
    store.createEpisode(baseEpisode({
      id: 'candidate-2',
      startedAt: '2026-03-30T10:10:00.000Z',
      endedAt: '2026-03-30T10:15:00.000Z',
      spanRefs: [{ spanId: 'span-2' }],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-2' }],
    }));
    store.createEpisode(baseEpisode({
      id: 'consolidated',
      startedAt: '2026-03-30T10:00:00.000Z',
      endedAt: '2026-03-30T10:15:00.000Z',
      spanRefs: [{ spanId: 'span-consolidated' }],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-consolidated' }],
    }));

    store.claimEpisodeMessages({
      episodeId: 'candidate-1',
      sessionId: 'terminal:daily',
      claims: [
        { claimKey: 'l0-message:terminal:daily:1', turnId: 'turn-1' },
        { claimKey: 'l0-message:terminal:daily:2', turnId: 'turn-2' },
      ],
    });
    store.claimEpisodeMessages({
      episodeId: 'candidate-2',
      sessionId: 'terminal:daily',
      claims: [{ claimKey: 'l0-message:terminal:daily:3', turnId: 'turn-3' }],
    });

    const result = store.transferEpisodeMessageClaims({
      sourceEpisodeIds: ['candidate-1', 'candidate-2'],
      targetEpisodeId: 'consolidated',
      reason: 'nightly consolidation into a thematic episode',
    });

    expect(result.targetEpisodeId).toBe('consolidated');
    expect(result.supersededEpisodeIds).toEqual(['candidate-1', 'candidate-2']);
    expect(result.transferredClaims.map(claim => claim.claimKey).sort()).toEqual([
      'l0-message:terminal:daily:1',
      'l0-message:terminal:daily:2',
      'l0-message:terminal:daily:3',
    ]);
    expect(result.transferredClaims.every(claim => (
      claim.episodeId === 'consolidated' && claim.status === 'active'
    ))).toBe(true);

    // Superseded candidates retain their full claim history.
    const history = store.listEpisodeMessageClaims({ episodeId: 'candidate-1' });
    expect(history).toHaveLength(2);
    expect(history.every(claim => (
      claim.status === 'transferred'
      && claim.transferredToEpisodeId === 'consolidated'
      && claim.transferredAt !== undefined
      && claim.reason === 'nightly consolidation into a thematic episode'
      && claim.turnId !== undefined
    ))).toBe(true);

    // Superseded candidates are hidden from live queries but never deleted.
    expect(store.listEpisodes({ limit: 10 }).map(episode => episode.id)).toEqual(['consolidated']);
    expect(store.searchByTime({
      from: '2026-03-30T00:00:00.000Z',
      to: '2026-03-30T23:59:59.999Z',
    }).map(episode => episode.id)).toEqual(['consolidated']);
    expect(store.searchByThread('thread-alpha').map(episode => episode.id)).toEqual(['consolidated']);
    expect(store.getEpisode('candidate-1')).toBeDefined();
    expect(store.getEpisode('candidate-2')).toBeDefined();

    // The one-live-episode-per-message invariant survives the transfer.
    expect(activeClaimKeyDuplicates()).toEqual([]);
    expect(() => store.claimEpisodeMessages({
      episodeId: 'candidate-1',
      claims: [{ claimKey: 'l0-message:terminal:daily:1' }],
    })).toThrow('source message "l0-message:terminal:daily:1" is already claimed by episode "consolidated"');
  });

  it('fails closed on invalid claim transfers', () => {
    const store = makeStore();
    store.createEpisode(baseEpisode({ id: 'candidate-1' }));
    store.createEpisode(baseEpisode({
      id: 'consolidated',
      startedAt: '2026-03-30T11:00:00.000Z',
      endedAt: '2026-03-30T11:05:00.000Z',
      spanRefs: [{ spanId: 'span-2' }],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-2' }],
    }));
    store.claimEpisodeMessages({
      episodeId: 'candidate-1',
      claims: [{ claimKey: 'l0-message:terminal:daily:1' }],
    });

    expect(() => store.transferEpisodeMessageClaims({
      sourceEpisodeIds: ['candidate-1'],
      targetEpisodeId: 'missing-episode',
      reason: 'nightly consolidation',
    })).toThrow('transfer.targetEpisodeId references unknown episode "missing-episode"');
    expect(() => store.transferEpisodeMessageClaims({
      sourceEpisodeIds: ['candidate-1', 'consolidated'],
      targetEpisodeId: 'consolidated',
      reason: 'nightly consolidation',
    })).toThrow('an episode cannot receive claims transferred from itself');
    expect(() => store.transferEpisodeMessageClaims({
      sourceEpisodeIds: ['missing-episode'],
      targetEpisodeId: 'consolidated',
      reason: 'nightly consolidation',
    })).toThrow('transfer.sourceEpisodeIds references unknown episode "missing-episode"');
    expect(() => store.transferEpisodeMessageClaims({
      sourceEpisodeIds: ['candidate-1'],
      targetEpisodeId: 'consolidated',
      reason: '',
    })).toThrow('reason must be non-empty');
    expect(() => store.transferEpisodeMessageClaims({
      sourceEpisodeIds: [],
      targetEpisodeId: 'consolidated',
      reason: 'nightly consolidation',
    })).toThrow('transferEpisodeMessageClaims requires at least one source episode');

    // A superseded source cannot transfer twice: history is immutable.
    store.transferEpisodeMessageClaims({
      sourceEpisodeIds: ['candidate-1'],
      targetEpisodeId: 'consolidated',
      reason: 'nightly consolidation',
    });
    expect(() => store.transferEpisodeMessageClaims({
      sourceEpisodeIds: ['candidate-1'],
      targetEpisodeId: 'consolidated',
      reason: 'nightly consolidation',
    })).toThrow('transfer.sourceEpisodeIds references episode "candidate-1" which is no longer live');
  });
});

describe('EpisodicStore arc membership (m58.2)', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function makeArcStore(): EpisodicStore {
    db = new Database(':memory:');
    let sequence = 0;
    return new EpisodicStore(db, {
      now: () => new Date('2026-06-10T08:00:00.000Z'),
      idFactory: () => `generated-${++sequence}`,
    });
  }

  function episode(id: string, startedAt: string, endedAt: string): EpisodeCreateInput {
    return {
      id,
      title: `Episode ${id}`,
      landmark: `What happened during ${id}.`,
      startedAt,
      endedAt,
      threadId: 'thread-alpha',
      channelId: 'discord:general',
      participantContactIds: ['contact:vega'],
      salience: { score: 0.6 },
      affect: { labels: ['neutral'] },
      themes: ['books'],
      spanRefs: [{ spanId: `span-${id}` }],
      artifactRefs: [],
      provenanceRefs: [{ kind: 'l0_span', refId: `span-${id}` }],
    };
  }

  function seedEpisodes(store: EpisodicStore, ids: readonly string[]): void {
    let hour = 9;
    for (const id of ids) {
      store.createEpisode(episode(
        id,
        `2026-06-0${1 + (hour % 5)}T${String(hour).padStart(2, '0')}:00:00.000Z`,
        `2026-06-0${1 + (hour % 5)}T${String(hour).padStart(2, '0')}:30:00.000Z`,
      ));
      hour += 1;
    }
  }

  function arc(sourceEpisodeId: string, targetEpisodeId: string, overrides: Partial<import('./store.js').EpisodeArcWriteInput> = {}) {
    return {
      sourceEpisodeId,
      targetEpisodeId,
      arcKind: 'same_theme' as const,
      salience: 0.6,
      confidence: 0.8,
      themes: ['the ongoing book discussion'],
      spanRefs: [],
      artifactRefs: [],
      provenanceRefs: [],
      ...overrides,
    };
  }

  it('records a written audit entry when an arc is created with audit', () => {
    const store = makeArcStore();
    seedEpisodes(store, ['a', 'b']);

    const written = store.writeEpisodeArc(arc('a', 'b', {
      audit: { actor: 'arc_formation_pass', reason: 'same theme across days' },
    }));

    const audit = store.listEpisodeArcAudit({ arcId: written.id });
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('written');
    expect(audit[0].actor).toBe('arc_formation_pass');
    expect(audit[0].reason).toBe('same theme across days');
    expect(audit[0].detailsJson.sourceEpisodeId).toBe('a');
    expect(audit[0].detailsJson.targetEpisodeId).toBe('b');
  });

  it('fails closed when audit actor or reason is empty', () => {
    const store = makeArcStore();
    seedEpisodes(store, ['a', 'b']);
    expect(() => store.writeEpisodeArc(arc('a', 'b', {
      audit: { actor: '', reason: 'x' },
    }))).toThrow('episodeArc.audit.actor must be non-empty');
    const written = store.writeEpisodeArc(arc('a', 'b'));
    expect(() => store.removeEpisodeArc({ arcId: written.id, actor: 'operator', reason: '' }))
      .toThrow('removeEpisodeArc.reason must be non-empty');
    expect(() => store.repointEpisodeArcMemberships({
      fromEpisodeId: 'a',
      toEpisodeId: 'b',
      actor: '',
      reason: 'x',
    })).toThrow('repoint.actor must be non-empty');
  });

  it('removes an arc membership with an audit trail and keeps the row retrievable', () => {
    const store = makeArcStore();
    seedEpisodes(store, ['a', 'b']);
    const written = store.writeEpisodeArc(arc('a', 'b'));

    store.removeEpisodeArc({
      arcId: written.id,
      actor: 'arc_formation_pass',
      reason: 'episode no longer belongs to this thread',
    });

    // Membership queries stop returning the arc; the row itself survives.
    expect(store.listEpisodeArcsForEpisode('a')).toHaveLength(0);
    expect(store.listEpisodeArcsForEpisodes(['a', 'b'])).toHaveLength(0);
    expect(store.getEpisodeArc(written.id)?.id).toBe(written.id);

    const audit = store.listEpisodeArcAudit({ arcId: written.id });
    expect(audit.map(entry => entry.action)).toEqual(['removed']);
    expect(audit[0].actor).toBe('arc_formation_pass');

    // Fail closed on double-removal and unknown arcs.
    expect(() => store.removeEpisodeArc({
      arcId: written.id,
      actor: 'operator',
      reason: 'again',
    })).toThrow(`arc "${written.id}" is already retired`);
    expect(() => store.removeEpisodeArc({
      arcId: 'missing-arc',
      actor: 'operator',
      reason: 'nope',
    })).toThrow('removeEpisodeArc references unknown arc "missing-arc"');
  });

  it('re-points arc memberships onto another episode with audit history', () => {
    const store = makeArcStore();
    seedEpisodes(store, ['a', 'b', 'c']);
    const written = store.writeEpisodeArc(arc('a', 'b'));

    const result = store.repointEpisodeArcMemberships({
      fromEpisodeId: 'b',
      toEpisodeId: 'c',
      actor: 'consolidation_repoint',
      reason: 'candidate folded into consolidated episode',
    });

    expect(result.repointedArcIds).toEqual([written.id]);
    expect(result.removedArcIds).toEqual([]);
    expect(store.listEpisodeArcsForEpisode('b')).toHaveLength(0);
    const arcsOnC = store.listEpisodeArcsForEpisode('c');
    expect(arcsOnC).toHaveLength(1);
    expect(arcsOnC[0].sourceEpisodeId).toBe('a');
    expect(arcsOnC[0].targetEpisodeId).toBe('c');
    // The persisted contract JSON follows the membership change.
    expect(store.getEpisodeArc(written.id)?.targetEpisodeId).toBe('c');

    const audit = store.listEpisodeArcAudit({ arcId: written.id });
    expect(audit.map(entry => entry.action)).toEqual(['repointed']);
    expect(audit[0].actor).toBe('consolidation_repoint');
    expect(audit[0].detailsJson.previous).toEqual({ sourceEpisodeId: 'a', targetEpisodeId: 'b' });
    expect(audit[0].detailsJson.next).toEqual({ sourceEpisodeId: 'a', targetEpisodeId: 'c' });
  });

  it('retires arcs that become self-loops or duplicates during re-pointing', () => {
    const store = makeArcStore();
    seedEpisodes(store, ['a', 'b', 'c']);
    const loopArc = store.writeEpisodeArc(arc('a', 'b'));
    const duplicateSurvivor = store.writeEpisodeArc(arc('c', 'b'));
    const duplicateVictim = store.writeEpisodeArc(arc('a', 'c'));

    // Re-pointing a -> c makes loopArc(a->b) become c->b (duplicate of
    // duplicateSurvivor) and duplicateVictim(a->c) a self-loop.
    const result = store.repointEpisodeArcMemberships({
      fromEpisodeId: 'a',
      toEpisodeId: 'c',
      actor: 'consolidation_repoint',
      reason: 'a superseded by c',
    });

    expect(result.repointedArcIds).toEqual([]);
    expect([...result.removedArcIds].sort()).toEqual([duplicateVictim.id, loopArc.id].sort());
    const remaining = store.listEpisodeArcsForEpisode('c');
    expect(remaining.map(entry => entry.id)).toEqual([duplicateSurvivor.id]);

    const loopAudit = store.listEpisodeArcAudit({ arcId: loopArc.id });
    expect(loopAudit[0].action).toBe('removed');
    expect(loopAudit[0].detailsJson.cause).toBe('repoint_duplicate');
    expect(loopAudit[0].detailsJson.duplicateOfArcId).toBe(duplicateSurvivor.id);
    const victimAudit = store.listEpisodeArcAudit({ arcId: duplicateVictim.id });
    expect(victimAudit[0].detailsJson.cause).toBe('repoint_self_loop');
  });

  it('fails closed when re-pointing onto a missing or non-live episode', () => {
    const store = makeArcStore();
    seedEpisodes(store, ['a', 'b', 'c']);
    store.markEpisodeMerged('b', 'c');

    expect(() => store.repointEpisodeArcMemberships({
      fromEpisodeId: 'a',
      toEpisodeId: 'missing',
      actor: 'operator',
      reason: 'x',
    })).toThrow('repoint.toEpisodeId references unknown episode "missing"');
    expect(() => store.repointEpisodeArcMemberships({
      fromEpisodeId: 'a',
      toEpisodeId: 'b',
      actor: 'operator',
      reason: 'x',
    })).toThrow('repoint.toEpisodeId references episode "b" which is no longer live');
    expect(() => store.repointEpisodeArcMemberships({
      fromEpisodeId: 'a',
      toEpisodeId: 'a',
      actor: 'operator',
      reason: 'x',
    })).toThrow('arc memberships cannot be re-pointed onto the same episode');
  });

  it('re-points arcs when consolidation supersedes candidates via claim transfer', () => {
    const store = makeArcStore();
    seedEpisodes(store, ['candidate-1', 'candidate-2', 'other']);
    store.createEpisode(episode('consolidated', '2026-06-02T09:00:00.000Z', '2026-06-02T10:30:00.000Z'));
    store.claimEpisodeMessages({
      episodeId: 'candidate-1',
      claims: [{ claimKey: 'discord:general:m1' }],
    });
    const arcToOther = store.writeEpisodeArc(arc('candidate-1', 'other'));
    const arcBetweenSources = store.writeEpisodeArc(arc('candidate-1', 'candidate-2'));

    const result = store.transferEpisodeMessageClaims({
      sourceEpisodeIds: ['candidate-1', 'candidate-2'],
      targetEpisodeId: 'consolidated',
      reason: 'nightly consolidation',
    });

    // candidate-1's outward arc follows it onto the consolidated episode;
    // the arc between the two superseded sources collapses to a self-loop
    // and is retired. Nothing dangles on a superseded episode.
    expect(result.repointedArcIds).toEqual([arcToOther.id]);
    expect(result.removedArcIds).toEqual([arcBetweenSources.id]);
    expect(store.listEpisodeArcsForEpisode('candidate-1')).toHaveLength(0);
    expect(store.listEpisodeArcsForEpisode('candidate-2')).toHaveLength(0);
    const consolidatedArcs = store.listEpisodeArcsForEpisode('consolidated');
    expect(consolidatedArcs.map(entry => entry.id)).toEqual([arcToOther.id]);
    expect(consolidatedArcs[0].sourceEpisodeId).toBe('consolidated');
    expect(consolidatedArcs[0].targetEpisodeId).toBe('other');

    const audit = store.listEpisodeArcAudit({ arcId: arcToOther.id });
    expect(audit[0].action).toBe('repointed');
    expect(audit[0].actor).toBe('consolidation_repoint');
    expect(audit[0].reason).toBe('nightly consolidation');
  });

  it('re-points arcs when an episode is merged away', () => {
    const store = makeArcStore();
    seedEpisodes(store, ['a', 'b', 'c']);
    const written = store.writeEpisodeArc(arc('a', 'c'));

    store.markEpisodeMerged('a', 'b');

    expect(store.listEpisodeArcsForEpisode('a')).toHaveLength(0);
    const arcsOnB = store.listEpisodeArcsForEpisode('b');
    expect(arcsOnB.map(entry => entry.id)).toEqual([written.id]);
    expect(arcsOnB[0].sourceEpisodeId).toBe('b');
    const audit = store.listEpisodeArcAudit({ arcId: written.id });
    expect(audit[0].action).toBe('repointed');
    expect(audit[0].actor).toBe('consolidation_repoint');
  });
});
