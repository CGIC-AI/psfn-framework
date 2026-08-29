import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createPostgresPool } from '../../../persistence/postgres.js';
import { createDefaultPostgresSessionAdapters } from '../../../persistence/sessions/postgres-adapters.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import type { EpisodeSynthesisLaneConfig } from '../../../system/config/scheduler-config.js';
import { EpisodeSynthesisLane } from './synthesis-lane.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const SESSION_ID = 'api:episode-restart';
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

function gateConfig(): EpisodeSynthesisLaneConfig {
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

function sessionManager() {
  return {
    resolveSessionChannelId: (channelId: string) => channelId,
    getRecentMessages: () => [{
      id: 1,
      channelId: SESSION_ID,
      role: 'user' as const,
      content: 'A genuine conversation that needs an episode after restart.',
      timestamp: 1_000,
    }],
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

describe('EpisodeSynthesisLane restart recovery (real Postgres)', () => {
  it('resumes its stable failed claim and checkpoints it after process restart', async () => {
    if (!harness) throw new Error('Postgres test harness is unavailable');
    const database = await harness.createDatabase();
    let firstPool: Pool | null = createPostgresPool(database.databaseUrl, {
      applicationName: 'psfn-episode-restart-first',
      allowExitOnIdle: true,
      max: 3,
    });
    let restartPool: ReturnType<typeof createPostgresPool> | null = null;

    try {
      const firstAdapters = await createDefaultPostgresSessionAdapters(database.databaseUrl, {
        sessionsDir: newSessionsDir('psfn-episode-restart-first-'),
        pool: firstPool,
      });
      firstAdapters.transcriptProjection.upsertSessionEntry({
        id: 1,
        channelId: SESSION_ID,
        role: 'user',
        content: 'A genuine conversation that needs an episode after restart.',
        timestamp: 1_000,
      });
      await firstAdapters.transcriptProjection.flushPendingWrites?.();

      const failingSynthesizer = { run: vi.fn().mockRejectedValue(new Error('provider unavailable')) };
      const firstLane = new EpisodeSynthesisLane({
        sessionManager: sessionManager(),
        synthesizer: failingSynthesizer,
        watermarkStore: { getProcessingWatermark: vi.fn(async () => undefined) },
        workset: firstAdapters.conversationalActivityWorkset,
        config: gateConfig(),
      });
      await expect(firstLane.execute(timerAction())).rejects.toThrow(
        'Episode synthesis drain failed for 1 session(s)',
      );
      await expect(firstAdapters.conversationalActivityWorkset.enumerate('episodic_synthesis'))
        .resolves.toEqual([
          expect.objectContaining({
            logicalSessionId: SESSION_ID,
            claimantId: 'episode-synthesis-drain',
          }),
        ]);

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
        sessionManager: sessionManager(),
        synthesizer: restartedSynthesizer,
        watermarkStore: { getProcessingWatermark: vi.fn(async () => undefined) },
        workset: restartedAdapters.conversationalActivityWorkset,
        config: gateConfig(),
      });

      await restartedLane.execute(timerAction());

      expect(restartedSynthesizer.run).toHaveBeenCalledOnce();
      await expect(restartedAdapters.conversationalActivityWorkset.enumerate('episodic_synthesis'))
        .resolves.toEqual([]);
    } finally {
      if (restartPool) await restartPool.end();
      if (firstPool) await firstPool.end();
    }
  }, INTEGRATION_TIMEOUT_MS);
});
