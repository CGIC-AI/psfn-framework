import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { FakeEpisodicPool } from '../../../test-support/fake-postgres-episodic-pool.js';
import { PostgresEpisodicStore } from '../episodic/postgres-store.js';
import {
  type EpisodeCreateInput,
} from '../episodic/store-port.js';
import { classifyChannelDisclosure } from '../../../system/trust/policy.js';
import {
  buildEpisodicChainFromRoot,
  listEpisodeArcMemberships,
  retrieveEpisodicChains,
  searchEpisodicEpisodesLexically,
} from './episodic.js';

const NOW = new Date('2026-06-10T08:00:00.000Z');

describe('listEpisodeArcMemberships', () => {
  function makeStore(): PostgresEpisodicStore {
    let sequence = 0;
    return new PostgresEpisodicStore(new FakeEpisodicPool() as unknown as Pool, {
      now: () => NOW,
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

  it('lists the arcs an episode belongs to with resolved members in order', async () => {
    const store = makeStore();
    await store.createCompanionAuthoredEpisode(episode('monday', '2026-06-01T20:00:00.000Z', '2026-06-01T21:00:00.000Z'));
    await store.createCompanionAuthoredEpisode(episode('wednesday', '2026-06-03T20:00:00.000Z', '2026-06-03T21:00:00.000Z'));
    await store.createCompanionAuthoredEpisode(episode('friday', '2026-06-05T20:00:00.000Z', '2026-06-05T21:00:00.000Z'));
    const first = await store.writeEpisodeArc({
      sourceEpisodeId: 'monday',
      targetEpisodeId: 'wednesday',
      arcKind: 'same_theme',
      salience: 0.6,
      confidence: 0.8,
      themes: ['the ongoing book discussion'],
      spanRefs: [],
      artifactRefs: [],
      provenanceRefs: [],
    });
    await store.writeEpisodeArc({
      sourceEpisodeId: 'wednesday',
      targetEpisodeId: 'friday',
      arcKind: 'continuation',
      salience: 0.6,
      confidence: 0.7,
      themes: ['the ongoing book discussion'],
      spanRefs: [],
      artifactRefs: [],
      provenanceRefs: [],
    });

    const memberships = await listEpisodeArcMemberships(store, 'wednesday');

    expect(memberships).toHaveLength(2);
    for (const membership of memberships) {
      expect(membership.members.map(member => member.id))
        .toContain('wednesday');
      // Members come back chronological, fully resolved.
      const [earlier, later] = membership.members;
      expect(earlier.startedAt <= later.startedAt).toBe(true);
      expect(earlier.title.startsWith('Episode ')).toBe(true);
    }
    const sameTheme = memberships.find(membership => membership.arc.id === first.id);
    expect(sameTheme?.members.map(member => member.id)).toEqual(['monday', 'wednesday']);
  });

  it('filters by arc kind and returns nothing for unlinked episodes', async () => {
    const store = makeStore();
    await store.createCompanionAuthoredEpisode(episode('a', '2026-06-01T20:00:00.000Z', '2026-06-01T21:00:00.000Z'));
    await store.createCompanionAuthoredEpisode(episode('b', '2026-06-03T20:00:00.000Z', '2026-06-03T21:00:00.000Z'));
    await store.writeEpisodeArc({
      sourceEpisodeId: 'a',
      targetEpisodeId: 'b',
      arcKind: 'causal',
      salience: 0.6,
      confidence: 0.8,
      themes: ['cause and effect'],
      spanRefs: [],
      artifactRefs: [],
      provenanceRefs: [],
    });

    expect(await listEpisodeArcMemberships(store, 'a', { arcKind: 'same_theme' })).toEqual([]);
    expect(await listEpisodeArcMemberships(store, 'a', { arcKind: 'causal' })).toHaveLength(1);
    const unlinked = await store.createCompanionAuthoredEpisode(episode('c', '2026-06-05T20:00:00.000Z', '2026-06-05T21:00:00.000Z'));
    expect(await listEpisodeArcMemberships(store, unlinked.id)).toEqual([]);
  });

  it('keeps arcs reachable from the consolidated episode after supersession', async () => {
    const store = makeStore();
    await store.createCompanionAuthoredEpisode(episode('canon', '2026-06-01T20:00:00.000Z', '2026-06-01T21:00:00.000Z'));
    await store.createCompanionAuthoredEpisode(episode('candidate', '2026-06-03T20:00:00.000Z', '2026-06-03T21:00:00.000Z'));
    await store.createCompanionAuthoredEpisode(episode('consolidated', '2026-06-03T19:00:00.000Z', '2026-06-03T22:00:00.000Z'));
    await store.claimEpisodeMessages({ episodeId: 'candidate', claims: [{ claimKey: 'm-1' }] });
    await store.writeEpisodeArc({
      sourceEpisodeId: 'canon',
      targetEpisodeId: 'candidate',
      arcKind: 'same_theme',
      salience: 0.6,
      confidence: 0.8,
      themes: ['the ongoing thread'],
      spanRefs: [],
      artifactRefs: [],
      provenanceRefs: [],
    });

    await store.transferEpisodeMessageClaims({
      sourceEpisodeIds: ['candidate'],
      targetEpisodeId: 'consolidated',
      reason: 'nightly consolidation',
    });

    const memberships = await listEpisodeArcMemberships(store, 'consolidated');
    expect(memberships).toHaveLength(1);
    expect(memberships[0].members.map(member => member.id)).toEqual(['canon', 'consolidated']);
    expect(await listEpisodeArcMemberships(store, 'candidate')).toEqual([]);
  });

  it('fails closed when an arc references an unavailable member episode', async () => {
    const store = makeStore();
    await store.createCompanionAuthoredEpisode(episode('a', '2026-06-01T20:00:00.000Z', '2026-06-01T21:00:00.000Z'));
    await store.createCompanionAuthoredEpisode(episode('b', '2026-06-03T20:00:00.000Z', '2026-06-03T21:00:00.000Z'));
    const written = await store.writeEpisodeArc({
      sourceEpisodeId: 'a',
      targetEpisodeId: 'b',
      arcKind: 'same_theme',
      salience: 0.6,
      confidence: 0.8,
      themes: ['thread'],
      spanRefs: [],
      artifactRefs: [],
      provenanceRefs: [],
    });

    const brokenStore = {
      listEpisodeArcsForEpisode: store.listEpisodeArcsForEpisode.bind(store),
      getEpisodesByIds: () => [],
    };
    await expect(listEpisodeArcMemberships(brokenStore, 'a'))
      .rejects.toThrow(`episode arc "${written.id}" references unavailable episode`);
  });
});

describe('retrieveEpisodicChains rolled-out session breadcrumbs', () => {
  function makeStore(): PostgresEpisodicStore {
    let sequence = 0;
    return new PostgresEpisodicStore(new FakeEpisodicPool() as unknown as Pool, {
      now: () => NOW,
      idFactory: () => `breadcrumb-generated-${++sequence}`,
    });
  }

  async function createEpisode(
    store: PostgresEpisodicStore,
    input: {
      id: string;
      title: string;
      landmark: string;
      startedAt: string;
      endedAt: string;
      channelId?: string;
      threadId?: string;
      meaning?: string;
      participantContactIds?: string[];
    },
  ): Promise<void> {
    await store.createCompanionAuthoredEpisode({
      id: input.id,
      title: input.title,
      landmark: input.landmark,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      threadId: input.threadId ?? 'session:current',
      channelId: input.channelId ?? 'discord:current',
      participantContactIds: input.participantContactIds ?? ['contact:current'],
      salience: { score: 0.6 },
      affect: { labels: ['warm'] },
      themes: ['shared-life'],
      // apq0: rolled-out breadcrumbs scope by real span-session identity, so the
      // session must live in the span ref, not the (now topic-thread) thread_id.
      spanRefs: [{ spanId: `span-${input.id}`, sessionId: 'session:current' }],
      artifactRefs: [],
      provenanceRefs: [{ kind: 'l0_span', refId: `span-${input.id}` }],
      ...(input.meaning
        ? {
            meaning: {
              text: input.meaning,
              recordedAt: NOW.toISOString(),
              source: 'companion_direct' as const,
            },
          }
        : {}),
    });
  }

  it('retrieves an episode whose only lexical match is companion-authored meaning', async () => {
    const store = makeStore();
    await createEpisode(store, {
      id: 'meaning-only-match',
      title: 'A quiet afternoon',
      landmark: 'We sat together after lunch.',
      startedAt: '2026-06-08T18:00:00.000Z',
      endedAt: '2026-06-08T20:00:00.000Z',
      meaning: 'I realized the kintsugi lesson was about trusting repair.',
    });

    const chains = await retrieveEpisodicChains(store, {
      contextText: 'kintsugi',
      channelId: 'discord:current',
      trustLevel: 'regular',
      channelDisclosure: classifyChannelDisclosure('discord:current', { isDirectMessage: true }),
      canonicalContactId: 'contact:current',
      maxChains: 1,
    });

    expect(chains).toEqual([
      expect.objectContaining({
        rootEpisodeId: 'meaning-only-match',
        matchedTerms: ['kintsugi'],
      }),
    ]);
  });

  it('returns bounded lexical episode results with exact ids and match evidence', async () => {
    const store = makeStore();
    await createEpisode(store, {
      id: 'repair-first',
      title: 'Repairing the cedar planter',
      landmark: 'We fitted the broken corner together.',
      startedAt: '2026-06-08T18:00:00.000Z',
      endedAt: '2026-06-08T20:00:00.000Z',
    });
    await createEpisode(store, {
      id: 'repair-second',
      title: 'Another repair',
      landmark: 'We mended the shelf.',
      startedAt: '2026-06-07T18:00:00.000Z',
      endedAt: '2026-06-07T20:00:00.000Z',
    });

    const results = await searchEpisodicEpisodesLexically(store, {
      query: 'cedar repair',
      channelId: 'discord:current',
      trustLevel: 'regular',
      channelDisclosure: classifyChannelDisclosure('discord:current', { isDirectMessage: true }),
      canonicalContactId: 'contact:current',
      limit: 1,
    });

    expect(results).toEqual([
      expect.objectContaining({
        episode: expect.objectContaining({ id: 'repair-first' }),
        matchedTerms: ['cedar', 'repair'],
        lexicalScore: expect.any(Number),
        retrievalMode: 'lexical',
      }),
    ]);
  });

  it('lets explicit companion-self reflection cross channels while preserving scope-only filters', async () => {
    const store = makeStore();
    await createEpisode(store, {
      id: 'cross-channel-reflection',
      title: 'The kintsugi realization',
      landmark: 'A private realization in another conversation.',
      startedAt: '2026-06-08T18:00:00.000Z',
      endedAt: '2026-06-08T20:00:00.000Z',
      channelId: 'discord:other-private-room',
      participantContactIds: ['contact:someone-else'],
    });
    const baseInput = {
      query: 'kintsugi',
      channelId: 'internal:reflection:daily',
      trustLevel: 'regular' as const,
      channelDisclosure: classifyChannelDisclosure('internal:reflection:daily', { isDirectMessage: true }),
      limit: 1,
    };

    expect(await searchEpisodicEpisodesLexically(store, baseInput)).toEqual([]);
    expect(await searchEpisodicEpisodesLexically(store, {
      ...baseInput,
      accessScope: 'companion_self_reflection',
    })).toEqual([
      expect.objectContaining({
        episode: expect.objectContaining({ id: 'cross-channel-reflection' }),
      }),
    ]);
    expect(await searchEpisodicEpisodesLexically(store, {
      ...baseInput,
      accessScope: 'companion_self_reflection',
      scopeQuery: { mode: 'only', tags: ['unrelated-scope'] },
    })).toEqual([]);
  });

  it('expands an externally selected visible root through the canonical arc-chain builder', async () => {
    const store = makeStore();
    await createEpisode(store, {
      id: 'semantic-root',
      title: 'A selected semantic root',
      landmark: 'The root was selected outside lexical ranking.',
      startedAt: '2026-06-07T18:00:00.000Z',
      endedAt: '2026-06-07T20:00:00.000Z',
    });
    await createEpisode(store, {
      id: 'semantic-related',
      title: 'What followed afterward',
      landmark: 'This continuation belongs in the expanded chain.',
      startedAt: '2026-06-08T18:00:00.000Z',
      endedAt: '2026-06-08T20:00:00.000Z',
    });
    const arc = await store.writeEpisodeArc({
      sourceEpisodeId: 'semantic-root',
      targetEpisodeId: 'semantic-related',
      arcKind: 'continuation',
      salience: 0.8,
      confidence: 0.9,
      themes: ['shared-life'],
      spanRefs: [],
      artifactRefs: [],
      provenanceRefs: [],
    });

    const chain = await buildEpisodicChainFromRoot(store, {
      episodeId: 'semantic-root',
      rootScore: 0.82,
      channelId: 'discord:current',
      trustLevel: 'regular',
      channelDisclosure: classifyChannelDisclosure('discord:current', { isDirectMessage: true }),
    });

    expect(chain).toEqual(expect.objectContaining({
      rootEpisodeId: 'semantic-root',
      episodes: [
        expect.objectContaining({ id: 'semantic-root' }),
        expect.objectContaining({ id: 'semantic-related' }),
      ],
      arcs: [expect.objectContaining({ id: arc.id })],
    }));
  });

  it('includes the latest episode before the rolled-out cutoff without lexical overlap', async () => {
    const store = makeStore();
    await createEpisode(store, {
      id: 'episode-older',
      title: 'An earlier ordinary evening',
      landmark: 'They made dinner and settled in together.',
      startedAt: '2026-06-06T18:00:00.000Z',
      endedAt: '2026-06-06T20:00:00.000Z',
    });
    await createEpisode(store, {
      id: 'episode-boundary',
      title: 'The evening before the live tail',
      landmark: 'They repaired the balcony planter and chose basil for it.',
      startedAt: '2026-06-08T18:00:00.000Z',
      endedAt: '2026-06-08T20:00:00.000Z',
    });
    await createEpisode(store, {
      id: 'episode-still-live',
      title: 'Inside the retained chat window',
      landmark: 'They discussed tomorrow morning.',
      startedAt: '2026-06-09T18:00:00.000Z',
      endedAt: '2026-06-09T20:00:00.000Z',
    });

    const chains = await retrieveEpisodicChains(store, {
      contextText: 'How are you feeling right now?',
      channelId: 'discord:current',
      trustLevel: 'regular',
      channelDisclosure: classifyChannelDisclosure('discord:current', { isDirectMessage: true }),
      canonicalContactId: 'contact:current',
      rolledOutSessionBoundary: {
        sessionId: 'session:current',
        beforeMs: Date.parse('2026-06-09T00:00:00.000Z'),
      },
      maxChains: 1,
    });

    expect(chains).toHaveLength(1);
    expect(chains[0].episodes).toEqual([
      expect.objectContaining({
        id: 'episode-boundary',
        landmark: 'They repaired the balcony planter and chose basil for it.',
      }),
    ]);
  });

  it('uses the existing chain cap and excludes episodes hidden from the turn', async () => {
    const store = makeStore();
    await createEpisode(store, {
      id: 'visible-latest',
      title: 'Visible latest',
      landmark: 'A visible current-channel summary.',
      startedAt: '2026-06-08T19:00:00.000Z',
      endedAt: '2026-06-08T20:00:00.000Z',
    });
    await createEpisode(store, {
      id: 'hidden-cross-channel',
      title: 'Hidden latest',
      landmark: 'This other-channel summary must stay hidden.',
      startedAt: '2026-06-08T21:00:00.000Z',
      endedAt: '2026-06-08T22:00:00.000Z',
      channelId: 'discord:other',
    });
    await createEpisode(store, {
      id: 'visible-older',
      title: 'Visible older',
      landmark: 'A second visible current-channel summary.',
      startedAt: '2026-06-08T17:00:00.000Z',
      endedAt: '2026-06-08T18:00:00.000Z',
    });

    const chains = await retrieveEpisodicChains(store, {
      contextText: 'A generic check-in',
      channelId: 'discord:current',
      trustLevel: 'regular',
      channelDisclosure: classifyChannelDisclosure('discord:current', { isDirectMessage: true }),
      rolledOutSessionBoundary: {
        sessionId: 'session:current',
        beforeMs: Date.parse('2026-06-09T00:00:00.000Z'),
      },
      maxChains: 2,
    });

    expect(chains).toHaveLength(2);
    expect(chains.flatMap(chain => chain.episodes.map(episode => episode.id)))
      .toEqual(['visible-latest', 'visible-older']);
  });

  it('fails closed when a rolled-out cutoff has no logical session binding', async () => {
    const store = makeStore();
    await createEpisode(store, {
      id: 'same-channel-other-session',
      title: 'A different logical session',
      landmark: 'This same-channel episode belongs to another session.',
      startedAt: '2026-06-08T19:00:00.000Z',
      endedAt: '2026-06-08T20:00:00.000Z',
      threadId: 'session:other',
    });

    await expect(retrieveEpisodicChains(store, {
      contextText: 'A generic check-in',
      channelId: 'discord:current',
      trustLevel: 'regular',
      channelDisclosure: classifyChannelDisclosure('discord:current', { isDirectMessage: true }),
      rolledOutSessionBoundary: {
        sessionId: '',
        beforeMs: Date.parse('2026-06-09T00:00:00.000Z'),
      },
    })).rejects.toThrow(/logical session/i);
  });

  it('reserves room under the cap for an explicitly referenced older episode', async () => {
    const store = makeStore();
    for (const [id, day] of [['recent-a', '08'], ['recent-b', '07'], ['recent-c', '06']] as const) {
      await createEpisode(store, {
        id,
        title: `Recent boundary episode ${id}`,
        landmark: `An ordinary recent evening ${id}.`,
        startedAt: `2026-06-${day}T18:00:00.000Z`,
        endedAt: `2026-06-${day}T20:00:00.000Z`,
      });
    }
    await createEpisode(store, {
      id: 'referenced-violin',
      title: 'Choosing the old violin',
      landmark: 'They chose a maple violin together after hearing its warm voice.',
      startedAt: '2026-06-01T18:00:00.000Z',
      endedAt: '2026-06-01T20:00:00.000Z',
    });
    await store.writeEpisodeArc({
      sourceEpisodeId: 'referenced-violin',
      targetEpisodeId: 'recent-c',
      arcKind: 'continuation',
      salience: 0.7,
      confidence: 0.8,
      themes: ['violin'],
      spanRefs: [],
      artifactRefs: [],
      provenanceRefs: [],
    });

    const chains = await retrieveEpisodicChains(store, {
      contextText: 'Do you remember why we chose the maple violin?',
      channelId: 'discord:current',
      trustLevel: 'regular',
      channelDisclosure: classifyChannelDisclosure('discord:current', { isDirectMessage: true }),
      rolledOutSessionBoundary: {
        sessionId: 'session:current',
        beforeMs: Date.parse('2026-06-09T00:00:00.000Z'),
      },
      maxChains: 3,
    });

    expect(chains).toHaveLength(3);
    expect(chains.flatMap(chain => chain.episodes.map(episode => episode.id)))
      .toContain('referenced-violin');
  });
});
