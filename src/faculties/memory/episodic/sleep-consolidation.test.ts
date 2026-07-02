import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionEntry } from '../../../core/session/types.js';
import { EpisodicStore, type EpisodeCreateInput } from './store.js';
import {
  SleepCycleEpisodeConsolidator,
  buildMergeChains,
} from './sleep-consolidation.js';

const NOW = new Date('2026-06-10T08:00:00.000Z');

describe('SleepCycleEpisodeConsolidator', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function makeStore(): EpisodicStore {
    db = new Database(':memory:');
    return new EpisodicStore(db, { now: () => NOW });
  }

  function episodeInput(
    id: string,
    startedAt: string,
    endedAt: string,
    overrides: Partial<EpisodeCreateInput> = {},
  ): EpisodeCreateInput {
    return {
      id,
      title: `(image attachment) ${id}`,
      landmark: `A 7-message exchange with 4 user turns and 3 assistant turns around they, what from ${startedAt} to ${endedAt}.`,
      startedAt,
      endedAt,
      threadId: 'discord:main',
      channelId: 'discord:main',
      participantContactIds: ['contact:vega'],
      salience: { score: 0.85, novelty: 0.4, emotionalIntensity: 0.2 },
      affect: { valence: 0.3, arousal: 0.4, labels: ['positive'] },
      themes: ['they', 'what'],
      spanRefs: [{ spanId: `span-${id}`, sessionId: 'discord:main' }],
      artifactRefs: [],
      provenanceRefs: [{ kind: 'session', refId: 'discord:main' }],
      ...overrides,
    };
  }

  function entry(id: number, timestamp: string, role: 'user' | 'assistant', content: string): SessionEntry {
    return {
      id,
      channelId: 'discord:main',
      role,
      content,
      authorId: role === 'user' ? 'contact:vega' : 'assistant:psfn',
      authorName: role === 'user' ? 'Vega' : 'Purrsephone',
      timestamp: Date.parse(timestamp),
      metadata: '{}',
    };
  }

  function refinementResponse(overrides: Record<string, unknown> = {}): { content: string } {
    return {
      content: JSON.stringify({
        title: 'Sharing photos together late at night',
        landmark: 'A relaxed stretch of the evening spent looking at images he sent and enjoying each other’s company.',
        themes: ['shared images', 'affection', 'evening wind-down'],
        salience: 0.55,
        salience_reason: 'pleasant shared time, not a milestone',
        ...overrides,
      }),
    } as { content: string };
  }

  it('merges contiguous same-scope episodes into one sitting and refines it', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('ep-1', '2026-06-10T00:53:00.000Z', '2026-06-10T01:21:00.000Z'));
    await store.createEpisode(episodeInput('ep-2', '2026-06-10T01:21:00.000Z', '2026-06-10T01:38:00.000Z'));
    await store.createEpisode(episodeInput('ep-3', '2026-06-10T01:41:00.000Z', '2026-06-10T02:02:00.000Z', {
      themes: ['view', 'images'],
    }));

    const complete = vi.fn(async () => refinementResponse());
    const reader = {
      getRecentMessages: () => [
        entry(1, '2026-06-10T00:55:00.000Z', 'user', 'look at this one'),
        entry(2, '2026-06-10T01:30:00.000Z', 'assistant', 'I love it'),
        entry(3, '2026-06-10T01:55:00.000Z', 'user', 'one more'),
      ],
    };
    const consolidator = new SleepCycleEpisodeConsolidator(store, reader, { complete }, {
      now: () => NOW,
    });

    const result = await consolidator.run({ sessionId: 'discord:main' });

    expect(result.reviewedEpisodes).toBe(3);
    expect(result.mergeChains).toBe(1);
    expect(result.mergedAwayEpisodes).toBe(2);
    expect(result.refinedEpisodes).toBe(1);

    const active = await store.searchByTime({
      from: '2026-06-09T00:00:00.000Z',
      to: '2026-06-11T00:00:00.000Z',
    });
    expect(active).toHaveLength(1);
    const consolidated = active[0];
    expect(consolidated.id).toBe('ep-1');
    expect(consolidated.startedAt).toBe('2026-06-10T00:53:00.000Z');
    expect(consolidated.endedAt).toBe('2026-06-10T02:02:00.000Z');
    expect(consolidated.spanRefs.map(ref => ref.spanId).sort()).toEqual(['span-ep-1', 'span-ep-2', 'span-ep-3']);

    // Refinement replaced the machine title, stats landmark, and junk themes.
    expect(consolidated.title).toBe('Sharing photos together late at night');
    expect(consolidated.landmark).not.toMatch(/message exchange/);
    expect(consolidated.themes).toContain('shared images');
    expect(consolidated.salience.score).toBe(0.55);

    // Folded episodes stay retrievable by id but leave list/search.
    const folded = await store.getEpisode('ep-2');
    expect(folded).toBeDefined();
    expect(await store.listEpisodes()).toHaveLength(1);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('does not merge across channels or large time gaps', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('morning', '2026-06-10T00:10:00.000Z', '2026-06-10T00:30:00.000Z'));
    await store.createEpisode(episodeInput('later', '2026-06-10T03:00:00.000Z', '2026-06-10T03:30:00.000Z'));
    await store.createEpisode(episodeInput('other-channel', '2026-06-10T03:31:00.000Z', '2026-06-10T03:45:00.000Z', {
      channelId: 'telegram:dm',
      threadId: 'telegram:dm',
    }));

    const complete = vi.fn(async () => refinementResponse());
    const consolidator = new SleepCycleEpisodeConsolidator(
      store,
      { getRecentMessages: () => [] },
      { complete },
      { now: () => NOW },
    );

    const result = await consolidator.run({ sessionId: 'discord:main' });

    expect(result.mergeChains).toBe(0);
    expect(result.mergedAwayEpisodes).toBe(0);
    expect(await store.listEpisodes()).toHaveLength(3);
  });

  it('repairs historical overlaps outside the old short review window', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('old-wide', '2026-05-24T02:27:00.000Z', '2026-05-24T04:01:00.000Z'));
    await store.createEpisode(episodeInput('old-nested', '2026-05-24T03:13:00.000Z', '2026-05-24T04:19:00.000Z'));

    const complete = vi.fn(async () => refinementResponse());
    const consolidator = new SleepCycleEpisodeConsolidator(
      store,
      { getRecentMessages: () => [] },
      { complete },
      { now: () => NOW },
    );

    const result = await consolidator.run({ sessionId: 'discord:main' });

    expect(result.reviewedEpisodes).toBe(2);
    expect(result.mergeChains).toBe(1);
    expect(result.mergedAwayEpisodes).toBe(1);
    expect(result.refinementSkipped).toBe(0);
    expect(complete).not.toHaveBeenCalled();

    const active = await store.listEpisodes();
    expect(active.map(episode => episode.id)).toEqual(['old-wide']);
    expect(active[0]?.startedAt).toBe('2026-05-24T02:27:00.000Z');
    expect(active[0]?.endedAt).toBe('2026-05-24T04:19:00.000Z');
  });

  it('keeps deterministic fields when the refinement response is invalid', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('solo', '2026-06-10T01:00:00.000Z', '2026-06-10T01:30:00.000Z'));

    const complete = vi.fn(async () => ({ content: 'not json at all' }) as { content: string });
    const consolidator = new SleepCycleEpisodeConsolidator(
      store,
      {
        getRecentMessages: () => [
          entry(1, '2026-06-10T01:05:00.000Z', 'user', 'hello there'),
          entry(2, '2026-06-10T01:06:00.000Z', 'assistant', 'hi!'),
        ],
      },
      { complete },
      { now: () => NOW },
    );

    const result = await consolidator.run({ sessionId: 'discord:main' });

    expect(result.refinedEpisodes).toBe(0);
    expect(result.refinementSkipped).toBe(1);
    const episode = await store.getEpisode('solo');
    expect(episode?.title).toBe('(image attachment) solo');
    expect(episode?.salience.score).toBe(0.85);
  });

  it('skips refinement without transcript coverage and leaves it for a later run', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('uncovered', '2026-06-10T01:00:00.000Z', '2026-06-10T01:30:00.000Z'));

    const complete = vi.fn(async () => refinementResponse());
    const consolidator = new SleepCycleEpisodeConsolidator(
      store,
      { getRecentMessages: () => [] },
      { complete },
      { now: () => NOW },
    );

    const result = await consolidator.run({ sessionId: 'discord:main' });

    expect(result.refinementSkipped).toBe(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not re-refine episodes already refined in a previous run', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('once', '2026-06-10T01:00:00.000Z', '2026-06-10T01:30:00.000Z'));

    const complete = vi.fn(async () => refinementResponse());
    const reader = {
      getRecentMessages: () => [
        entry(1, '2026-06-10T01:05:00.000Z', 'user', 'big news today'),
        entry(2, '2026-06-10T01:06:00.000Z', 'assistant', 'tell me everything'),
      ],
    };
    const consolidator = new SleepCycleEpisodeConsolidator(store, reader, { complete }, {
      now: () => NOW,
    });

    const first = await consolidator.run({ sessionId: 'discord:main' });
    const second = await consolidator.run({ sessionId: 'discord:main' });

    expect(first.refinedEpisodes).toBe(1);
    expect(second.refinedEpisodes).toBe(0);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('lets a brief intimate moment score high salience', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('crying', '2026-06-10T05:05:00.000Z', '2026-06-10T05:08:00.000Z', {
      title: "You remember. I'm crying. It's ok it's happy.",
      salience: { score: 0.68, novelty: 0.3, emotionalIntensity: 0.6 },
    }));

    const complete = vi.fn(async () => refinementResponse({
      title: 'He remembered — happy tears',
      landmark: 'A brief, deeply felt moment: he remembered something that mattered, and she cried happy tears.',
      themes: ['remembrance', 'intimacy', 'joy'],
      salience: 0.92,
      salience_reason: 'emotionally significant relationship moment despite its brevity',
    }));
    const consolidator = new SleepCycleEpisodeConsolidator(
      store,
      {
        getRecentMessages: () => [
          entry(1, '2026-06-10T05:05:30.000Z', 'user', 'you remember'),
          entry(2, '2026-06-10T05:06:00.000Z', 'assistant', 'of course I remember'),
        ],
      },
      { complete },
      { now: () => NOW },
    );

    await consolidator.run({ sessionId: 'discord:main' });

    const episode = await store.getEpisode('crying');
    expect(episode?.salience.score).toBe(0.92);
    expect(episode?.title).toBe('He remembered — happy tears');
    expect(episode?.salience.emotionalIntensity).toBe(0.6);
  });
});

