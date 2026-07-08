import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { EpisodicStore } from '../episodic/store.js';
import {
  type EpisodeCreateInput,
} from '../episodic/store-port.js';
import { listEpisodeArcMemberships } from './episodic.js';

const NOW = new Date('2026-06-10T08:00:00.000Z');

describe('listEpisodeArcMemberships', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function makeStore(): EpisodicStore {
    db = new Database(':memory:');
    let sequence = 0;
    return new EpisodicStore(db, {
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
    await store.createEpisode(episode('monday', '2026-06-01T20:00:00.000Z', '2026-06-01T21:00:00.000Z'));
    await store.createEpisode(episode('wednesday', '2026-06-03T20:00:00.000Z', '2026-06-03T21:00:00.000Z'));
    await store.createEpisode(episode('friday', '2026-06-05T20:00:00.000Z', '2026-06-05T21:00:00.000Z'));
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
    await store.createEpisode(episode('a', '2026-06-01T20:00:00.000Z', '2026-06-01T21:00:00.000Z'));
    await store.createEpisode(episode('b', '2026-06-03T20:00:00.000Z', '2026-06-03T21:00:00.000Z'));
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
    const unlinked = await store.createEpisode(episode('c', '2026-06-05T20:00:00.000Z', '2026-06-05T21:00:00.000Z'));
    expect(await listEpisodeArcMemberships(store, unlinked.id)).toEqual([]);
  });

  it('keeps arcs reachable from the consolidated episode after supersession', async () => {
    const store = makeStore();
    await store.createEpisode(episode('canon', '2026-06-01T20:00:00.000Z', '2026-06-01T21:00:00.000Z'));
    await store.createEpisode(episode('candidate', '2026-06-03T20:00:00.000Z', '2026-06-03T21:00:00.000Z'));
    await store.createEpisode(episode('consolidated', '2026-06-03T19:00:00.000Z', '2026-06-03T22:00:00.000Z'));
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
    await store.createEpisode(episode('a', '2026-06-01T20:00:00.000Z', '2026-06-01T21:00:00.000Z'));
    await store.createEpisode(episode('b', '2026-06-03T20:00:00.000Z', '2026-06-03T21:00:00.000Z'));
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
