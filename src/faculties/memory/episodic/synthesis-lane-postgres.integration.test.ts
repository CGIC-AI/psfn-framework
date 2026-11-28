import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const logSpies = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }));

// Keep every real logger export and only spy on component log lines, so the
// once-per-window budget-deferral visibility (zwwo0) can be asserted.
vi.mock('../../../shared/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/logger.js')>();
  return {
    ...actual,
    createComponentLogger: () => ({
      info: logSpies.info,
      warn: logSpies.warn,
      error: logSpies.error,
      debug: vi.fn(),
      trace: vi.fn(),
    }),
  };
});

import type { SessionEntry } from '../../../core/session/types.js';
import type { CompletionPurpose, LLMContext, ModelBudgetBlockedEvent } from '../../../shared/contracts/runtime.js';
import { LLMClient } from '../../../primitives/llm/client.js';
import { PiProviderRuntime } from '../../../primitives/llm/provider-runtime.js';
import { PostgresModelUsageStore } from '../../../persistence/postgres/model-usage-store.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { createPostgresPool, ensurePostgresSchema } from '../../../persistence/postgres.js';
import { POSTGRES_MEMORY_MIGRATIONS } from '../../../persistence/postgres/migrations.js';
import { createDefaultPostgresSessionAdapters } from '../../../persistence/sessions/postgres-adapters.js';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import type { EpisodeSynthesisLaneConfig } from '../../../system/config/scheduler-config.js';
import { EpisodeSynthesisLane, type EpisodeSynthesisSessionFailureEvent } from './synthesis-lane.js';
import { EpisodicSynthesizer, type EpisodeSegmentationEvent } from './synthesis.js';
import { PostgresEpisodicStore } from './postgres-store.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const SESSION_ID = 'api:episode-restart';
const BACKOFF_BASE_MINUTES = 30;
const MINUTE_MS = 60_000;
const tempDirs: string[] = [];
let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  // pgvector image: the iu7v0 case runs the real synthesizer on the episodic store.
  harness = await startPostgresTestHarness();
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
    finalPassIdleMinutes: 180,
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

  async append(sessionId: string, content: string, overrides: Partial<SessionEntry> = {}): Promise<void> {
    const entry: SessionEntry = {
      id: this.nextId,
      channelId: sessionId,
      role: 'user',
      content,
      timestamp: this.nextId * 1_000,
      ...overrides,
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

  it('recovers a session stuck on a defective topic-segmentation proposal on the next pass (iu7v0)', async () => {
    await withDatabase(async ({ pool, adapters, transcript }) => {
      await ensurePostgresSchema(pool, POSTGRES_MEMORY_MIGRATIONS);
      const stuck = 'api:episode-segmentation-stuck';
      const startMs = Date.parse('2026-05-04T06:00:00.000Z');
      const turns = [
        'Please debug the atlas project scheduler tests.',
        'I found the atlas scheduler failure and will patch the retry loop.',
        'Does the atlas patch also cover the watchdog timer?',
        'Yes, the atlas watchdog timer now resets after each retry.',
        'Run the atlas scheduler suite again with the patch applied.',
        'The atlas scheduler suite is green after the retry patch.',
        'Different question: what should we cook for dinner tonight?',
        'Maybe pasta with roasted tomatoes, do we have basil left?',
      ];
      for (const [index, content] of turns.entries()) {
        const role = index % 2 === 0 ? 'user' : 'assistant';
        await transcript.append(stuck, content, {
          role,
          timestamp: startMs + index * MINUTE_MS,
          metadata: JSON.stringify({
            turn: { schemaVersion: 1, turnId: `turn:stuck-${index}`, requestId: `request:stuck-${index}`, role },
          }),
        });
      }
      const workset = adapters.conversationalActivityWorkset;
      const [item] = await workset.enumerate('episodic_synthesis');
      // A claim held from before the fix, as the live drain left it.
      await workset.claim({
        purpose: 'episodic_synthesis',
        logicalSessionId: stuck,
        revision: item!.revision,
        claimantId: 'episode-synthesis-drain',
      });

      // The model keeps returning the proposal that failed every pre-fix pass:
      // the final entry is uncovered and a label runs past the 80-char cap.
      const provider = {
        complete: vi.fn(async () => ({
          content: JSON.stringify({
            segments: [
              {
                start_index: 0,
                end_index: 5,
                topic: `atlas scheduler debugging ${'with watchdog timer and retry patch review '.repeat(3)}`,
                status: 'closed',
              },
              { start_index: 6, end_index: 6, topic: 'dinner planning', status: 'closed' },
            ],
          }),
          toolCalls: [],
          model: 'test-model',
          inputTokens: 0,
          outputTokens: 0,
          stopReason: 'stop',
        })),
      };
      const store = new PostgresEpisodicStore(pool, { now: () => new Date(startMs + 60 * MINUTE_MS) });
      const segmentation: EpisodeSegmentationEvent[] = [];
      const synthesizer = new EpisodicSynthesizer(store, transcript.sessionManager(), {
        maxEntriesPerEpisode: 14,
        topicSegmentation: {
          enabled: true,
          llmProvider: provider,
          onEvent: event => segmentation.push(event),
        },
      });
      const failures: EpisodeSynthesisSessionFailureEvent[] = [];
      const lane = new EpisodeSynthesisLane({
        sessionManager: transcript.sessionManager(),
        synthesizer,
        watermarkStore: store,
        workset,
        config: gateConfig(),
        onSessionFailure: event => failures.push(event),
        now: () => startMs + 60 * MINUTE_MS,
      });

      await expect(lane.execute(timerAction())).resolves.toEqual({ outcome: 'complete' });

      expect(failures).toEqual([]);
      expect(provider.complete).toHaveBeenCalledOnce();
      expect(segmentation).toEqual([
        expect.objectContaining({
          outcome: 'segmented',
          repairs: expect.arrayContaining(['topic_truncated', 'trailing_gap_extended']),
        }),
      ]);
      await expect(workset.enumerate('episodic_synthesis')).resolves.toEqual([]);
      await expect(workset.listQuarantined('episodic_synthesis')).resolves.toEqual([]);
      const claims = await store.listEpisodeMessageClaims({ status: 'active' });
      expect(claims).toHaveLength(turns.length);
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('episodizes a run of short separate sessions after they go idle instead of checkpointing them away (d5e0p.2)', async () => {
    await withDatabase(async ({ pool, adapters, transcript }) => {
      await ensurePostgresSchema(pool, POSTGRES_MEMORY_MIGRATIONS);
      const startMs = Date.parse('2026-11-20T09:00:00.000Z');
      // Each external conversation is its own logical session that never grows
      // after it ends; an ordinary short DM behaves the same way.
      const sessions = [
        'api:hermes:1f3a9c0e5b7d2a4c6e8f0a1b3c5d7e9f1a2b4c6d8e0f1a3b5c7d9e1f3a5b7c9d',
        'api:hermes:9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0f9e8d',
        'api:hermes:0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9',
        'discord:dm-short-session',
      ];
      let minute = 0;
      for (const [sessionIndex, sessionId] of sessions.entries()) {
        for (let turn = 0; turn < 3 + sessionIndex; turn += 1) {
          const role = turn % 2 === 0 ? 'user' : 'assistant';
          await transcript.append(sessionId, `short conversation ${sessionIndex} turn ${turn} about trip planning`, {
            role,
            timestamp: startMs + minute * MINUTE_MS,
            metadata: JSON.stringify({
              turn: { schemaVersion: 1, turnId: `turn:short-${sessionIndex}-${turn}`, role },
            }),
          });
          minute += 1;
        }
      }
      const lastTurnMs = startMs + (minute - 1) * MINUTE_MS;
      const totalTurns = minute;
      const workset = adapters.conversationalActivityWorkset;
      const store = new PostgresEpisodicStore(pool, { now: () => new Date(lastTurnMs) });
      const synthesizer = new EpisodicSynthesizer(store, transcript.sessionManager(), { maxEntriesPerEpisode: 14 });
      const clock = { now: lastTurnMs + 30 * MINUTE_MS };
      const lane = new EpisodeSynthesisLane({
        sessionManager: transcript.sessionManager(),
        synthesizer,
        watermarkStore: store,
        workset,
        config: { ...gateConfig(), minRelevantTurns: 10, topicSegmentationEnabled: false },
        scopeClassifier: { classifyChannelMemoryScope: async () => 'direct' as const },
        now: () => clock.now,
      });

      // Recently active and below the minimum: held, every session still eligible.
      await lane.execute(timerAction());
      expect((await workset.enumerate('episodic_synthesis')).map(item => item.logicalSessionId).sort())
        .toEqual([...sessions].sort());
      expect(await store.listEpisodeMessageClaims({ status: 'active' })).toEqual([]);

      // Idle past finalPassIdleMinutes with no new traffic: each gets its final pass.
      clock.now = lastTurnMs + 181 * MINUTE_MS;
      await lane.execute(timerAction());
      await expect(workset.enumerate('episodic_synthesis')).resolves.toEqual([]);
      await expect(workset.listQuarantined('episodic_synthesis')).resolves.toEqual([]);
      const claims = await store.listEpisodeMessageClaims({ status: 'active' });
      expect(claims).toHaveLength(totalTurns);
      expect(new Set(claims.map(claim => claim.claimKey.split(':').slice(1, -1).join(':'))))
        .toEqual(new Set(sessions));
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('episodizes an idle short session whose last topic the segmenter marks open (d5e0p.2)', async () => {
    await withDatabase(async ({ pool, adapters, transcript }) => {
      await ensurePostgresSchema(pool, POSTGRES_MEMORY_MIGRATIONS);
      const sessionId = 'api:hermes:5c4b3a29f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928170615243';
      const startMs = Date.parse('2026-05-04T07:00:00.000Z');
      const turnCount = 4;
      for (let turn = 0; turn < turnCount; turn += 1) {
        const role = turn % 2 === 0 ? 'user' : 'assistant';
        await transcript.append(sessionId, `which trail should we hike this weekend, option ${turn}?`, {
          role,
          timestamp: startMs + turn * MINUTE_MS,
          metadata: JSON.stringify({ turn: { schemaVersion: 1, turnId: `turn:open-${turn}`, role } }),
        });
      }
      const lastTurnMs = startMs + (turnCount - 1) * MINUTE_MS;
      // The conversation simply stopped, so the model calls its only topic open.
      const provider = {
        complete: vi.fn(async () => ({
          content: JSON.stringify({
            segments: [{ start_index: 0, end_index: turnCount - 1, topic: 'weekend hike planning', status: 'open' }],
          }),
          toolCalls: [],
          model: 'test-model',
          inputTokens: 0,
          outputTokens: 0,
          stopReason: 'stop',
        })),
      };
      const store = new PostgresEpisodicStore(pool, { now: () => new Date(lastTurnMs) });
      const synthesizer = new EpisodicSynthesizer(store, transcript.sessionManager(), {
        maxEntriesPerEpisode: 14,
        topicSegmentation: { enabled: true, llmProvider: provider },
      });
      const workset = adapters.conversationalActivityWorkset;
      const lane = new EpisodeSynthesisLane({
        sessionManager: transcript.sessionManager(),
        synthesizer,
        watermarkStore: store,
        workset,
        config: { ...gateConfig(), minRelevantTurns: 10 },
        scopeClassifier: { classifyChannelMemoryScope: async () => 'direct' as const },
        now: () => lastTurnMs + 181 * MINUTE_MS,
      });

      await lane.execute(timerAction());

      expect(provider.complete).toHaveBeenCalledOnce();
      const claims = await store.listEpisodeMessageClaims({ status: 'active' });
      expect(claims).toHaveLength(turnCount);
      await expect(workset.enumerate('episodic_synthesis')).resolves.toEqual([]);
    });
  }, INTEGRATION_TIMEOUT_MS);
});

// psfn-framework-zwwo0: a model-budget refusal happens before any model call is
// dispatched, so it is no evidence against the session. The refusing client is
// a real LLMClient whose real budget controller reads a real Postgres usage
// ledger that is already over the owner-file limit, as in the overnight soak.
const BUDGET_COMPANION_ID = 'companion-a';
const BUDGET_PROVIDER = 'test-provider';
const BUDGET_MODEL = 'priced-memory-model';

function budgetConfig(dataDir: string): SubstrateConfig {
  return {
    primaryModel: BUDGET_MODEL,
    primaryProvider: BUDGET_PROVIDER,
    extractionModel: BUDGET_MODEL,
    extractionProvider: BUDGET_PROVIDER,
    discordToken: '',
    discordBotId: '',
    characterCardPath: '',
    dataDir,
    databasePath: '',
    extractionInterval: 5,
    primaryMaxTokens: 1_024,
    extractionMaxTokens: 1_024,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    companionId: BUDGET_COMPANION_ID,
    modelRoster: {
      memory: { model: BUDGET_MODEL, provider: BUDGET_PROVIDER, maxTokens: 1_024, contextWindow: 128_000 },
    },
    modelRegistry: {
      schemaVersion: 1,
      budgetPolicy: { enabled: true, dailyUsdLimit: 5, monthlyUsdLimit: 5, currency: 'USD' },
      models: [{
        id: 'memory',
        rank: 10,
        identity: { provider: BUDGET_PROVIDER, model: BUDGET_MODEL, source: { type: 'configured' as const } },
        purposes: [{ purpose: 'memory' as const, primary: true }],
        capabilities: { maxOutputTokens: 1_024, contextWindow: 128_000 },
        tuning: { maxOutputTokens: 1_024 },
        cost: { inputPer1MUsd: 3, outputPer1MUsd: 15, cacheReadPer1MUsd: 3, cacheWritePer1MUsd: 3, currency: 'USD' },
      }],
    },
  };
}

/** The real pi-ai runtime, counting every provider dispatch it is asked for. */
class DispatchCountingRuntime extends PiProviderRuntime {
  dispatches = 0;

  override complete(...args: Parameters<PiProviderRuntime['complete']>): ReturnType<PiProviderRuntime['complete']> {
    this.dispatches += 1;
    return super.complete(...args);
  }

  override stream(...args: Parameters<PiProviderRuntime['stream']>): ReturnType<PiProviderRuntime['stream']> {
    this.dispatches += 1;
    return super.stream(...args);
  }
}

async function overBudgetLlmClient(pool: Pool, dataDir: string) {
  const usage = new PostgresModelUsageStore(pool, { companionId: BUDGET_COMPANION_ID });
  const nowMs = Date.now();
  // Today's booked spend is already past the 5 USD owner-file limit.
  await usage.recordUsageEvent({
    logicalCallId: 'soak-spend-before-block',
    attempt: 1,
    recordedAtMs: nowMs - 1_000,
    startedAtMs: nowMs - 1_010,
    completedAtMs: nowMs - 1_000,
    callKind: 'completion',
    attribution: { callType: 'background', purpose: 'memory', originStage: 'memory.extraction' },
    provider: BUDGET_PROVIDER,
    model: BUDGET_MODEL,
    status: 'success',
    inputTokens: 1_000,
    outputTokens: 100,
    providerCostUsd: 6,
    costSource: 'provider',
  });
  const runtime = new DispatchCountingRuntime();
  const blocked: ModelBudgetBlockedEvent[] = [];
  const client = new LLMClient(budgetConfig(dataDir), {
    runtime,
    usageRecorder: usage,
    usageBudgetQuery: usage,
    onBudgetBlocked: event => blocked.push(event),
  });
  return { client, runtime, blocked };
}

/**
 * Topic-segmentation model: while `mode` is 'budget' every call goes through
 * the over-budget LLMClient; 'invalid' answers with output no repair accepts
 * (a genuine synthesis failure); 'admit' answers one closed segment per chunk.
 */
function segmentationModel(budgetClient: LLMClient) {
  const state: { mode: 'budget' | 'invalid' | 'admit' } = { mode: 'budget' };
  const scriptedCalls = { count: 0 };
  const provider = {
    complete: async (
      context: LLMContext,
      purpose: CompletionPurpose,
      options?: Parameters<LLMClient['complete']>[2],
    ) => {
      if (state.mode === 'budget') return budgetClient.complete(context, purpose, options);
      scriptedCalls.count += 1;
      const prompt = String(context.messages[0]?.content ?? '');
      const entryCount = prompt.match(/^\[\d+\] /gmu)?.length ?? 0;
      return {
        content: state.mode === 'invalid'
          ? 'no segments today'
          : JSON.stringify({
            segments: [{ start_index: 0, end_index: entryCount - 1, topic: 'weekend trip planning', status: 'closed' }],
          }),
        toolCalls: [],
        model: 'test-model',
        inputTokens: 0,
        outputTokens: 0,
        stopReason: 'stop' as const,
      };
    },
  };
  return { provider, state, scriptedCalls };
}

async function appendConversation(
  transcript: TranscriptFixture,
  sessionId: string,
  startMs: number,
  turnCount: number,
): Promise<void> {
  for (let turn = 0; turn < turnCount; turn += 1) {
    const role = turn % 2 === 0 ? 'user' : 'assistant';
    await transcript.append(sessionId, `${sessionId} planning a weekend trip, turn ${turn}`, {
      role,
      timestamp: startMs + turn * MINUTE_MS,
      metadata: JSON.stringify({ turn: { schemaVersion: 1, turnId: `turn:${sessionId}:${turn}`, role } }),
    });
  }
}

function budgetDeferralLogs(level: 'warn' | 'info', pipeline: string): unknown[][] {
  return logSpies[level].mock.calls.filter(([, fields]) => (
    typeof fields === 'object' && fields !== null
    && (fields as Record<string, unknown>).pipeline === pipeline
    && (fields as Record<string, unknown>).deferral === 'model_budget'
  ));
}

describe('EpisodeSynthesisLane under a model-budget block (real Postgres, real budget refusal)', () => {
  it('defers refused sessions without consuming attempts and synthesizes them once the budget admits (zwwo0)', async () => {
    await withDatabase(async ({ pool, adapters, transcript }) => {
      await ensurePostgresSchema(pool, POSTGRES_MEMORY_MIGRATIONS);
      logSpies.warn.mockClear();
      logSpies.info.mockClear();
      logSpies.error.mockClear();
      const startMs = Date.parse('2026-11-28T06:00:00.000Z');
      const sessions = ['api:budget-session-a', 'api:budget-session-b'];
      await appendConversation(transcript, sessions[0]!, startMs, 4);
      await appendConversation(transcript, sessions[1]!, startMs + 10 * MINUTE_MS, 4);
      const budget = await overBudgetLlmClient(pool, newSessionsDir('psfn-episode-budget-data-'));
      const model = segmentationModel(budget.client);
      const store = new PostgresEpisodicStore(pool, { now: () => new Date(startMs + 60 * MINUTE_MS) });
      const synthesizer = new EpisodicSynthesizer(store, transcript.sessionManager(), {
        maxEntriesPerEpisode: 14,
        topicSegmentation: { enabled: true, llmProvider: model.provider },
      });
      const failures: EpisodeSynthesisSessionFailureEvent[] = [];
      const clock = { now: startMs + 60 * MINUTE_MS };
      const workset = adapters.conversationalActivityWorkset;
      const maxAttempts = 3;
      const lane = new EpisodeSynthesisLane({
        sessionManager: transcript.sessionManager(),
        synthesizer,
        watermarkStore: store,
        workset,
        config: gateConfig(maxAttempts),
        onSessionFailure: event => failures.push(event),
        now: () => clock.now,
      });

      const drains = maxAttempts + 2;
      for (let drain = 1; drain <= drains; drain += 1) {
        await expect(lane.execute(timerAction())).resolves.toEqual({ outcome: 'complete' });
        // Well past any backoff a counted failure would have set.
        clock.now += BACKOFF_BASE_MINUTES * MINUTE_MS * 2 ** drain;
      }

      // Every drain stopped at its first refusal: the second session, refused by
      // the same companion budget, was never probed, and nothing was dispatched.
      expect(budget.blocked).toHaveLength(drains);
      expect(budget.blocked[0]).toMatchObject({ reason: 'daily_budget_exceeded', purpose: 'memory' });
      expect(budget.runtime.dispatches).toBe(0);
      expect(failures).toEqual([]);
      await expect(workset.listQuarantined('episodic_synthesis')).resolves.toEqual([]);
      const pending = await workset.enumerate('episodic_synthesis');
      expect(pending.map(item => item.logicalSessionId)).toEqual(sessions);
      expect(pending[0]).toMatchObject({
        logicalSessionId: sessions[0],
        claimantId: 'episode-synthesis-drain',
        checkpointRevision: 0,
      });
      expect(pending[0]?.failureCount ?? 0).toBe(0);
      expect(pending[0]?.lastFailure).toBeUndefined();
      expect(pending[0]?.retryAfterMs).toBeUndefined();
      // One warning for the whole blocked window, not one per refused attempt.
      expect(budgetDeferralLogs('warn', 'episode_synthesis')).toHaveLength(1);
      expect(budgetDeferralLogs('info', 'episode_synthesis')).toHaveLength(0);
      // No memory-pipeline line warns or errors per refused attempt. The
      // gateway's own LLMClient lines (fallback exhaustion per refused call,
      // plus the seeded ledger row's attribution warning) run in the gateway
      // process, outside the memory pipeline, and are excluded here.
      const gatewaySide = new Set([
        'All fallback candidates exhausted',
        'Model usage recorded with unknown charge-lane attribution',
      ]);
      expect([...logSpies.warn.mock.calls, ...logSpies.error.mock.calls]
        .map(([message]) => message)
        .filter(message => !gatewaySide.has(message as string)))
        .toEqual(['Memory pipeline deferred: the model budget refuses its calls before dispatch; no attempt is consumed']);

      model.state.mode = 'admit';
      await expect(lane.execute(timerAction())).resolves.toEqual({ outcome: 'complete' });

      expect(model.scriptedCalls.count).toBe(sessions.length);
      expect(budget.runtime.dispatches).toBe(0);
      expect(failures).toEqual([]);
      await expect(workset.enumerate('episodic_synthesis')).resolves.toEqual([]);
      await expect(workset.listQuarantined('episodic_synthesis')).resolves.toEqual([]);
      await expect(store.listEpisodeMessageClaims({ status: 'active' })).resolves.toHaveLength(8);
      const resumed = budgetDeferralLogs('info', 'episode_synthesis');
      expect(resumed).toHaveLength(1);
      expect(resumed[0]?.[1]).toMatchObject({ refusedAttempts: drains });
      expect(budgetDeferralLogs('warn', 'episode_synthesis')).toHaveLength(1);
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('keeps counting genuine synthesis failures across budget refusals and quarantines at the cap (zwwo0)', async () => {
    await withDatabase(async ({ pool, adapters, transcript }) => {
      await ensurePostgresSchema(pool, POSTGRES_MEMORY_MIGRATIONS);
      const startMs = Date.parse('2026-11-28T06:00:00.000Z');
      const sessionId = 'api:budget-session-poisoned';
      await appendConversation(transcript, sessionId, startMs, 4);
      const budget = await overBudgetLlmClient(pool, newSessionsDir('psfn-episode-budget-cap-data-'));
      const model = segmentationModel(budget.client);
      const store = new PostgresEpisodicStore(pool, { now: () => new Date(startMs + 60 * MINUTE_MS) });
      const synthesizer = new EpisodicSynthesizer(store, transcript.sessionManager(), {
        maxEntriesPerEpisode: 14,
        topicSegmentation: { enabled: true, llmProvider: model.provider },
      });
      const failures: EpisodeSynthesisSessionFailureEvent[] = [];
      const clock = { now: startMs + 60 * MINUTE_MS };
      const workset = adapters.conversationalActivityWorkset;
      const lane = new EpisodeSynthesisLane({
        sessionManager: transcript.sessionManager(),
        synthesizer,
        watermarkStore: store,
        workset,
        config: gateConfig(3),
        onSessionFailure: event => failures.push(event),
        now: () => clock.now,
      });
      const drainAfterBackoff = async (mode: 'budget' | 'invalid'): Promise<void> => {
        model.state.mode = mode;
        clock.now += BACKOFF_BASE_MINUTES * MINUTE_MS * 8;
        await lane.execute(timerAction());
      };

      await drainAfterBackoff('invalid');
      await drainAfterBackoff('budget');
      await drainAfterBackoff('budget');
      await drainAfterBackoff('invalid');
      for (let refusal = 0; refusal < 4; refusal += 1) await drainAfterBackoff('budget');

      const [held] = await workset.enumerate('episodic_synthesis');
      // Refusals neither consumed an attempt nor erased the recorded failure.
      expect(held).toMatchObject({
        logicalSessionId: sessionId,
        failureCount: 2,
        lastFailure: { stage: 'episode_synthesis', message: expect.stringContaining('after one corrective retry') },
      });
      expect(failures.map(event => [event.attemptCount, event.quarantined])).toEqual([[1, false], [2, false]]);
      expect(budget.blocked).toHaveLength(6);

      await drainAfterBackoff('invalid');

      expect(failures.map(event => [event.attemptCount, event.quarantined])).toEqual([
        [1, false],
        [2, false],
        [3, true],
      ]);
      await expect(workset.enumerate('episodic_synthesis')).resolves.toEqual([]);
      expect(await workset.listQuarantined('episodic_synthesis')).toEqual([
        expect.objectContaining({ logicalSessionId: sessionId, failureCount: 3 }),
      ]);
      expect(budget.runtime.dispatches).toBe(0);
    });
  }, INTEGRATION_TIMEOUT_MS);
});
