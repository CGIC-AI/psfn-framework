import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { SessionEntry } from '../../../core/session/types.js';
import { createPostgresPool } from '../../../persistence/postgres.js';
import { createDefaultPostgresSessionAdapters } from '../../../persistence/sessions/postgres-adapters.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import type { EpisodeSynthesisLaneConfig } from '../../../system/config/scheduler-config.js';
import { EpisodeSynthesisLane, type EpisodeSynthesisSessionFailureEvent } from './synthesis-lane.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const SESSION_ID = 'api:episode-restart';
const BACKOFF_BASE_MINUTES = 30;
const MINUTE_MS = 60_000;
const tempDirs: string[] = [];
let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  await harness?.stop();
}, INTEGRATION_TIMEOUT_MS);

function newSessionsDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function gateConfig(maxAttempts = 5): EpisodeSynthesisLaneConfig {
  return {
    daytimeSlots: ['09:00', '12:00', '15:00', '18:00'],
    timezone: 'local',
    turnThreshold: 24,
    minRelevantTurns: 1,
    transcriptMessageLimit: 96,
    maxEpisodesPerRun: 6,
    gapSplitMinutes: 45,
    maxEntriesPerEpisode: 14,
    minConversationalEntries: 1,
    minSingleEntryChars: 1,
    topicSegmentationEnabled: true,
    maxPriorCandidates: 4,
    sessionFailure: { maxAttempts, retryBaseDelayMinutes: BACKOFF_BASE_MINUTES },
  };
}

function timerAction() {
  return {
    id: 'episode-restart-action',
    channelId: SESSION_ID,
    sourceMessageId: 'episode-restart-message',
    payload: { trigger: 'timer' },
  };
}

function synthesisResult() {
  return {
    consideredEntries: 1,
    candidateEpisodeCount: 1,
    createdEpisodes: [],
    skippedEpisodeIds: [],
    linkedArcs: [],
  };
}

type SessionAdapters = Awaited<ReturnType<typeof createDefaultPostgresSessionAdapters>>;

/**
 * Real transcript projection writes drive the real conversational-activity
 * workset; the lane reads the same entries back through this session reader.
 */
class TranscriptFixture {
  private readonly entriesBySession = new Map<string, SessionEntry[]>();
  private nextId = 1;

  constructor(private readonly adapters: SessionAdapters) {}

  async append(sessionId: string, content: string): Promise<void> {
    const entry: SessionEntry = {
      id: this.nextId,
      channelId: sessionId,
      role: 'user',
      content,
      timestamp: this.nextId * 1_000,
    };
    this.nextId += 1;
    this.adapters.transcriptProjection.upsertSessionEntry(entry);
    await this.adapters.transcriptProjection.flushPendingWrites?.();
    this.entriesBySession.set(sessionId, [...(this.entriesBySession.get(sessionId) ?? []), entry]);
  }

  sessionManager() {
    return {
      resolveSessionChannelId: (channelId: string) => channelId,
      getRecentMessages: (sessionId: string) => this.entriesBySession.get(sessionId) ?? [],
    };
  }
}

async function withDatabase(
  run: (context: { pool: Pool; adapters: SessionAdapters; transcript: TranscriptFixture }) => Promise<void>,
): Promise<void> {
  if (!harness) throw new Error('Postgres test harness is unavailable');
  const database = await harness.createDatabase();
  const pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'psfn-episode-failure-handling',
    allowExitOnIdle: true,
    max: 3,
  });
  try {
    const adapters = await createDefaultPostgresSessionAdapters(database.databaseUrl, {
      sessionsDir: newSessionsDir('psfn-episode-failure-'),
      pool,
    });
    await run({ pool, adapters, transcript: new TranscriptFixture(adapters) });
  } finally {
    await pool.end();
  }
}