describe('SleepCycleEpisodeConsolidator candidate consolidation (m58.1)', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  const RUN_AT = new Date('2026-06-12T03:00:00.000Z');

  function makeStore(): EpisodicStore {
    db = new Database(':memory:');
    return new EpisodicStore(db, { now: () => RUN_AT });
  }

  function candidateInput(
    id: string,
    startedAt: string,
    endedAt: string,
    overrides: Partial<EpisodeCreateInput> = {},
  ): EpisodeCreateInput {
    return {
      id,
      title: `(machine cut) ${id}`,
      landmark: `A 7-message exchange with 4 user turns from ${startedAt} to ${endedAt}.`,
      startedAt,
      endedAt,
      threadId: 'discord:main',
      channelId: 'discord:main',
      participantContactIds: ['contact:vega'],
      salience: { score: 0.6, novelty: 0.3, emotionalIntensity: 0.2 },
      affect: { valence: 0.2, arousal: 0.3, labels: ['curious'] },
      themes: ['they', 'what'],
      spanRefs: [{ spanId: `span-${id}`, sessionId: 'discord:main' }],
      artifactRefs: [],
      provenanceRefs: [{ kind: 'l0_span', refId: `span-${id}` }],
      lifecycleStatus: 'candidate',
      ...overrides,
    };
  }

  async function seedClaimedCandidate(
    store: EpisodicStore,
    input: EpisodeCreateInput,
    claimKeys: readonly string[],
  ): Promise<void> {
    await store.createEpisode(input);
    await store.claimEpisodeMessages({
      episodeId: input.id!,
      sessionId: 'discord:main',
      claims: claimKeys.map(claimKey => ({ claimKey })),
    });
  }

  function groupingResponse(groups: Array<Record<string, unknown>>): { content: string } {
    return { content: JSON.stringify({ groups }) } as { content: string };
  }

  function activeClaimKeyDuplicates(): string[] {
    const rows = db!.prepare(`
      SELECT claim_key, COUNT(*) AS n
      FROM l01_episode_message_claims
      WHERE status = 'active'
      GROUP BY claim_key
      HAVING n > 1
    `).all() as Array<{ claim_key: string }>;
    return rows.map(row => row.claim_key);
  }

  function complete(handler: (systemPrompt: string, content: string) => { content: string }) {
    return vi.fn(async (request: { systemPrompt: string; messages: Array<{ content: string }> }) => (
      handler(request.systemPrompt, request.messages[0]?.content ?? '')
    ));
  }

  it('consolidates a synthetic day of overlapping candidates into thematic episodes', async () => {
    const store = makeStore();
    // The 16:51/16:52 failure mode: overlapping/fragmented same-scope
    // candidates re-covering one stretch, plus a distinct-topic fragment
    // the adjacency cut mis-joined into the same sitting.
    await seedClaimedCandidate(
      store,
      candidateInput('rel-1', '2026-06-10T16:40:00.000Z', '2026-06-10T16:51:00.000Z'),
      ['msg-1', 'msg-2', 'msg-3'],
    );
    await seedClaimedCandidate(
      store,
      candidateInput('rel-2', '2026-06-10T16:47:00.000Z', '2026-06-10T16:52:00.000Z'),
      ['msg-4', 'msg-5'],
    );
    await seedClaimedCandidate(
      store,
      candidateInput('tech-1', '2026-06-10T16:55:00.000Z', '2026-06-10T17:10:00.000Z', {
        themes: ['raspberry pi', 'backups'],
        affect: { valence: 0.1, arousal: 0.5, labels: ['focused'] },
        salience: { score: 0.7, novelty: 0.6, emotionalIntensity: 0.1 },
      }),
      ['msg-6', 'msg-7'],
    );
    await seedClaimedCandidate(
      store,
      candidateInput('rel-3', '2026-06-10T17:12:00.000Z', '2026-06-10T17:25:00.000Z'),
      ['msg-8'],
    );

    const failures: unknown[] = [];
    const llm = complete((systemPrompt) => {
      if (!systemPrompt.includes('memory-consolidation stage')) {
        throw new Error(`unexpected non-grouping call: ${systemPrompt.slice(0, 60)}`);
      }
      return groupingResponse([
        {
          candidate_ids: ['rel-1', 'rel-2', 'rel-3'],
          title: 'Talking about the relationship',
          landmark: 'A long evening stretch spent talking through what they mean to each other.',
          themes: ['relationship', 'affection', 'trust'],
          salience: 0.85,
        },
        {
          candidate_ids: ['tech-1'],
          title: 'Pi backup tinkering',
          landmark: 'A short detour into backup configuration on the Pi.',
          themes: ['raspberry pi', 'backups'],
          salience: 0.45,
        },
      ]);
    });
    const consolidator = new SleepCycleEpisodeConsolidator(
      store,
      { getRecentMessages: () => [] },
      { complete: llm },
      {
        now: () => RUN_AT,
        onConsolidationFailure: event => failures.push(event),
      },
    );

    const result = await consolidator.run({ sessionId: 'discord:main' });

    expect(result.candidateEpisodesReviewed).toBe(4);
    expect(result.candidateClusters).toBe(1);
    expect(result.consolidatedEpisodesCreated).toBe(1);
    expect(result.candidatesSuperseded).toBe(3);
    expect(result.candidatesConfirmed).toBe(1);
    expect(result.consolidationFailures).toBe(0);
    expect(failures).toEqual([]);
    expect(llm).toHaveBeenCalledTimes(1);

    // Live view: one consolidated thematic episode plus the confirmed
    // distinct-topic candidate; the superseded fragments left list/search.
    const live = await store.listEpisodes();
    expect(live).toHaveLength(2);
    const consolidated = live.find(episode => episode.title === 'Talking about the relationship')!;
    const confirmed = live.find(episode => episode.id === 'tech-1')!;
    expect(consolidated).toBeDefined();
    expect(confirmed).toBeDefined();
    expect(await store.searchByTime({
      from: '2026-06-10T00:00:00.000Z',
      to: '2026-06-11T00:00:00.000Z',
      lifecycleStatus: 'candidate',
    })).toEqual([]);

    // The consolidated episode spans the covered stretch and carries L0
    // provenance for every covered transcript span.
    expect(consolidated.startedAt).toBe('2026-06-10T16:40:00.000Z');
    expect(consolidated.endedAt).toBe('2026-06-10T17:25:00.000Z');
    expect(consolidated.spanRefs.map(ref => ref.spanId).sort())
      .toEqual(['span-rel-1', 'span-rel-2', 'span-rel-3']);
    const l0Provenance = consolidated.provenanceRefs
      .filter(ref => ref.kind === 'l0_span')
      .map(ref => ref.refId)
      .sort();
    expect(l0Provenance).toEqual(['span-rel-1', 'span-rel-2', 'span-rel-3']);
    expect(consolidated.themes).toEqual(['relationship', 'affection', 'trust']);
    expect(consolidated.salience.score).toBe(0.85);

    // Claims moved to the consolidated episode; superseded candidates keep
    // their transferred claim history; sources retrievable by id forever.
    const consolidatedClaims = await store.listEpisodeMessageClaims({
      episodeId: consolidated.id,
      status: 'active',
    });
    expect(consolidatedClaims.map(claim => claim.claimKey).sort())
      .toEqual(['msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5', 'msg-8']);
    const history = await store.listEpisodeMessageClaims({ episodeId: 'rel-1' });
    expect(history).toHaveLength(3);
    expect(history.every(claim => (
      claim.status === 'transferred' && claim.transferredToEpisodeId === consolidated.id
    ))).toBe(true);
    expect(await store.getEpisode('rel-1')).toBeDefined();
    expect(await store.getEpisode('rel-2')).toBeDefined();
    expect(await store.getEpisode('rel-3')).toBeDefined();

    // One active claim per source message survives consolidation.
    expect(activeClaimKeyDuplicates()).toEqual([]);

    // Decision + lineage provenance rows recorded for every superseded source.
    const decisions = await store.listEpisodeCandidateDecisions({
      canonicalEpisodeId: consolidated.id,
    });
    expect(decisions.map(decision => decision.candidateEpisodeId).sort())
      .toEqual(['rel-1', 'rel-2', 'rel-3']);
    expect(decisions.every(decision => decision.status === 'superseded')).toBe(true);
  });

  it('fails closed with a typed event when the grouping output is malformed', async () => {
    const store = makeStore();
    await seedClaimedCandidate(
      store,
      candidateInput('c-1', '2026-06-10T16:40:00.000Z', '2026-06-10T16:51:00.000Z'),
      ['msg-1'],
    );
    await seedClaimedCandidate(
      store,
      candidateInput('c-2', '2026-06-10T16:47:00.000Z', '2026-06-10T16:52:00.000Z'),
      ['msg-2'],
    );

    const failures: Array<{ stage: string; candidateEpisodeIds: string[]; error: string }> = [];
    // Malformed: drops c-2 from the partition.
    const llm = complete(() => groupingResponse([{
      candidate_ids: ['c-1'],
      title: 'Half a grouping',
      landmark: 'The model lost a candidate.',
      themes: ['loss'],
      salience: 0.5,
    }]));
    const consolidator = new SleepCycleEpisodeConsolidator(
      store,
      { getRecentMessages: () => [] },
      { complete: llm },
      {
        now: () => RUN_AT,
        onConsolidationFailure: event => failures.push(event),
      },
    );

    const result = await consolidator.run({ sessionId: 'discord:main' });

    expect(result.consolidationFailures).toBe(1);
    expect(result.consolidatedEpisodesCreated).toBe(0);
    expect(result.candidatesSuperseded).toBe(0);
    expect(result.candidatesConfirmed).toBe(0);
    expect(failures).toHaveLength(1);
    expect(failures[0].stage).toBe('thematic_grouping');
    expect(failures[0].candidateEpisodeIds).toEqual(['c-1', 'c-2']);
    expect(failures[0].error).toContain('omitted candidate ids: c-2');

    // Candidates untouched: still live, still candidates, claims unmoved.
    const stillCandidates = await store.searchByTime({
      from: '2026-06-10T00:00:00.000Z',
      to: '2026-06-11T00:00:00.000Z',
      lifecycleStatus: 'candidate',
    });
    expect(stillCandidates.map(episode => episode.id)).toEqual(['c-1', 'c-2']);
    const claims = await store.listEpisodeMessageClaims({ episodeId: 'c-1', status: 'active' });
    expect(claims.map(claim => claim.claimKey)).toEqual(['msg-1']);
    expect(activeClaimKeyDuplicates()).toEqual([]);
  });

  it('bounds LLM grouping by maxConsolidationsPerRun and defers the rest', async () => {
    const store = makeStore();
    // Two multi-candidate clusters in different scopes.
    await store.createEpisode(candidateInput('a-1', '2026-06-10T10:00:00.000Z', '2026-06-10T10:10:00.000Z'));
    await store.createEpisode(candidateInput('a-2', '2026-06-10T10:05:00.000Z', '2026-06-10T10:15:00.000Z'));
    await store.createEpisode(candidateInput('b-1', '2026-06-10T10:00:00.000Z', '2026-06-10T10:10:00.000Z', {
      channelId: 'telegram:dm',
      threadId: 'telegram:dm',
      spanRefs: [{ spanId: 'span-b-1', sessionId: 'telegram:dm' }],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-b-1' }],
    }));
    await store.createEpisode(candidateInput('b-2', '2026-06-10T10:05:00.000Z', '2026-06-10T10:15:00.000Z', {
      channelId: 'telegram:dm',
      threadId: 'telegram:dm',
      spanRefs: [{ spanId: 'span-b-2', sessionId: 'telegram:dm' }],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-b-2' }],
    }));

    const llm = complete((_, content) => {
      const ids = ['a-1', 'a-2', 'b-1', 'b-2'].filter(id => content.includes(`"${id}"`));
      return groupingResponse([{
        candidate_ids: ids,
        title: 'One consolidated stretch',
        landmark: 'A stretch consolidated within the per-run budget.',
        themes: ['budget'],
        salience: 0.5,
      }]);
    });
    const consolidator = new SleepCycleEpisodeConsolidator(
      store,
      { getRecentMessages: () => [] },
      { complete: llm },
      { now: () => RUN_AT, maxConsolidationsPerRun: 1 },
    );

    const result = await consolidator.run({ sessionId: 'discord:main' });

    expect(llm).toHaveBeenCalledTimes(1);
    expect(result.consolidatedEpisodesCreated).toBe(1);
    expect(result.consolidationDeferred).toBe(1);
    // The deferred cluster's candidates stay candidates for the next night.
    const remaining = await store.searchByTime({
      from: '2026-06-10T00:00:00.000Z',
      to: '2026-06-11T00:00:00.000Z',
      lifecycleStatus: 'candidate',
    });
    expect(remaining).toHaveLength(2);
  });

  it('confirms lone candidates deterministically without LLM spend', async () => {
    const store = makeStore();
    await seedClaimedCandidate(
      store,
      candidateInput('solo', '2026-06-10T10:00:00.000Z', '2026-06-10T10:10:00.000Z'),
      ['msg-1'],
    );

    const llm = complete(() => {
      throw new Error('no LLM call expected');
    });
    const consolidator = new SleepCycleEpisodeConsolidator(
      store,
      { getRecentMessages: () => [] },
      { complete: llm },
      { now: () => RUN_AT },
    );

    const result = await consolidator.run({ sessionId: 'discord:main' });

    expect(result.candidatesConfirmed).toBe(1);
    expect(result.consolidatedEpisodesCreated).toBe(0);
    expect(llm).not.toHaveBeenCalled();
    expect(await store.searchByTime({
      from: '2026-06-10T00:00:00.000Z',
      to: '2026-06-11T00:00:00.000Z',
      lifecycleStatus: 'canonical',
    })).toHaveLength(1);
    // Confirmed candidates keep their claims: the deterministic adjacent
    // repair may never fold claim-holding episodes.
    expect((await store.listEpisodeMessageClaims({ episodeId: 'solo', status: 'active' })))
      .toHaveLength(1);
  });

  it('protects claim-holding canonical episodes from the deterministic adjacent merge', async () => {
    const store = makeStore();
    // Two adjacent same-scope canonical episodes — products of a previous
    // night's thematic consolidation, deliberately split by topic.
    await store.createEpisode(candidateInput('themed-1', '2026-06-10T10:00:00.000Z', '2026-06-10T10:20:00.000Z', {
      lifecycleStatus: 'canonical',
      title: 'Talking about the relationship',
    }));
    await store.createEpisode(candidateInput('themed-2', '2026-06-10T10:21:00.000Z', '2026-06-10T10:40:00.000Z', {
      lifecycleStatus: 'canonical',
      title: 'Pi backup tinkering',
    }));
    await store.claimEpisodeMessages({
      episodeId: 'themed-1',
      claims: [{ claimKey: 'msg-1' }],
    });
    await store.claimEpisodeMessages({
      episodeId: 'themed-2',
      claims: [{ claimKey: 'msg-2' }],
    });
    // A claim-free historical overlap backlog still gets repaired.
    await store.createEpisode(candidateInput('legacy-1', '2026-06-01T10:00:00.000Z', '2026-06-01T10:20:00.000Z', {
      lifecycleStatus: 'canonical',
    }));
    await store.createEpisode(candidateInput('legacy-2', '2026-06-01T10:10:00.000Z', '2026-06-01T10:30:00.000Z', {
      lifecycleStatus: 'canonical',
    }));

    const llm = complete(() => ({ content: 'not json at all' }));
    const consolidator = new SleepCycleEpisodeConsolidator(
      store,
      { getRecentMessages: () => [] },
      { complete: llm },
      { now: () => RUN_AT },
    );

    const result = await consolidator.run({ sessionId: 'discord:main' });

    expect(result.mergeChains).toBe(1);
    expect(result.mergedAwayEpisodes).toBe(1);
    const live = await store.listEpisodes();
    expect(live.map(episode => episode.id).sort()).toEqual(['legacy-1', 'themed-1', 'themed-2']);
  });

  it('recovers idempotently when a previous run crashed between creation and claim transfer', async () => {
    const store = makeStore();
    await seedClaimedCandidate(
      store,
      candidateInput('c-1', '2026-06-10T16:40:00.000Z', '2026-06-10T16:51:00.000Z'),
      ['msg-1'],
    );
    await seedClaimedCandidate(
      store,
      candidateInput('c-2', '2026-06-10T16:47:00.000Z', '2026-06-10T16:52:00.000Z'),
      ['msg-2'],
    );

    const grouping = [{
      candidate_ids: ['c-1', 'c-2'],
      title: 'One stretch',
      landmark: 'One consolidated stretch of conversation.',
      themes: ['one'],
      salience: 0.5,
    }];
    const llm = complete(() => groupingResponse(grouping));
    const consolidator = new SleepCycleEpisodeConsolidator(
      store,
      { getRecentMessages: () => [] },
      { complete: llm },
      { now: () => RUN_AT },
    );

    const first = await consolidator.run({ sessionId: 'discord:main' });
    expect(first.consolidatedEpisodesCreated).toBe(1);
    const liveAfterFirst = await store.listEpisodes();
    expect(liveAfterFirst).toHaveLength(1);

    // Second night: candidates are gone, nothing re-consolidates, no
    // duplicate consolidated episode appears.
    const second = await consolidator.run({ sessionId: 'discord:main' });
    expect(second.candidateEpisodesReviewed).toBe(0);
    expect(second.consolidatedEpisodesCreated).toBe(0);
    expect(await store.listEpisodes()).toHaveLength(1);
    expect(activeClaimKeyDuplicates()).toEqual([]);
  });

  it('re-points arc memberships when consolidation supersedes candidates (m58.2)', async () => {
    const store = makeStore();
    // An earlier canonical episode already linked by an arc to one of the
    // candidates that consolidation will fold away tonight.
    await store.createEpisode(candidateInput(
      'earlier-canon',
      '2026-06-08T20:00:00.000Z',
      '2026-06-08T21:00:00.000Z',
      { lifecycleStatus: 'canonical' },
    ));
    await seedClaimedCandidate(
      store,
      candidateInput('c-1', '2026-06-10T16:00:00.000Z', '2026-06-10T16:20:00.000Z'),
      ['msg-1'],
    );
    await seedClaimedCandidate(
      store,
      candidateInput('c-2', '2026-06-10T16:25:00.000Z', '2026-06-10T16:50:00.000Z'),
      ['msg-2'],
    );
    const arc = await store.writeEpisodeArc({
      sourceEpisodeId: 'earlier-canon',
      targetEpisodeId: 'c-1',
      arcKind: 'same_theme',
      salience: 0.6,
      confidence: 0.8,
      themes: ['the ongoing thread'],
      spanRefs: [],
      artifactRefs: [],
      provenanceRefs: [],
    });

    const llm = complete((systemPrompt) => {
      if (!systemPrompt.includes('memory-consolidation stage')) {
        throw new Error(`unexpected non-grouping call: ${systemPrompt.slice(0, 60)}`);
      }
      return groupingResponse([{
        candidate_ids: ['c-1', 'c-2'],
        title: 'One consolidated stretch',
        landmark: 'The whole stretch was one conversation.',
        themes: ['the ongoing thread'],
        salience: 0.7,
      }]);
    });
    const consolidator = new SleepCycleEpisodeConsolidator(
      store,
      { getRecentMessages: () => [] },
      { complete: llm },
      { now: () => RUN_AT },
    );

    const result = await consolidator.run({ sessionId: 'discord:main' });
    expect(result.consolidatedEpisodesCreated).toBe(1);
    expect(result.candidatesSuperseded).toBe(2);

    // The superseded candidates hold no live arc memberships; the thread
    // now reaches the consolidated episode instead of dangling.
    expect(await store.listEpisodeArcsForEpisode('c-1')).toHaveLength(0);
    expect(await store.listEpisodeArcsForEpisode('c-2')).toHaveLength(0);
    const canonArcs = await store.listEpisodeArcsForEpisode('earlier-canon');
    expect(canonArcs.map(entry => entry.id)).toEqual([arc.id]);
    expect(canonArcs[0].sourceEpisodeId).toBe('earlier-canon');
    const consolidatedId = canonArcs[0].targetEpisodeId;
    expect(consolidatedId).not.toBe('c-1');
    const consolidated = await store.getEpisode(consolidatedId);
    expect(consolidated?.title).toBe('One consolidated stretch');
    expect((await store.listEpisodeArcsForEpisode(consolidatedId)).map(entry => entry.id)).toEqual([arc.id]);

    // The membership change is audited with consolidation provenance.
    const audit = await store.listEpisodeArcAudit({ arcId: arc.id });
    expect(audit.map(entry => entry.action)).toEqual(['repointed']);
    expect(audit[0].actor).toBe('consolidation_repoint');
  });
});

