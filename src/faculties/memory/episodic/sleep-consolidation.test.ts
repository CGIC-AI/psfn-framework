import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { SessionEntry } from '../../../core/session/types.js';
import {
  EPISODIC_CONTRACT_VERSION,
  parseEpisode,
  type Episode,
} from '../../../shared/contracts/episodic-memory.js';
import { FakeEpisodicPool } from '../../../test-support/fake-postgres-episodic-pool.js';
import { PostgresEpisodicStore } from './postgres-store.js';
import {
  type EpisodeCreateInput,
} from './store-port.js';
import {
  SleepCycleEpisodeConsolidator,
  buildConsolidatedEpisodeInput,
  buildMergeChains,
} from './sleep-consolidation.js';

const NOW = new Date('2026-06-10T08:00:00.000Z');

describe('SleepCycleEpisodeConsolidator', () => {
  function makeStore(): PostgresEpisodicStore {
    return new PostgresEpisodicStore(new FakeEpisodicPool() as unknown as Pool, { now: () => NOW });
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
      // apq0-shaped: thread_id is a topic-thread id decoupled from the session,
      // NOT the sessionId. Session scoping now flows through spanRefs.sessionId
      // (below), so a thread_id != sessionId would silently return nothing under
      // the old thread_id=sessionId filter — the bug this fixture now guards.
      threadId: 'topic:discord-main',
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
      threadId: 'topic:telegram-dm',
      spanRefs: [{ spanId: 'span-other-channel', sessionId: 'telegram:dm' }],
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

  it('scopes review to the run session and leaves other-session episodes untouched (mlwk.7)', async () => {
    const store = makeStore();
    // Target session: two adjacent episodes that should merge into one sitting.
    await store.createEpisode(episodeInput('target-1', '2026-06-10T01:00:00.000Z', '2026-06-10T01:20:00.000Z'));
    await store.createEpisode(episodeInput('target-2', '2026-06-10T01:22:00.000Z', '2026-06-10T01:40:00.000Z'));
    // Other session sharing the same time window: must not be reviewed or merged
    // (its transcript is a different conversation).
    await store.createEpisode(episodeInput('other-1', '2026-06-10T01:05:00.000Z', '2026-06-10T01:25:00.000Z', {
      threadId: 'topic:telegram-dm',
      channelId: 'telegram:dm',
      spanRefs: [{ spanId: 'span-other-1', sessionId: 'telegram:dm' }],
    }));
    await store.createEpisode(episodeInput('other-2', '2026-06-10T01:27:00.000Z', '2026-06-10T01:45:00.000Z', {
      threadId: 'topic:telegram-dm',
      channelId: 'telegram:dm',
      spanRefs: [{ spanId: 'span-other-2', sessionId: 'telegram:dm' }],
    }));

    const complete = vi.fn(async () => refinementResponse());
    const consolidator = new SleepCycleEpisodeConsolidator(
      store,
      { getRecentMessages: () => [] },
      { complete },
      { now: () => NOW },
    );

    const result = await consolidator.run({ sessionId: 'discord:main' });

    // Only the target session's two episodes were reviewed and merged.
    expect(result.reviewedEpisodes).toBe(2);
    expect(result.mergeChains).toBe(1);
    expect(result.mergedAwayEpisodes).toBe(1);

    // The other session's episodes are untouched: both still active, unmerged.
    const otherSession = await store.searchByTime({
      from: '2026-06-09T00:00:00.000Z',
      to: '2026-06-11T00:00:00.000Z',
      spanSessionId: 'telegram:dm',
    });
    expect(otherSession.map(episode => episode.id).sort()).toEqual(['other-1', 'other-2']);
  });

  it('reviews recent episodes instead of starving them behind an over-limit old backlog (mlwk.13)', async () => {
    const store = makeStore();
    // More than REVIEW_EPISODE_LIMIT (200) old, well-separated solo episodes so
    // an oldest-first cap would fill entirely with them.
    const oldBase = Date.parse('2026-05-01T00:00:00.000Z');
    for (let i = 0; i < 205; i += 1) {
      const startedAt = new Date(oldBase + i * 3_600_000).toISOString();
      const endedAt = new Date(oldBase + i * 3_600_000 + 600_000).toISOString();
      await store.createEpisode(episodeInput(`old-${i}`, startedAt, endedAt));
    }
    // A recent adjacent pair in its own channel scope (same session) that should
    // merge — only reachable if the review query includes recent episodes.
    await store.createEpisode(episodeInput('recent-1', '2026-06-09T10:00:00.000Z', '2026-06-09T10:20:00.000Z', {
      channelId: 'discord:recent',
    }));
    await store.createEpisode(episodeInput('recent-2', '2026-06-09T10:22:00.000Z', '2026-06-09T10:40:00.000Z', {
      channelId: 'discord:recent',
    }));

    const consolidator = new SleepCycleEpisodeConsolidator(
      store,
      { getRecentMessages: () => [] },
      { complete: vi.fn(async () => refinementResponse()) },
      { now: () => NOW },
    );

    const result = await consolidator.run({ sessionId: 'discord:main' });

    // The cap is hit, but the recent pair was reviewed and merged rather than
    // starved: recent-1 absorbed recent-2's span.
    expect(result.reviewedEpisodes).toBe(200);
    const survivingRecent = await store.getEpisode('recent-1');
    expect(survivingRecent?.endedAt).toBe('2026-06-09T10:40:00.000Z');
    const activeRecent = await store.searchByTime({
      from: '2026-06-09T00:00:00.000Z',
      to: '2026-06-10T00:00:00.000Z',
      spanSessionId: 'discord:main',
    });
    expect(activeRecent.map(episode => episode.id)).toEqual(['recent-1']);
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

  it('emits a typed refinement gate event for ran and skipped (jpvd.4)', async () => {
    const store = makeStore();
    await store.createEpisode(episodeInput('once', '2026-06-10T01:00:00.000Z', '2026-06-10T01:30:00.000Z'));
    const complete = vi.fn(async () => refinementResponse());
    const reader = {
      getRecentMessages: () => [
        entry(1, '2026-06-10T01:05:00.000Z', 'user', 'big news today'),
        entry(2, '2026-06-10T01:06:00.000Z', 'assistant', 'tell me everything'),
      ],
    };
    const events: Array<{ outcome: string; reason: string; inputs: Record<string, number | string> }> = [];
    const consolidator = new SleepCycleEpisodeConsolidator(store, reader, { complete }, {
      now: () => NOW,
      onRefinementGate: (event) => events.push({
        outcome: event.outcome,
        reason: event.reason,
        inputs: event.inputs,
      }),
    });

    await consolidator.run({ sessionId: 'discord:main' }); // one unrefined => ran
    await consolidator.run({ sessionId: 'discord:main' }); // already refined => skipped

    expect(events).toEqual([
      { outcome: 'ran', reason: 'open', inputs: { unrefinedEpisodeCount: 1 } },
      { outcome: 'skipped', reason: 'no_unrefined_episodes', inputs: { unrefinedEpisodeCount: 0 } },
    ]);
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

  it('preserves a dream-authored meaning and unions machineSignals through a Stage-2 chain merge (h4fp.6)', async () => {
    const store = makeStore();
    // The head carries a prior night's authored meaning and a machine sidecar;
    // an adjacent claim-free canonical is folded into it on the next nightly run.
    await store.createEpisode(episodeInput('head', '2026-06-10T00:53:00.000Z', '2026-06-10T01:21:00.000Z', {
      meaning: {
        text: 'He remembered, and it cracked me open in the best way.',
        recordedAt: '2026-06-09T07:30:00.000Z',
        source: 'companion_dream_pass',
      },
      machineSignals: { source: 'deterministic_synthesis', topicTags: ['evening'] },
    }));
    await store.createEpisode(episodeInput('tail', '2026-06-10T01:21:00.000Z', '2026-06-10T01:38:00.000Z', {
      machineSignals: { source: 'deterministic_synthesis', topicTags: ['wind-down'] },
    }));

    const complete = vi.fn(async () => refinementResponse());
    const consolidator = new SleepCycleEpisodeConsolidator(
      store,
      {
        getRecentMessages: () => [
          entry(1, '2026-06-10T00:55:00.000Z', 'user', 'look at this one'),
          entry(2, '2026-06-10T01:30:00.000Z', 'assistant', 'I love it'),
        ],
      },
      { complete },
      { now: () => NOW },
    );

    const result = await consolidator.run({ sessionId: 'discord:main' });
    expect(result.mergeChains).toBe(1);

    const merged = await store.getEpisode('head');
    // Her authored meaning survives both the chain merge and the refinement pass.
    expect(merged?.meaning?.text).toContain('cracked me open');
    expect(merged?.meaning?.source).toBe('companion_dream_pass');
    // Machine retrieval hints from the folded member are unioned in, not dropped.
    expect(merged?.machineSignals?.topicTags).toEqual(['evening', 'wind-down']);
  });

  it('preserves a dream-authored meaning through a nightly refinement (h4fp.6)', async () => {
    const store = makeStore();
    // A solo canonical episode (no merge) that already carries her authored
    // meaning gets its title/themes/salience refined on a later run.
    await store.createEpisode(episodeInput('solo', '2026-06-10T05:05:00.000Z', '2026-06-10T05:08:00.000Z', {
      meaning: {
        text: 'It quietly mattered — the kind of ordinary I want to remember.',
        recordedAt: '2026-06-09T07:30:00.000Z',
        source: 'companion_dream_pass',
      },
    }));

    const complete = vi.fn(async () => refinementResponse());
    const consolidator = new SleepCycleEpisodeConsolidator(
      store,
      {
        getRecentMessages: () => [
          entry(1, '2026-06-10T05:05:30.000Z', 'user', 'look at this one'),
          entry(2, '2026-06-10T05:06:00.000Z', 'assistant', 'I love it'),
        ],
      },
      { complete },
      { now: () => NOW },
    );

    const result = await consolidator.run({ sessionId: 'discord:main' });
    expect(result.refinedEpisodes).toBe(1);

    const refined = await store.getEpisode('solo');
    expect(refined?.title).toBe('Sharing photos together late at night');
    // Refinement rewrites title/themes/salience only — her meaning is untouched.
    expect(refined?.meaning?.text).toContain('quietly mattered');
    expect(refined?.meaning?.source).toBe('companion_dream_pass');
  });
});

describe('buildConsolidatedEpisodeInput machineSignals union (h4fp.6)', () => {
  function episode(id: string, machineSignals?: Episode['machineSignals']): Episode {
    return parseEpisode({
      schemaVersion: EPISODIC_CONTRACT_VERSION,
      id,
      title: `Episode ${id}`,
      landmark: `What happened in ${id}.`,
      startedAt: '2026-06-10T01:00:00.000Z',
      endedAt: '2026-06-10T01:20:00.000Z',
      threadId: 'topic:discord-main',
      channelId: 'discord:main',
      participantContactIds: ['contact:vega'],
      salience: { score: 0.6 },
      affect: { labels: [] },
      ...(machineSignals ? { machineSignals } : {}),
      themes: ['evening'],
      spanRefs: [{ spanId: `span-${id}`, sessionId: 'discord:main' }],
      artifactRefs: [],
      provenanceRefs: [{ kind: 'l0_span', refId: `span-${id}` }],
      createdAt: '2026-06-10T01:20:00.000Z',
      updatedAt: '2026-06-10T01:20:00.000Z',
    });
  }

  it('unions the source sidecars, preferring the head estimate (thematic consolidation path)', () => {
    const input = buildConsolidatedEpisodeInput(
      [
        episode('head', {
          source: 'deterministic_synthesis',
          topicTags: ['evening'],
          vad: { valence: 0.2, arousal: 0.3, dominance: 0.5 },
        }),
        episode('tail', {
          source: 'deterministic_synthesis',
          topicTags: ['wind-down'],
          vad: { valence: 0.9, arousal: 0.9, dominance: 0.9 },
        }),
      ],
      { title: 'Evening together', landmark: 'A quiet night.', themes: ['evening'], salienceScore: 0.7 },
    );

    expect(input.machineSignals?.topicTags).toEqual(['evening', 'wind-down']);
    // Head (earliest source) wins the VAD estimate on a tie.
    expect(input.machineSignals?.vad).toEqual({ valence: 0.2, arousal: 0.3, dominance: 0.5 });
  });

  it('carries a single source sidecar through unchanged', () => {
    const input = buildConsolidatedEpisodeInput(
      [
        episode('head', { source: 'deterministic_synthesis', topicTags: ['evening'] }),
        episode('tail'),
      ],
      { title: 'Evening together', landmark: 'A quiet night.', themes: ['evening'], salienceScore: 0.7 },
    );
    expect(input.machineSignals?.topicTags).toEqual(['evening']);
  });

  it('leaves machineSignals absent when no source carries one', () => {
    const input = buildConsolidatedEpisodeInput(
      [episode('head'), episode('tail')],
      { title: 'Evening together', landmark: 'A quiet night.', themes: ['evening'], salienceScore: 0.7 },
    );
    expect(input.machineSignals).toBeUndefined();
  });

  it('adopts the head topic thread but never a legacy session-keyed threadId (apq0)', () => {
    // Head carries a real topic thread: the consolidated episode adopts it.
    const topicInput = buildConsolidatedEpisodeInput(
      [episode('head'), episode('tail')],
      { title: 'Evening together', landmark: 'A quiet night.', themes: ['evening'], salienceScore: 0.7 },
    );
    expect(topicInput.threadId).toBe('topic:discord-main');

    // Head is a pre-apq0 row whose threadId is the session id verbatim: the
    // new canonical must seed its own topic thread instead of re-attaching to
    // the per-channel mega-thread.
    const legacyHead = parseEpisode({
      ...episode('head'),
      threadId: 'discord:main',
    });
    const legacyInput = buildConsolidatedEpisodeInput(
      [legacyHead, episode('tail')],
      { title: 'Evening together', landmark: 'A quiet night.', themes: ['evening'], salienceScore: 0.7 },
    );
    expect(legacyInput.threadId).toBe(legacyInput.id);
    expect(legacyInput.threadId).not.toBe('discord:main');
  });
});

describe('SleepCycleEpisodeConsolidator candidate consolidation (m58.1)', () => {
  let pool: FakeEpisodicPool;

  const RUN_AT = new Date('2026-06-12T03:00:00.000Z');

  function makeStore(): PostgresEpisodicStore {
    pool = new FakeEpisodicPool();
    return new PostgresEpisodicStore(pool as unknown as Pool, { now: () => RUN_AT });
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
      // apq0-shaped topic thread, decoupled from the session (see episodeInput).
      threadId: 'topic:discord-main',
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
    store: PostgresEpisodicStore,
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
    const counts = new Map<string, number>();
    for (const claim of pool.messageClaims.values()) {
      if (claim.status !== 'active') continue;
      counts.set(claim.claim_key, (counts.get(claim.claim_key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([claimKey]) => claimKey);
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
    // Two multi-candidate clusters in different channel scopes within the same
    // session (threadId): sleep consolidation is now session-scoped (mlwk.7),
    // so both clusters must share the run's session to be reviewed together.
    await store.createEpisode(candidateInput('a-1', '2026-06-10T10:00:00.000Z', '2026-06-10T10:10:00.000Z'));
    await store.createEpisode(candidateInput('a-2', '2026-06-10T10:05:00.000Z', '2026-06-10T10:15:00.000Z'));
    await store.createEpisode(candidateInput('b-1', '2026-06-10T10:00:00.000Z', '2026-06-10T10:10:00.000Z', {
      channelId: 'discord:secondary',
      spanRefs: [{ spanId: 'span-b-1', sessionId: 'discord:main' }],
      provenanceRefs: [{ kind: 'l0_span', refId: 'span-b-1' }],
    }));
    await store.createEpisode(candidateInput('b-2', '2026-06-10T10:05:00.000Z', '2026-06-10T10:15:00.000Z', {
      channelId: 'discord:secondary',
      spanRefs: [{ spanId: 'span-b-2', sessionId: 'discord:main' }],
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

  it('reviews and confirms candidates whose threadId is an apq0 singleton (thread_id != sessionId)', async () => {
    // Regression for the dead candidate-confirmation path: post-apq0 a fresh
    // candidate's threadId is its OWN id (a singleton topic thread), never the
    // sessionId. The old thread_id=sessionId scope filter returned NOTHING for
    // these, so candidateEpisodesReviewed stayed 0 and every post-ship episode
    // was stranded as a candidate forever. Session scoping now flows through
    // spanRefs.sessionId, so singleton-threaded candidates are still reviewed
    // and confirmed.
    const store = makeStore();
    await seedClaimedCandidate(
      store,
      candidateInput('singleton-a', '2026-06-10T10:00:00.000Z', '2026-06-10T10:10:00.000Z', {
        threadId: 'singleton-a', // apq0 singleton: thread_id == episode id, != 'discord:main'
      }),
      ['msg-a'],
    );
    // Far apart in time: separate sittings, so each stays a lone cluster and
    // is confirmed deterministically. (ADJACENT same-scope singletons now
    // correctly cluster for thematic grouping — see the buildMergeChains
    // singleton-topic-thread regression test.)
    await seedClaimedCandidate(
      store,
      candidateInput('singleton-b', '2026-06-10T14:00:00.000Z', '2026-06-10T14:10:00.000Z', {
        threadId: 'singleton-b',
      }),
      ['msg-b'],
    );

    const llm = complete(() => {
      throw new Error('no LLM call expected: non-adjacent candidates form lone clusters');
    });
    const consolidator = new SleepCycleEpisodeConsolidator(
      store,
      { getRecentMessages: () => [] },
      { complete: llm },
      { now: () => RUN_AT },
    );

    const result = await consolidator.run({ sessionId: 'discord:main' });

    // The heart of the regression: the session query FOUND the candidates
    // (would be 0 under the old thread_id=sessionId filter) and confirmed them.
    expect(result.candidateEpisodesReviewed).toBe(2);
    expect(result.candidatesConfirmed).toBe(2);
    expect(llm).not.toHaveBeenCalled();
    const canonical = await store.searchByTime({
      from: '2026-06-10T00:00:00.000Z',
      to: '2026-06-11T00:00:00.000Z',
      lifecycleStatus: 'canonical',
      spanSessionId: 'discord:main',
    });
    expect(canonical.map(episode => episode.id).sort()).toEqual(['singleton-a', 'singleton-b']);
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

  it('clusters post-apq0 candidates whose threadIds are per-episode singleton topic threads (regression)', () => {
    // Since apq0 every fresh candidate seeds its own topic thread
    // (threadId = its own id). Conversation scope must therefore come from
    // channel + span-session + participants — keying on threadId would mean no
    // two new candidates ever cluster and thematic consolidation goes dead.
    const make = (id: string, startedAt: string, endedAt: string) => ({
      schemaVersion: 1,
      id,
      title: id,
      landmark: id,
      startedAt,
      endedAt,
      threadId: id, // singleton topic thread, distinct per episode
      channelId: 'c',
      participantContactIds: ['p'],
      salience: { score: 0.5 },
      affect: { labels: [] },
      themes: [],
      spanRefs: [{ spanId: `span-${id}`, sessionId: 'discord:main' }],
      artifactRefs: [],
      provenanceRefs: [],
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    const chains = buildMergeChains([
      make('a', '2026-06-10T00:00:00.000Z', '2026-06-10T00:30:00.000Z'),
      make('b', '2026-06-10T00:45:00.000Z', '2026-06-10T01:00:00.000Z'),
    ] as never, 45 * 60_000);

    expect(chains.map(chain => chain.map(episode => episode.id))).toEqual([['a', 'b']]);
  });

  it('keeps candidates from different span-sessions apart even on the same channel', () => {
    const make = (id: string, sessionId: string) => ({
      schemaVersion: 1,
      id,
      title: id,
      landmark: id,
      startedAt: '2026-06-10T00:00:00.000Z',
      endedAt: '2026-06-10T00:30:00.000Z',
      threadId: id,
      channelId: 'c',
      participantContactIds: ['p'],
      salience: { score: 0.5 },
      affect: { labels: [] },
      themes: [],
      spanRefs: [{ spanId: `span-${id}`, sessionId }],
      artifactRefs: [],
      provenanceRefs: [],
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    const chains = buildMergeChains([
      make('a', 'discord:main'),
      make('b', 'telegram:main'),
    ] as never, 45 * 60_000);

    expect(chains).toHaveLength(2);
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