describe('EpisodeSynthesisLane failure handling (real Postgres)', () => {
  it('records a failed claim, survives a process restart, and checkpoints it once the backoff elapses', async () => {
    if (!harness) throw new Error('Postgres test harness is unavailable');
    const database = await harness.createDatabase();
    let firstPool: Pool | null = createPostgresPool(database.databaseUrl, {
      applicationName: 'psfn-episode-restart-first',
      allowExitOnIdle: true,
      max: 3,
    });
    let restartPool: ReturnType<typeof createPostgresPool> | null = null;
    const clock = { now: Date.now() };

    try {
      const firstAdapters = await createDefaultPostgresSessionAdapters(database.databaseUrl, {
        sessionsDir: newSessionsDir('psfn-episode-restart-first-'),
        pool: firstPool,
      });
      const transcript = new TranscriptFixture(firstAdapters);
      await transcript.append(SESSION_ID, 'A genuine conversation that needs an episode after restart.');

      const providerFailure = new Error('Episode synthesis provider call failed', {
        cause: new Error('upstream returned 503'),
      });
      const failingSynthesizer = { run: vi.fn().mockRejectedValue(providerFailure) };
      const firstLane = new EpisodeSynthesisLane({
        sessionManager: transcript.sessionManager(),
        synthesizer: failingSynthesizer,
        watermarkStore: { getProcessingWatermark: vi.fn(async () => undefined) },
        workset: firstAdapters.conversationalActivityWorkset,
        config: gateConfig(),
        now: () => clock.now,
      });
      // A recorded failure no longer fails the drain (no post-turn retry storm).
      await expect(firstLane.execute(timerAction())).resolves.toEqual({ outcome: 'complete' });
      const [held] = await firstAdapters.conversationalActivityWorkset.enumerate('episodic_synthesis');
      expect(held).toMatchObject({
        logicalSessionId: SESSION_ID,
        claimantId: 'episode-synthesis-drain',
        checkpointRevision: 0,
        failureCount: 1,
        retryAfterMs: clock.now + BACKOFF_BASE_MINUTES * MINUTE_MS,
        lastFailure: {
          stage: 'episode_synthesis',
          // The durable record keeps the root cause, not just the wrapper.
          message: 'Episode synthesis provider call failed <- caused by: upstream returned 503',
        },
      });

      await firstPool.end();
      firstPool = null;
      restartPool = createPostgresPool(database.databaseUrl, {
        applicationName: 'psfn-episode-restart-second',
        allowExitOnIdle: true,
        max: 3,
      });
      const restartedAdapters = await createDefaultPostgresSessionAdapters(database.databaseUrl, {
        sessionsDir: newSessionsDir('psfn-episode-restart-second-'),
        pool: restartPool,
      });
      const restartedSynthesizer = { run: vi.fn().mockResolvedValue(synthesisResult()) };
      const restartedLane = new EpisodeSynthesisLane({
        sessionManager: transcript.sessionManager(),
        synthesizer: restartedSynthesizer,
        watermarkStore: { getProcessingWatermark: vi.fn(async () => undefined) },
        workset: restartedAdapters.conversationalActivityWorkset,
        config: gateConfig(),
        now: () => clock.now,
      });

      // Inside the backoff window the held claim is not retried.
      await restartedLane.execute(timerAction());
      expect(restartedSynthesizer.run).not.toHaveBeenCalled();

      clock.now += BACKOFF_BASE_MINUTES * MINUTE_MS;
      await restartedLane.execute(timerAction());

      expect(restartedSynthesizer.run).toHaveBeenCalledOnce();
      await expect(restartedAdapters.conversationalActivityWorkset.enumerate('episodic_synthesis'))
        .resolves.toEqual([]);
    } finally {
      if (restartPool) await restartPool.end();
      if (firstPool) await firstPool.end();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('quarantines a permanently failing session after the cap while a healthy session keeps draining', async () => {
    await withDatabase(async ({ adapters, transcript }) => {
      const healthy = 'api:episode-healthy';
      const poisoned = 'api:episode-poisoned';
      await transcript.append(healthy, 'healthy conversation turn 0');
      await transcript.append(poisoned, 'a chunk the synthesizer can never process');
      const synthesizedSessions: string[] = [];
      const synthesizer = {
        run: vi.fn(async ({ sessionId }: { sessionId: string }) => {
          synthesizedSessions.push(sessionId);
          if (sessionId === poisoned) {
            throw new Error('segments must cover every entry through index 3');
          }
          return synthesisResult();
        }),
      };
      const clock = { now: Date.now() };
      const failureEvents: EpisodeSynthesisSessionFailureEvent[] = [];
      const workset = adapters.conversationalActivityWorkset;
      const lane = new EpisodeSynthesisLane({
        sessionManager: transcript.sessionManager(),
        synthesizer,
        watermarkStore: { getProcessingWatermark: vi.fn(async () => undefined) },
        workset,
        config: gateConfig(3),
        now: () => clock.now,
        onSessionFailure: event => { failureEvents.push(event); },
      });

      for (let round = 1; round <= 3; round += 1) {
        await expect(lane.execute(timerAction())).resolves.toEqual({ outcome: 'complete' });
        // The healthy session drained and checkpointed in the same pass.
        expect((await workset.enumerate('episodic_synthesis')).map(item => item.logicalSessionId))
          .not.toContain(healthy);
        await transcript.append(healthy, `healthy conversation turn ${round}`);
        clock.now += BACKOFF_BASE_MINUTES * MINUTE_MS * 2 ** (round - 1);
      }

      expect(failureEvents.map(event => [event.attemptCount, event.quarantined])).toEqual([
        [1, false],
        [2, false],
        [3, true],
      ]);
      const remaining = await workset.enumerate('episodic_synthesis');
      expect(remaining.map(item => item.logicalSessionId)).toEqual([healthy]);
      const [parked] = await workset.listQuarantined('episodic_synthesis');
      expect(parked).toMatchObject({
        logicalSessionId: poisoned,
        // Quarantine never advances the checkpoint: the source stays intact.
        checkpointRevision: 0,
        failureCount: 3,
        lastFailure: {
          stage: 'episode_synthesis',
          message: 'segments must cover every entry through index 3',
        },
      });
      expect(parked).not.toHaveProperty('claimantId');

      // Further drains spend nothing on the parked session.
      const callsBefore = synthesizedSessions.filter(id => id === poisoned).length;
      await lane.execute(timerAction());
      expect(synthesizedSessions.filter(id => id === poisoned)).toHaveLength(callsBefore);

      // Newer activity makes it eligible again with a fresh attempt budget.
      synthesizer.run.mockImplementation(async ({ sessionId }: { sessionId: string }) => {
        synthesizedSessions.push(sessionId);
        return synthesisResult();
      });
      await transcript.append(poisoned, 'the conversation continued');
      await lane.execute(timerAction());
      await expect(workset.enumerate('episodic_synthesis')).resolves.toEqual([]);
      await expect(workset.listQuarantined('episodic_synthesis')).resolves.toEqual([]);
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('bounds a claim held from before failure tracking existed and lets an operator release its quarantine', async () => {
    await withDatabase(async ({ pool, adapters, transcript }) => {
      const stuck = 'api:episode-held-claim';
      await transcript.append(stuck, 'turns behind a claim held since before the fix');
      const workset = adapters.conversationalActivityWorkset;
      const [item] = await workset.enumerate('episodic_synthesis');
      // The pre-fix state: a held claim with no failed stage and no attempts.
      await workset.claim({
        purpose: 'episodic_synthesis',
        logicalSessionId: stuck,
        revision: item!.revision,
        claimantId: 'episode-synthesis-drain',
      });
      const before = await pool.query<{ failure_count: number; failed_stage: string | null }>(
        `SELECT failure_count, failed_stage FROM session_conversational_workset WHERE logical_session_id = $1`,
        [stuck],
      );
      expect(before.rows).toEqual([{ failure_count: 0, failed_stage: null }]);

      const synthesizer = { run: vi.fn().mockRejectedValue(new Error('claim conflict')) };
      const clock = { now: Date.now() };
      const lane = new EpisodeSynthesisLane({
        sessionManager: transcript.sessionManager(),
        synthesizer,
        watermarkStore: { getProcessingWatermark: vi.fn(async () => undefined) },
        workset,
        config: gateConfig(2),
        now: () => clock.now,
      });
      await lane.execute(timerAction());
      clock.now += BACKOFF_BASE_MINUTES * MINUTE_MS;
      await lane.execute(timerAction());
      expect(synthesizer.run).toHaveBeenCalledTimes(2);
      await expect(workset.enumerate('episodic_synthesis')).resolves.toEqual([]);
      expect(await workset.listQuarantined('episodic_synthesis')).toEqual([
        expect.objectContaining({ logicalSessionId: stuck, failureCount: 2 }),
      ]);

      // Operator recovery without new traffic, after the root cause is fixed.
      await expect(workset.releaseQuarantine({ purpose: 'episodic_synthesis', logicalSessionId: stuck }))
        .resolves.toBe(true);
      await expect(workset.releaseQuarantine({ purpose: 'episodic_synthesis', logicalSessionId: stuck }))
        .resolves.toBe(false);
      synthesizer.run.mockResolvedValue(synthesisResult());
      await lane.execute(timerAction());
      expect(synthesizer.run).toHaveBeenCalledTimes(3);
      await expect(workset.enumerate('episodic_synthesis')).resolves.toEqual([]);
      await expect(workset.listQuarantined('episodic_synthesis')).resolves.toEqual([]);
    });
  }, INTEGRATION_TIMEOUT_MS);
});
