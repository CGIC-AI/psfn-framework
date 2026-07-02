import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionEntry } from '../../../core/session/types.js';
import { runForcedEpisodicSynthesis } from '../../../app/maintenance/force-episodic-synthesis.js';
import { SessionStore } from '../../../persistence/sessions/store.js';
import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import { EpisodicStore } from './store.js';
import {
  EpisodicSynthesizer,
  sessionEntryClaimKey,
  type EpisodeSegmentationEvent,
} from './synthesis.js';

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
    metadataOverrides: Record<string, unknown> = {},
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
        ...metadataOverrides,
      }),
    };
  }

  it('creates multiple same-day episodes with L0 span provenance and graph links', async () => {
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

    const result = await synthesizer.run({
      sessionId: 'terminal:daily',
      sourceMessageId: 'turn:4',
    });

    expect(result.createdEpisodes).toHaveLength(2);
    expect(result.skippedEpisodeIds).toEqual([]);
    expect(result.linkedArcs).toHaveLength(1);
    expect(result.linkedArcs[0]).toMatchObject({
      sourceEpisodeId: result.createdEpisodes[0].id,
      targetEpisodeId: result.createdEpisodes[1].id,
      arcKind: 'continuation',
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

  it('is idempotent for repeated rest runs over the same spans', async () => {
    const store = makeStore();
    const entries = [
      entry(1, '2026-04-01T10:00:00.000Z', 'user', 'Discuss project atlas testing and linting.'),
      entry(2, '2026-04-01T10:02:00.000Z', 'assistant', 'Project atlas testing and linting are ready to run.'),
    ];
    const synthesizer = new EpisodicSynthesizer(store, {
      getRecentMessages: () => entries,
    });

    const first = await synthesizer.run({ sessionId: 'terminal:daily' });
    const second = await synthesizer.run({ sessionId: 'terminal:daily' });

    expect(first.createdEpisodes).toHaveLength(1);
    // The first run claimed both messages, so the second run drops them
    // before grouping and re-processes nothing at all.
    expect(second.claimedEntriesSkipped).toBe(2);
    expect(second.consideredEntries).toBe(0);
    expect(second.candidateEpisodeCount).toBe(0);
    expect(second.createdEpisodes).toEqual([]);
    expect(second.skippedEpisodeIds).toEqual([]);
    expect(store.listEpisodes()).toHaveLength(1);
    expect(store.listEpisodeMessageClaims({ status: 'active' }).map(claim => claim.claimKey).sort()).toEqual([
      'l0-message:terminal:daily:1',
      'l0-message:terminal:daily:2',
    ]);
  });

  it('extends an overlapping canonical episode when claims are absent (legacy defense in depth)', async () => {
    const store = makeStore();
    let entries = [
      entry(1, '2026-04-01T10:00:00.000Z', 'user', 'Discuss project atlas testing and linting.'),
      entry(2, '2026-04-01T10:02:00.000Z', 'assistant', 'Project atlas testing and linting are ready to run.'),
    ];
    const synthesizer = new EpisodicSynthesizer(store, {
      getRecentMessages: () => entries,
    });

    const first = await synthesizer.run({ sessionId: 'terminal:daily' });
    // Simulate a pre-claiming database: the overlap-merge heuristic must
    // still stop sliding-window duplicates when no claims exist.
    db?.exec('DELETE FROM l01_episode_message_claims');
    entries = [
      ...entries,
      entry(3, '2026-04-01T10:04:00.000Z', 'user', 'Project atlas linting should include the boundary regression test.'),
    ];
    const second = await synthesizer.run({
      sessionId: 'terminal:daily',
      sourceMessageId: 'session-entry:3',
    });

    expect(first.createdEpisodes).toHaveLength(1);
    expect(second.createdEpisodes).toEqual([]);
    expect(second.skippedEpisodeIds).toEqual([first.createdEpisodes[0].id]);

    const episodes = store.listEpisodes();
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      id: first.createdEpisodes[0].id,
      startedAt: '2026-04-01T10:00:00.000Z',
      endedAt: '2026-04-01T10:04:00.000Z',
    });
    expect(episodes[0].spanRefs).toHaveLength(2);
    expect(episodes[0].provenanceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'l0_span', refId: episodes[0].spanRefs[0].spanId }),
      expect.objectContaining({ kind: 'l0_span', refId: episodes[0].spanRefs[1].spanId }),
      expect.objectContaining({ kind: 'turn', refId: '00000000-0000-7000-a000-000000000003' }),
    ]));

    expect(synthesizer.getProcessingWatermark({
      sessionId: 'terminal:daily',
      threadId: 'terminal:daily',
      channelId: 'terminal:daily',
    })).toMatchObject({
      highWaterTurnId: '00000000-0000-7000-a000-000000000003',
      highWaterMessageId: 'session-entry:3',
      processedStartedAt: '2026-04-01T10:00:00.000Z',
      processedEndedAt: '2026-04-01T10:04:00.000Z',
      canonicalEpisodeIds: [first.createdEpisodes[0].id],
      skippedEpisodeIds: [first.createdEpisodes[0].id],
    });

    const decisions = store.listEpisodeCandidateDecisions({ canonicalEpisodeId: first.createdEpisodes[0].id });
    expect(decisions).toHaveLength(2);
    expect(decisions.map(decision => decision.status).sort()).toEqual(['canonical', 'merged']);
    const mergedDecision = decisions.find(decision => decision.status === 'merged');
    expect(mergedDecision).toMatchObject({
      canonicalEpisodeId: first.createdEpisodes[0].id,
      mergedIntoEpisodeId: first.createdEpisodes[0].id,
      sourceWatermarkId: expect.any(String),
      reason: 'candidate span deterministically overlapped an active canonical episode',
      candidateJson: {
        decision: {
          action: 'extend',
          canonicalEpisodeId: first.createdEpisodes[0].id,
        },
      },
    });
    const durableWatermark = store.getProcessingWatermark({
      processor: 'episodic_synthesis',
      sourceRef: 'terminal:daily',
      sessionId: 'terminal:daily',
      threadId: 'terminal:daily',
      channelId: 'terminal:daily',
    });
    expect(durableWatermark).toMatchObject({
      highWaterTurnId: '00000000-0000-7000-a000-000000000003',
      highWaterMessageId: 'session-entry:3',
      reconciliationStatus: 'clean',
      artifactsJson: {
        candidateDecisionIds: expect.arrayContaining(decisions.map(decision => decision.id)),
      },
    });
    const diagnostics = store.getMaintenanceDiagnostics({ now: '2026-04-01T10:10:00.000Z' });
    expect(diagnostics).toMatchObject({
      candidateDecisionCount: 2,
      decisionCountsByStatus: { canonical: 1, merged: 1 },
      duplicateCandidateCount: 1,
      duplicateEpisodeRate: 0.5,
      mergeDecisionCount: 1,
      watermarkCount: 1,
      pendingWatermarkCount: 1,
      averageProcessingLatencyMs: 0,
      latestProcessedAt: '2026-04-01T10:04:00.000Z',
    });
    expect(diagnostics.oldestQueueAgeMs).toBe(6 * 60 * 1000);

    // The merged pass re-established claims on the canonical episode.
    const activeClaims = store.listEpisodeMessageClaims({ status: 'active' });
    expect(activeClaims.every(claim => claim.episodeId === first.createdEpisodes[0].id)).toBe(true);
    expect(activeClaims.map(claim => claim.claimKey).sort()).toEqual([
      'l0-message:terminal:daily:1',
      'l0-message:terminal:daily:2',
      'l0-message:terminal:daily:3',
    ]);
  });

  it('classifies richer arc kinds from canonical episode evidence', async () => {
    const cases = [
      {
        expected: 'causal',
        target: 'Atlas project continued because scheduler flakes blocked validation.',
      },
      {
        expected: 'resolution',
        target: 'Atlas project issue resolved after the scheduler fix shipped.',
      },
      {
        expected: 'contrast',
        target: 'Atlas project validation changed and no longer uses smoke-only checks.',
      },
      {
        expected: 'recurrence',
        target: 'Atlas project same issue returned again during routine validation.',
      },
      {
        expected: 'operator_defined',
        target: 'Atlas project validation needs a maintainer-defined checkpoint.',
        metadataOverrides: { operatorNoteId: 'operator-note-1' },
      },
    ] as const;

    for (const testCase of cases) {
      const store = makeStore();
      try {
        const sessionReader = {
          getRecentMessages: () => [
            entry(10, '2026-04-01T10:00:00.000Z', 'user', 'Atlas project baseline validation plan.'),
            entry(11, '2026-04-01T10:02:00.000Z', 'assistant', 'Atlas project baseline validation is captured.'),
            entry(
              12,
              '2026-04-01T12:00:00.000Z',
              'user',
              testCase.target,
              testCase.metadataOverrides ?? {},
            ),
            entry(
              13,
              '2026-04-01T12:02:00.000Z',
              'assistant',
              `Captured follow-up for ${testCase.target}`,
              testCase.metadataOverrides ?? {},
            ),
          ],
        };
        const synthesizer = new EpisodicSynthesizer(store, sessionReader, {
          gapSplitMinutes: 45,
          transcriptMessageLimit: 12,
        });

        const result = await synthesizer.run({
          sessionId: `terminal:arc-kind:${testCase.expected}`,
          sourceMessageId: `source:${testCase.expected}`,
        });

        expect(result.createdEpisodes).toHaveLength(2);
        expect(result.linkedArcs).toHaveLength(1);
        expect(result.linkedArcs[0]).toMatchObject({
          sourceEpisodeId: result.createdEpisodes[0].id,
          targetEpisodeId: result.createdEpisodes[1].id,
          arcKind: testCase.expected,
        });
        if (testCase.expected === 'operator_defined') {
          expect(result.createdEpisodes[1].provenanceRefs).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'operator_note', refId: 'operator-note-1' }),
          ]));
        }
      } finally {
        db?.close();
        db = undefined;
      }
    }
  });

  it('never re-covers claimed turns when a rest boundary shifts; the unclaimed tail is held back', async () => {
    const store = makeStore();
    let entries = [
      entry(1, '2026-04-01T10:00:00.000Z', 'user', 'Review atlas planner test failures and lint output.'),
      entry(2, '2026-04-01T10:02:00.000Z', 'assistant', 'Atlas planner tests and lint output are in the same investigation.'),
    ];
    const synthesizer = new EpisodicSynthesizer(store, {
      getRecentMessages: () => entries,
    });

    const first = await synthesizer.run({ sessionId: 'terminal:daily' });
    entries = [
      entry(2, '2026-04-01T10:02:00.000Z', 'assistant', 'Atlas planner tests and lint output are in the same investigation.'),
      entry(3, '2026-04-01T10:04:00.000Z', 'user', 'Keep the atlas planner lint regression tied to this investigation.'),
    ];
    const second = await synthesizer.run({ sessionId: 'terminal:daily' });

    expect(first.createdEpisodes).toHaveLength(1);
    // The claimed turn is dropped from the window; the lone unclaimed tail
    // entry is not yet salient on its own, so nothing is re-processed.
    expect(second.claimedEntriesSkipped).toBe(1);
    expect(second.createdEpisodes).toEqual([]);
    expect(second.skippedEpisodeIds).toEqual([]);

    const episodes = store.searchByThread('terminal:daily');
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      id: first.createdEpisodes[0].id,
      startedAt: '2026-04-01T10:00:00.000Z',
      endedAt: '2026-04-01T10:02:00.000Z',
    });
    // The tail entry remains unclaimed and available for a later pass.
    expect(store.listEpisodeMessageClaims({
      claimKeys: ['l0-message:terminal:daily:3'],
    })).toEqual([]);
  });

  it('skips claimed turns on a second pass instead of producing a partially overlapping episode (16:51/16:52 regression)', async () => {
    const store = makeStore();
    // First pass: seven messages from 16:45 to 16:51 become one episode.
    let entries = [
      entry(1, '2026-04-01T16:45:00.000Z', 'user', 'Garden irrigation valve calibration for the raised beds needs a schedule.'),
      entry(2, '2026-04-01T16:46:00.000Z', 'assistant', 'Irrigation valve calibration schedule drafted for the raised beds.'),
      entry(3, '2026-04-01T16:47:00.000Z', 'user', 'Include the drip line pressure readings in the calibration.'),
      entry(4, '2026-04-01T16:48:00.000Z', 'assistant', 'Drip line pressure readings folded into the calibration plan.'),
      entry(5, '2026-04-01T16:49:00.000Z', 'user', 'Also check the rain sensor bypass wiring before calibration.'),
      entry(6, '2026-04-01T16:50:00.000Z', 'assistant', 'Rain sensor bypass wiring check added ahead of calibration.'),
      entry(7, '2026-04-01T16:51:00.000Z', 'user', 'Great, lock in the irrigation calibration plan as discussed.'),
    ];
    const synthesizer = new EpisodicSynthesizer(store, {
      getRecentMessages: () => entries,
    });

    const first = await synthesizer.run({ sessionId: 'terminal:daily' });
    expect(first.createdEpisodes).toHaveLength(1);
    const firstEpisode = first.createdEpisodes[0];
    expect(firstEpisode.startedAt).toBe('2026-04-01T16:45:00.000Z');
    expect(firstEpisode.endedAt).toBe('2026-04-01T16:51:00.000Z');

    // One minute later a second pass re-scans a window that partially
    // overlaps the first episode plus two new messages on an unrelated
    // topic, so the theme-gated overlap-merge heuristic would not fire and
    // the old behavior produced a second episode re-covering 16:45-16:51.
    entries = [
      ...entries,
      entry(8, '2026-04-01T16:52:00.000Z', 'user', 'Switching topics: birthday cake flavors for the weekend party?'),
      entry(9, '2026-04-01T16:52:30.000Z', 'assistant', 'Chocolate hazelnut and lemon curd both work for the weekend party.'),
    ];
    const second = await synthesizer.run({ sessionId: 'terminal:daily' });

    expect(second.claimedEntriesSkipped).toBe(7);
    expect(second.consideredEntries).toBe(2);
    expect(second.createdEpisodes).toHaveLength(1);
    const secondEpisode = second.createdEpisodes[0];
    expect(secondEpisode.startedAt).toBe('2026-04-01T16:52:00.000Z');
    expect(secondEpisode.endedAt).toBe('2026-04-01T16:52:30.000Z');

    // No live episode overlaps another live episode's claimed messages.
    const firstClaims = store.listEpisodeMessageClaims({ episodeId: firstEpisode.id, status: 'active' });
    const secondClaims = store.listEpisodeMessageClaims({ episodeId: secondEpisode.id, status: 'active' });
    expect(firstClaims.map(claim => claim.claimKey).sort()).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map(id => `l0-message:terminal:daily:${id}`),
    );
    expect(secondClaims.map(claim => claim.claimKey).sort()).toEqual([
      'l0-message:terminal:daily:8',
      'l0-message:terminal:daily:9',
    ]);

    // DB-level invariant: no source message is actively claimed twice.
    const duplicates = db?.prepare(`
      SELECT claim_key
      FROM l01_episode_message_claims
      WHERE status = 'active'
      GROUP BY claim_key
      HAVING COUNT(*) > 1
    `).all();
    expect(duplicates).toEqual([]);
  });

  it('synthesizes a month-long trip plan as linked bounded episodes instead of one aggregate memory', async () => {
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

    const result = await synthesizer.run({
      sessionId: 'terminal:trip-month',
      sourceMessageId: 'turn:108',
    });

    expect(result.consideredEntries).toBe(8);
    expect(result.createdEpisodes).toHaveLength(4);
    expect(result.linkedArcs).toHaveLength(3);
    expect(result.linkedArcs.map(arc => arc.arcKind)).toEqual(['continuation', 'continuation', 'continuation']);

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

  it('force-runs synthesis for isolated shakedown sessions without waiting for rest windows', async () => {
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

      const result = await runForcedEpisodicSynthesis({
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

describe('EpisodicSynthesizer contextual topic cutting (E5.4)', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  const SESSION_ID = 'terminal:daily';
  const WATERMARK_SCOPE = {
    processor: 'episodic_synthesis',
    sourceRef: SESSION_ID,
    channelId: SESSION_ID,
    threadId: SESSION_ID,
    sessionId: SESSION_ID,
  };

  function makeStore(): EpisodicStore {
    db = new Database(':memory:');
    return new EpisodicStore(db, {
      now: () => new Date('2026-04-02T08:00:00.000Z'),
    });
  }

  function entryTimestamp(id: number): string {
    return new Date(Date.parse('2026-04-01T10:00:00.000Z') + (id - 1) * 120_000).toISOString();
  }

  function turnId(id: number): string {
    return `00000000-0000-7000-a000-${String(id).padStart(12, '0')}`;
  }

  function entry(id: number, role: SessionEntry['role'], content: string): SessionEntry {
    return {
      id,
      channelId: SESSION_ID,
      role,
      content,
      authorId: role === 'user' ? 'contact:vega' : 'assistant:psfn',
      authorName: role === 'user' ? 'Vega' : 'PSFN',
      timestamp: Date.parse(entryTimestamp(id)),
      metadata: JSON.stringify({
        turn: {
          schemaVersion: 1,
          turnId: turnId(id),
          requestId: `request:${id}`,
          role,
        },
      }),
    };
  }

  /** Eight turns on topic A followed by two turns opening topic B. */
  function eightPlusTwoEntries(): SessionEntry[] {
    const topicA = [
      'Please debug the atlas project scheduler tests.',
      'I found the atlas scheduler failure and will patch the retry loop.',
      'Does the atlas patch also cover the watchdog timer?',
      'Yes, the atlas watchdog timer now resets after each retry.',
      'Run the atlas scheduler suite again with the patch applied.',
      'The atlas scheduler suite is green after the retry patch.',
      'Great, prepare the atlas patch summary for review.',
      'The atlas patch summary is drafted and ready for review.',
    ];
    const topicB = [
      'Different question: what should we cook for dinner tonight?',
      'Maybe pasta with roasted tomatoes — do we have basil left?',
    ];
    return [
      ...topicA.map((content, index) => entry(index + 1, index % 2 === 0 ? 'user' : 'assistant', content)),
      ...topicB.map((content, index) => entry(index + 9, index % 2 === 0 ? 'user' : 'assistant', content)),
    ];
  }

  function segmentsJson(segments: Array<Record<string, unknown>>): string {
    return JSON.stringify({ segments });
  }

  function queuedSegmentationProvider(
    responses: string[],
  ): Pick<LLMProviderPort, 'complete'> & { callCount: () => number } {
    let calls = 0;
    return {
      callCount: () => calls,
      complete: async () => {
        calls += 1;
        const next = responses.shift();
        if (next === undefined) {
          throw new Error('unexpected extra segmentation call');
        }
        return {
          content: next,
          toolCalls: [],
          model: 'test-model',
          inputTokens: 0,
          outputTokens: 0,
          stopReason: 'stop',
        };
      },
    };
  }

  it('holds back the unfinished trailing topic: 8+2 yields one topic-A episode, 2 turns unclaimed', async () => {
    const store = makeStore();
    const entries = eightPlusTwoEntries();
    const provider = queuedSegmentationProvider([
      segmentsJson([
        { start_index: 0, end_index: 7, topic: 'atlas scheduler debugging', status: 'closed' },
        { start_index: 8, end_index: 9, topic: 'dinner planning', status: 'open' },
      ]),
    ]);
    const events: EpisodeSegmentationEvent[] = [];
    const synthesizer = new EpisodicSynthesizer(store, { getRecentMessages: () => entries }, {
      topicSegmentation: {
        enabled: true,
        llmProvider: provider,
        onEvent: event => events.push(event),
        now: () => 1_000,
      },
    });

    const result = await synthesizer.run({ sessionId: SESSION_ID, sourceMessageId: 'turn:10' });

    expect(result.createdEpisodes).toHaveLength(1);
    expect(result.candidateEpisodeCount).toBe(1);
    expect(result.heldBackEntryCount).toBe(2);
    expect(result.segmentationFailedChunkCount).toBe(0);
    expect(result.createdEpisodes[0].spanRefs[0]).toMatchObject({
      startTurnId: turnId(1),
      endTurnId: turnId(8),
    });

    // Only the eight topic-A turns are claimed; the held B turns stay free.
    const claims = store.listEpisodeMessageClaims({ status: 'active' });
    expect(claims.map(claim => claim.claimKey).sort()).toEqual(
      entries.slice(0, 8).map(sessionEntryClaimKey).sort(),
    );

    // Watermark stays behind the held turns so the next pass still sees them.
    const watermark = store.getProcessingWatermark(WATERMARK_SCOPE);
    expect(watermark?.processedEndedAt).toBe(entryTimestamp(8));

    expect(events).toEqual([
      expect.objectContaining({
        outcome: 'segmented',
        segmentCount: 2,
        chunkEntryCount: 10,
        heldBackEntryCount: 2,
        timestamp: 1_000,
      }),
    ]);
    expect(provider.callCount()).toBe(1);
  });

  it('claims held turns when the next pass processes the continued topic', async () => {
    const store = makeStore();
    const firstPass = eightPlusTwoEntries();
    const continuation = [
      ...firstPass,
      entry(11, 'user', 'Basil is in the fridge; pasta with roasted tomatoes it is.'),
      entry(12, 'assistant', 'Pasta plan settled — roasting the tomatoes at seven.'),
    ];
    let current = firstPass;
    const provider = queuedSegmentationProvider([
      segmentsJson([
        { start_index: 0, end_index: 7, topic: 'atlas scheduler debugging', status: 'closed' },
        { start_index: 8, end_index: 9, topic: 'dinner planning', status: 'open' },
      ]),
      segmentsJson([
        { start_index: 0, end_index: 3, topic: 'dinner planning', status: 'closed' },
      ]),
    ]);
    const synthesizer = new EpisodicSynthesizer(store, { getRecentMessages: () => current }, {
      topicSegmentation: { enabled: true, llmProvider: provider },
    });

    const first = await synthesizer.run({ sessionId: SESSION_ID });
    expect(first.heldBackEntryCount).toBe(2);

    current = continuation;
    const second = await synthesizer.run({ sessionId: SESSION_ID });

    // Claimed topic-A turns are dropped up front; the held B turns join the
    // continuation and become one dinner-planning episode.
    expect(second.claimedEntriesSkipped).toBe(8);
    expect(second.createdEpisodes).toHaveLength(1);
    expect(second.heldBackEntryCount).toBe(0);
    expect(second.createdEpisodes[0].spanRefs[0]).toMatchObject({
      startTurnId: turnId(9),
      endTurnId: turnId(12),
    });

    const claims = store.listEpisodeMessageClaims({ status: 'active' });
    expect(claims).toHaveLength(12);
    const episodeByClaimKey = new Map(claims.map(claim => [claim.claimKey, claim.episodeId]));
    expect(episodeByClaimKey.get(sessionEntryClaimKey(firstPass[8]))).toBe(second.createdEpisodes[0].id);
    expect(episodeByClaimKey.get(sessionEntryClaimKey(firstPass[9]))).toBe(second.createdEpisodes[0].id);
  });

  it('fails closed on malformed segmentation output: nothing written, nothing claimed, watermark untouched', async () => {
    const store = makeStore();
    const entries = eightPlusTwoEntries();
    const events: EpisodeSegmentationEvent[] = [];
    const provider = queuedSegmentationProvider([
      'Topic A covers debugging and then the conversation moves to dinner planning.',
    ]);
    const synthesizer = new EpisodicSynthesizer(store, { getRecentMessages: () => entries }, {
      topicSegmentation: {
        enabled: true,
        llmProvider: provider,
        onEvent: event => events.push(event),
      },
    });

    const result = await synthesizer.run({ sessionId: SESSION_ID });

    expect(result.createdEpisodes).toHaveLength(0);
    expect(result.candidateEpisodeCount).toBe(0);
    expect(result.segmentationFailedChunkCount).toBe(1);
    expect(result.heldBackEntryCount).toBe(0);
    expect(store.listEpisodeMessageClaims({ status: 'active' })).toHaveLength(0);
    expect(store.getProcessingWatermark(WATERMARK_SCOPE)).toBeUndefined();
    expect(events).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        chunkEntryCount: 10,
        error: expect.stringContaining('JSON'),
      }),
    ]);
  });

  it('caps materialized episodes per run; uncapped segments stay unclaimed for the next pass', async () => {
    const store = makeStore();
    const entries = eightPlusTwoEntries();
    const provider = queuedSegmentationProvider([
      segmentsJson([
        { start_index: 0, end_index: 7, topic: 'atlas scheduler debugging', status: 'closed' },
        { start_index: 8, end_index: 9, topic: 'dinner planning', status: 'closed' },
      ]),
    ]);
    const synthesizer = new EpisodicSynthesizer(store, { getRecentMessages: () => entries }, {
      maxEpisodesPerRun: 1,
      topicSegmentation: { enabled: true, llmProvider: provider },
    });

    const result = await synthesizer.run({ sessionId: SESSION_ID });

    expect(result.createdEpisodes).toHaveLength(1);
    expect(result.candidateEpisodeCount).toBe(1);
    const claims = store.listEpisodeMessageClaims({ status: 'active' });
    expect(claims.map(claim => claim.claimKey).sort()).toEqual(
      entries.slice(0, 8).map(sessionEntryClaimKey).sort(),
    );
    const watermark = store.getProcessingWatermark(WATERMARK_SCOPE);
    expect(watermark?.processedEndedAt).toBe(entryTimestamp(8));
  });

  it('never calls the provider when segmentation is disabled (deterministic regression)', async () => {
    const store = makeStore();
    const entries = eightPlusTwoEntries();
    const provider = queuedSegmentationProvider([]);
    const synthesizer = new EpisodicSynthesizer(store, { getRecentMessages: () => entries }, {
      topicSegmentation: { enabled: false, llmProvider: provider },
    });

    const result = await synthesizer.run({ sessionId: SESSION_ID });

    expect(provider.callCount()).toBe(0);
    expect(result.createdEpisodes).toHaveLength(1);
    expect(result.heldBackEntryCount).toBe(0);
    expect(result.segmentationFailedChunkCount).toBe(0);
    // Deterministic cutting keeps the whole 10-turn chunk as one episode.
    expect(store.listEpisodeMessageClaims({ status: 'active' })).toHaveLength(10);
  });

  it('fails closed at construction when segmentation is enabled without a provider', () => {
    const store = makeStore();
    expect(() => new EpisodicSynthesizer(store, { getRecentMessages: () => [] }, {
      topicSegmentation: { enabled: true },
    })).toThrow('no LLM provider');
  });
});
