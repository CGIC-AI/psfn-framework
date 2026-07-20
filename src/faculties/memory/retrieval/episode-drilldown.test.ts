import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { buildSessionMetadataWithTurn } from '../../../core/session/turn-provenance.js';
import type { SessionEntry } from '../../../core/session/types.js';
import type { TurnID } from '../../../shared/contracts/runtime.js';
import { FakeEpisodicPool } from '../../../test-support/fake-postgres-episodic-pool.js';
import { PostgresEpisodicStore } from '../episodic/postgres-store.js';
import type { EpisodeCreateInput } from '../episodic/store-port.js';
import {
  formatEpisodeDrilldown,
  retrieveEpisodeDrilldown,
} from './episode-drilldown.js';

const NOW = new Date('2026-07-18T12:00:00.000Z');
const CURRENT_CHANNEL = 'api:current-room';
const SESSION_ID = 'session:episode-drilldown';

function turnId(index: number): TurnID {
  return `00000000-0000-7000-a000-${index.toString().padStart(12, '0')}` as TurnID;
}

function entry(
  id: number,
  role: 'user' | 'assistant',
  content: string,
  turn: TurnID,
): SessionEntry {
  return {
    id,
    channelId: CURRENT_CHANNEL,
    role,
    content,
    timestamp: Date.UTC(2026, 6, 18, 10, id),
    authorName: role === 'user' ? 'Partner' : 'Companion',
    metadata: buildSessionMetadataWithTurn(undefined, {
      turnId: turn,
      requestId: `request-${id}`,
      role,
    }),
  };
}

function episode(
  id: string,
  startedAt: string,
  options: {
    channelId?: string;
    participantContactIds?: string[];
    span?: boolean;
  } = {},
): EpisodeCreateInput {
  const channelId = options.channelId ?? CURRENT_CHANNEL;
  return {
    id,
    title: `Episode ${id}`,
    landmark: `The remembered event for ${id}.`,
    startedAt,
    endedAt: startedAt,
    threadId: 'thread:shared-topic',
    channelId,
    participantContactIds: options.participantContactIds ?? ['contact:current'],
    salience: { score: 0.7 },
    affect: { labels: ['focused'] },
    themes: ['shared topic'],
    spanRefs: options.span === false
      ? []
      : [{
        spanId: `span-${id}`,
        channelId,
        sessionId: SESSION_ID,
        startTurnId: turnId(2),
        endTurnId: turnId(3),
      }],
    artifactRefs: options.span === false ? [{ artifactId: `artifact-${id}` }] : [],
    provenanceRefs: [],
  };
}

async function makeStore(): Promise<PostgresEpisodicStore> {
  const store = new PostgresEpisodicStore(
    new FakeEpisodicPool() as unknown as Pool,
    { now: () => NOW },
  );
  await store.createEpisode(episode('root', '2026-07-18T10:00:00.000Z'));
  await store.createEpisode(episode('arc-visible', '2026-07-18T10:05:00.000Z', { span: false }));
  await store.createEpisode(episode('arc-hidden', '2026-07-18T10:10:00.000Z', {
    channelId: 'api:protected-room',
    participantContactIds: ['contact:protected'],
    span: false,
  }));
  await store.createEpisode(episode('thread-visible', '2026-07-18T10:15:00.000Z', { span: false }));
  await store.createEpisode(episode('thread-hidden', '2026-07-18T10:20:00.000Z', {
    channelId: 'api:protected-room',
    participantContactIds: ['contact:protected'],
    span: false,
  }));
  await store.writeEpisodeArc({
    sourceEpisodeId: 'root',
    targetEpisodeId: 'arc-visible',
    arcKind: 'continuation',
    salience: 0.8,
    confidence: 0.9,
    themes: ['shared topic'],
    spanRefs: [],
    artifactRefs: [],
    provenanceRefs: [],
  });
  await store.writeEpisodeArc({
    sourceEpisodeId: 'root',
    targetEpisodeId: 'arc-hidden',
    arcKind: 'same_theme',
    salience: 0.8,
    confidence: 0.9,
    themes: ['shared topic'],
    spanRefs: [],
    artifactRefs: [],
    provenanceRefs: [],
  });
  return store;
}

describe('retrieveEpisodeDrilldown', () => {
  it('expands exact source turns and wires visible arc/thread siblings', async () => {
    const store = await makeStore();
    const listMemberships = vi.spyOn(store, 'listEpisodeArcsForEpisode');
    const getRecent = vi.fn(() => [
      entry(1, 'user', 'Before the episode.', turnId(1)),
      entry(2, 'user', 'The exact partner turn.', turnId(2)),
      entry(3, 'assistant', 'The exact companion turn.', turnId(3)),
      entry(4, 'assistant', 'After the episode.', turnId(4)),
    ]);

    const result = await retrieveEpisodeDrilldown(store, { getRecent }, {
      episodeId: 'root',
      channelId: CURRENT_CHANNEL,
      trustLevel: 'trusted',
      channelDisclosure: { channelPrivacy: 'private', broadcast: false },
      siblingLimit: 10,
    });

    expect(result).not.toBeNull();
    expect(getRecent).toHaveBeenCalledWith(SESSION_ID, Number.MAX_SAFE_INTEGER);
    expect(result?.spans[0].turns.map(turn => turn.content)).toEqual([
      'The exact partner turn.',
      'The exact companion turn.',
    ]);
    expect(result?.arcSiblings.map(sibling => sibling.episode.id)).toEqual(['arc-visible']);
    expect(result?.threadSiblings.map(sibling => sibling.id)).toEqual([
      'arc-visible',
      'thread-visible',
    ]);
    expect(listMemberships).toHaveBeenCalledWith('root', {
      direction: 'both',
      limit: 10,
    });

    const formatted = formatEpisodeDrilldown(result!);
    expect(formatted).toContain('The exact partner turn.');
    expect(formatted).toContain('continuation');
    expect(formatted).toContain('thread-visible');
    expect(formatted).not.toContain('arc-hidden');
    expect(formatted).not.toContain('thread-hidden');
  });

  it('returns the same null outcome for missing and inaccessible exact ids', async () => {
    const store = await makeStore();
    const getRecent = vi.fn(() => []);
    const access = {
      channelId: CURRENT_CHANNEL,
      trustLevel: 'known' as const,
      channelDisclosure: { channelPrivacy: 'private' as const, broadcast: false },
      siblingLimit: 10,
    };

    expect(await retrieveEpisodeDrilldown(store, { getRecent }, {
      ...access,
      episodeId: 'missing',
    })).toBeNull();
    expect(await retrieveEpisodeDrilldown(store, { getRecent }, {
      ...access,
      episodeId: 'arc-hidden',
    })).toBeNull();
    expect(getRecent).not.toHaveBeenCalled();
  });

  it('fails closed when a persisted span boundary cannot be resolved', async () => {
    const store = await makeStore();

    await expect(retrieveEpisodeDrilldown(store, {
      getRecent: () => [entry(2, 'user', 'Only one boundary.', turnId(2))],
    }, {
      episodeId: 'root',
      channelId: CURRENT_CHANNEL,
      trustLevel: 'trusted',
      channelDisclosure: { channelPrivacy: 'private', broadcast: false },
      siblingLimit: 10,
    })).rejects.toThrow(/turn boundaries are unavailable/);
  });
});
