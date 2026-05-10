import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionEntry } from '../../../core/session/types.js';
import { runForcedEpisodicSynthesis } from '../../../app/maintenance/force-episodic-synthesis.js';
import { SessionStore } from '../../../persistence/sessions/store.js';
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

  it('synthesizes a month-long trip plan as linked bounded episodes instead of one aggregate memory', () => {
    const store = makeStore();
    const sessionReader = {
      getRecentMessages: () => [
        entry(
          101,
          '2026-04-01T09:00:00.000Z',
          'user',
          'Sicily trip planning kickoff: Palermo flights, flexible dates, and a month-long planning arc.',
        ),
        entry(
          102,
          '2026-04-01T09:03:00.000Z',
          'assistant',
          'I captured the Sicily trip kickoff and Palermo flight constraints as the first planning step.',
        ),
        entry(
          103,
          '2026-04-10T19:00:00.000Z',
          'user',
          'Sicily trip planning update: compare Palermo hotels and keep this linked to the earlier flight plan.',
        ),
        entry(
          104,
          '2026-04-10T19:04:00.000Z',
          'assistant',
          'The Sicily hotel decision stays connected to Palermo flights without merging the whole month.',
        ),
        entry(
          105,
          '2026-04-20T13:00:00.000Z',
          'user',
          'Sicily trip planning checkpoint: book train day trips from Palermo to Cefalu.',
        ),
        entry(
          106,
          '2026-04-20T13:05:00.000Z',
          'assistant',
          'I linked the Cefalu day-trip plan to the prior Sicily travel decisions.',
        ),
        entry(
          107,
          '2026-04-30T20:00:00.000Z',
          'user',
          'Sicily trip planning final pass: packing, airport timing, and what changed since Palermo flights.',
        ),
        entry(
          108,
          '2026-04-30T20:06:00.000Z',
          'assistant',
          'The final Sicily packing pass remains a separate waypoint with references back to the month arc.',
        ),
      ],
    };
    const synthesizer = new EpisodicSynthesizer(store, sessionReader, {
      gapSplitMinutes: 45,
      maxEpisodesPerRun: 10,
      transcriptMessageLimit: 20,
    });

    const result = synthesizer.run({
      sessionId: 'terminal:trip-month',
      sourceMessageId: 'turn:108',
    });

    expect(result.consideredEntries).toBe(8);
    expect(result.createdEpisodes).toHaveLength(4);
    expect(result.linkedArcs).toHaveLength(3);
    expect(result.linkedArcs.map(arc => arc.arcKind)).toEqual(['same_theme', 'same_theme', 'same_theme']);

    const episodes = store.searchByThread('terminal:trip-month', { limit: 10 });
    expect(episodes.map(episode => episode.startedAt.slice(0, 10))).toEqual([
      '2026-04-01',
      '2026-04-10',
      '2026-04-20',
      '2026-04-30',
    ]);
    expect(episodes.every(episode => episode.startedAt.slice(0, 10) === episode.endedAt.slice(0, 10)))
      .toBe(true);
    expect(episodes.every(episode => episode.spanRefs.length === 1)).toBe(true);
    expect(episodes.flatMap(episode => episode.spanRefs.map(ref => ref.startTurnId))).toEqual([
      '00000000-0000-7000-a000-000000000101',
      '00000000-0000-7000-a000-000000000103',
      '00000000-0000-7000-a000-000000000105',
      '00000000-0000-7000-a000-000000000107',
    ]);
    expect(episodes.some(episode => (
      episode.startedAt === '2026-04-01T09:00:00.000Z'
      && episode.endedAt === '2026-04-30T20:06:00.000Z'
    ))).toBe(false);
  });

  it('force-runs synthesis for isolated shakedown sessions without waiting for rest windows', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'episodic-force-synthesis-'));
    try {
      const companionDbPath = join(tempDir, 'companion.db');
      const sessionsDir = join(tempDir, 'sessions');
      const sessionStore = new SessionStore(sessionsDir);
      const sessionId = 'api:local-insecure:introspect-force';
      const startedAt = Date.parse('2026-04-06T10:00:00.000Z');

      [
        ['user', 'Please inspect the orbit garden shakedown provenance issue.'],
        ['assistant', 'I will inspect the orbit garden shakedown provenance issue.'],
        ['user', 'Continue the orbit garden shakedown thread and validate episodic arcs.'],
        ['assistant', 'The orbit garden shakedown thread now needs episode arc validation.'],
      ].forEach(([role, content], index) => {
        const id = index + 1;
        sessionStore.append({
          channelId: sessionId,
          role: role as SessionEntry['role'],
          content,
          authorId: role === 'user' ? 'contact:vega' : 'assistant:psfn',
          authorName: role === 'user' ? 'Vega' : 'PSFN',
          timestamp: startedAt + index * 60_000,
          metadata: JSON.stringify({
            turn: {
              schemaVersion: 1,
              turnId: `00000000-0000-7000-a000-${String(id).padStart(12, '0')}`,
              requestId: `request:${id}`,
              role,
            },
          }),
        });
      });

      const result = runForcedEpisodicSynthesis({
        companionDbPath,
        sessionsDir,
        sessionId,
        transcriptMessageLimit: 12,
        maxEntriesPerEpisode: 2,
        allowIsolatedRuntime: true,
      });

      expect(result.beforeEpisodeCount).toBe(0);
      expect(result.afterEpisodeCount).toBe(2);
      expect(result.createdEpisodes).toHaveLength(2);
      expect(result.linkedArcs).toHaveLength(1);
      expect(result.createdEpisodes[0]).toMatchObject({
        threadId: sessionId,
        channelId: sessionId,
      });
      expect(result.createdEpisodes[0].spanRefs[0]).toMatchObject({
        sessionId,
        startTurnId: '00000000-0000-7000-a000-000000000001',
      });
      expect(result.createdEpisodes[0].provenanceRefs).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'l0_span', refId: result.createdEpisodes[0].spanRefs[0].spanId }),
        expect.objectContaining({ kind: 'session', refId: sessionId }),
      ]));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