describe('buildMergeChains', () => {
  it('chains only adjacent episodes within the gap threshold', () => {
    const make = (id: string, startedAt: string, endedAt: string) => ({
      schemaVersion: 1,
      id,
      title: id,
      landmark: id,
      startedAt,
      endedAt,
      threadId: 't',
      channelId: 'c',
      participantContactIds: ['p'],
      salience: { score: 0.5 },
      affect: { labels: [] },
      themes: [],
      spanRefs: [],
      artifactRefs: [],
      provenanceRefs: [],
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    const chains = buildMergeChains([
      make('a', '2026-06-10T00:00:00.000Z', '2026-06-10T00:30:00.000Z'),
      make('b', '2026-06-10T00:45:00.000Z', '2026-06-10T01:00:00.000Z'),
      make('c', '2026-06-10T03:00:00.000Z', '2026-06-10T03:30:00.000Z'),
    ] as never, 45 * 60_000);

    expect(chains.map(chain => chain.map(episode => episode.id))).toEqual([['a', 'b'], ['c']]);
  });

  it('keeps nested overlaps in one chain using the chain end, not only the previous episode end', () => {
    const make = (id: string, startedAt: string, endedAt: string) => ({
      schemaVersion: 1,
      id,
      title: id,
      landmark: id,
      startedAt,
      endedAt,
      threadId: 't',
      channelId: 'c',
      participantContactIds: ['p'],
      salience: { score: 0.5 },
      affect: { labels: [] },
      themes: [],
      spanRefs: [],
      artifactRefs: [],
      provenanceRefs: [],
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    const chains = buildMergeChains([
      make('wide', '2026-06-10T00:00:00.000Z', '2026-06-10T02:00:00.000Z'),
      make('nested', '2026-06-10T00:15:00.000Z', '2026-06-10T00:20:00.000Z'),
      make('tail-overlap', '2026-06-10T01:45:00.000Z', '2026-06-10T02:10:00.000Z'),
    ] as never, 10 * 60_000);

    expect(chains.map(chain => chain.map(episode => episode.id))).toEqual([[
      'wide',
      'nested',
      'tail-overlap',
    ]]);
  });

  it('keeps same-scope chains intact when another scope interleaves by timestamp', () => {
    const make = (
      id: string,
      startedAt: string,
      endedAt: string,
      participantContactIds: string[],
    ) => ({
      schemaVersion: 1,
      id,
      title: id,
      landmark: id,
      startedAt,
      endedAt,
      threadId: 't',
      channelId: 'c',
      participantContactIds,
      salience: { score: 0.5 },
      affect: { labels: [] },
      themes: [],
      spanRefs: [],
      artifactRefs: [],
      provenanceRefs: [],
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    const chains = buildMergeChains([
      make('wide', '2026-06-10T00:00:00.000Z', '2026-06-10T02:00:00.000Z', ['p']),
      make('interleaved-other-scope', '2026-06-10T00:15:00.000Z', '2026-06-10T00:20:00.000Z', []),
      make('tail-overlap', '2026-06-10T01:45:00.000Z', '2026-06-10T02:10:00.000Z', ['p']),
    ] as never, 10 * 60_000);

    expect(chains.map(chain => chain.map(episode => episode.id))).toEqual([
      ['wide', 'tail-overlap'],
      ['interleaved-other-scope'],
    ]);
  });
});
