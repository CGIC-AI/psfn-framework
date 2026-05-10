import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionEntry } from '../../../core/session/types.js';
import { EpisodicStore } from './store.js';
import { EpisodicSynthesizer } from './synthesis.js';

describe('EpisodicSynthesizer', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function makeStore(): EpisodicStore {
    db = new Database(':memory:');
    return new EpisodicStore(db, {
      now: () => new Date('2026-04-02T08:00:00.000Z'),
    });
  }

  function entry(
    id: number,
    timestamp: string,
    role: SessionEntry['role'],
    content: string,
  ): SessionEntry {
    const turnId = `00000000-0000-7000-a000-${String(id).padStart(12, '0')}`;
    return {
      id,
      channelId: 'terminal:daily',
      role,
      content,
      authorId: role === 'user' ? 'contact:vega' : 'assistant:psfn',
      authorName: role === 'user' ? 'Vega' : 'PSFN',
      timestamp: Date.parse(timestamp),
      metadata: JSON.stringify({
        turn: {
          schemaVersion: 1,
          turnId,
          requestId: `request:${id}`,
          role,
        },
      }),
    };
  }

  it('creates multiple same-day episodes with L0 span provenance and graph links', () => {
    const store = makeStore();
    const sessionReader = {
      getRecentMessages: () => [
        entry(1, '2026-04-01T10:00:00.000Z', 'user', 'Please debug the atlas project scheduler tests.'),
        entry(2, '2026-04-01T10:02:00.000Z', 'assistant', 'I found the atlas project scheduler failure and will patch it.'),
        entry(3, '2026-04-01T12:00:00.000Z', 'user', 'Back to atlas project release planning and validation.'),
        entry(4, '2026-04-01T12:03:00.000Z', 'assistant', 'The atlas project release plan now needs lint and targeted tests.'),
      ],
    };
    const synthesizer = new EpisodicSynthesizer(store, sessionReader, {
      gapSplitMinutes: 45,
      transcriptMessageLimit: 12,
    });

    const result = synthesizer.run({
      sessionId: 'terminal:daily',
      sourceMessageId: 'turn:4',
    });

    expect(result.createdEpisodes).toHaveLength(2);
    expect(result.skippedEpisodeIds).toEqual([]);
    expect(result.linkedArcs).toHaveLength(1);
    expect(result.linkedArcs[0]).toMatchObject({
      sourceEpisodeId: result.createdEpisodes[0].id,
      targetEpisodeId: result.createdEpisodes[1].id,
      arcKind: 'same_theme',
    });

    const episodes = store.searchByTime({
      from: '2026-04-01T00:00:00.000Z',
      to: '2026-04-01T23:59:59.999Z',
    });
    expect(episodes).toHaveLength(2);
    expect(episodes[0].spanRefs[0]).toMatchObject({
      channelId: 'terminal:daily',
      sessionId: 'terminal:daily',
      startTurnId: '00000000-0000-7000-a000-000000000001',
      endTurnId: '00000000-0000-7000-a000-000000000002',
    });
    expect(episodes[0].provenanceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'l0_span', refId: episodes[0].spanRefs[0].spanId }),
      expect.objectContaining({ kind: 'session', refId: 'terminal:daily' }),
      expect.objectContaining({ kind: 'turn', refId: '00000000-0000-7000-a000-000000000001' }),
    ]));
  });

  it('is idempotent for repeated rest runs over the same spans', () => {
    const store = makeStore();
    const entries = [
      entry(1, '2026-04-01T10:00:00.000Z', 'user', 'Discuss project atlas testing and linting.'),
      entry(2, '2026-04-01T10:02:00.000Z', 'assistant', 'Project atlas testing and linting are ready to run.'),
    ];
    const synthesizer = new EpisodicSynthesizer(store, {
      getRecentMessages: () => entries,
    });

    const first = synthesizer.run({ sessionId: 'terminal:daily' });
    const second = synthesizer.run({ sessionId: 'terminal:daily' });

    expect(first.createdEpisodes).toHaveLength(1);
    expect(second.createdEpisodes).toEqual([]);
    expect(second.skippedEpisodeIds).toEqual([first.createdEpisodes[0].id]);
    expect(store.listEpisodes()).toHaveLength(1);
  });
});
