import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPORAL_WAKEUP_CONFIG } from './scheduler-config.js';
import { resolveRuntimeSchedulerConfig } from './scheduler-runtime.js';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

const MEMORY_LANE_BLOCKS = {
  nearTurnMemory: {
    direct: { cadenceTurns: 3 },
    group: { minIntervalMinutes: 15, minNewEntries: 8 },
  },
  episodeSynthesis: {
    timerIntervalMinutes: 30,
    turnThreshold: 24,
    minRelevantTurns: 10,
    transcriptMessageLimit: 96,
    maxEpisodesPerRun: 6,
    gapSplitMinutes: 45,
    maxEntriesPerEpisode: 14,
    minConversationalEntries: 2,
    minSingleEntryChars: 120,
  },
  sleepConsolidation: {
    reviewWindowDays: 60,
    refinementWindowHours: 36,
    adjacencyGapMinutes: 45,
    maxRefinementsPerRun: 8,
    maxConsolidationsPerRun: 6,
  },
  arcFormation: {
    passIntervalDays: 6,
    reviewWindowDays: 30,
    minConfidence: 0.5,
  },
} as const;

describe('resolveRuntimeSchedulerConfig', () => {
  it('requires object-form options with a dataDir', () => {
    expect(() => resolveRuntimeSchedulerConfig('invalid' as unknown as {
      dataDir: string;
    })).toThrow('expects an options object argument');
    expect(() => resolveRuntimeSchedulerConfig({ dataDir: '' })).toThrow('requires options.dataDir');
  });

  it('loads persisted config when runtime env overrides are absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'scheduler-runtime-config-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'seed');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });

    try {
      writeJson(join(dataDir, 'scheduler.json'), {
        tickIntervalMs: 45_000,
        heartbeatIntervalMs: 900_000,
        salienceDecayIntervalMs: 120_000,
        artifactLifecycle: {
          scratchpadRetentionDays: 7,
          generatedMediaRetentionDays: 21,
          workspaceTempRetentionDays: 9,
          cleanupBatchSize: 64,
        },
        episodicProcessing: {
          enabled: true,
          startLocalTime: '23:00',
          endLocalTime: '07:00',
          timeZone: 'America/New_York',
          inactivityThresholdMinutes: 45,
        },
        ...MEMORY_LANE_BLOCKS,
      });

      const resolved = resolveRuntimeSchedulerConfig({
        dataDir,
        seedDir,
      });

      expect(resolved).toEqual({
        tickIntervalMs: 45_000,
        heartbeatIntervalMs: 900_000,
        salienceDecayIntervalMs: 120_000,
        artifactLifecycle: {
          scratchpadRetentionDays: 7,
          generatedMediaRetentionDays: 21,
          workspaceTempRetentionDays: 9,
          cleanupBatchSize: 64,
        },
        episodicProcessing: {
          enabled: true,
          startLocalTime: '23:00',
          endLocalTime: '07:00',
          timeZone: 'America/New_York',
          inactivityThresholdMinutes: 45,
        },
        ...MEMORY_LANE_BLOCKS,
        socialGraphBuilder: {
          intervalMs: 1_800_000,
          coPresenceMinSessions: 3,
          coPresenceWindowMinutes: 1440,
          scanMemoryLimit: 500,
        },
        temporalWakeup: DEFAULT_TEMPORAL_WAKEUP_CONFIG,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores legacy env overrides and keeps persisted scheduler values authoritative', () => {
    const root = mkdtempSync(join(tmpdir(), 'scheduler-runtime-env-'));
    const dataDir = join(root, 'data');
    const seedDir = join(root, 'seed');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(seedDir, { recursive: true });

    try {
      writeJson(join(dataDir, 'scheduler.json'), {
        tickIntervalMs: 10_000,
        heartbeatIntervalMs: 20_000,
        salienceDecayIntervalMs: 30_000,
        artifactLifecycle: {
          scratchpadRetentionDays: 3,
          generatedMediaRetentionDays: 4,
          workspaceTempRetentionDays: 5,
          cleanupBatchSize: 6,
        },
        episodicProcessing: {
          enabled: false,
          startLocalTime: '01:00',
          endLocalTime: '02:00',
          timeZone: 'UTC',
          inactivityThresholdMinutes: 15,
        },
        ...MEMORY_LANE_BLOCKS,
      });

      const resolved = resolveRuntimeSchedulerConfig({
        dataDir,
        seedDir,
      });

      expect(resolved).toEqual({
        tickIntervalMs: 10_000,
        heartbeatIntervalMs: 20_000,
        salienceDecayIntervalMs: 30_000,
        artifactLifecycle: {
          scratchpadRetentionDays: 3,
          generatedMediaRetentionDays: 4,
          workspaceTempRetentionDays: 5,
          cleanupBatchSize: 6,
        },
        episodicProcessing: {
          enabled: false,
          startLocalTime: '01:00',
          endLocalTime: '02:00',
          timeZone: 'UTC',
          inactivityThresholdMinutes: 15,
        },
        ...MEMORY_LANE_BLOCKS,
        socialGraphBuilder: {
          intervalMs: 1_800_000,
          coPresenceMinSessions: 3,
          coPresenceWindowMinutes: 1440,
          scanMemoryLimit: 500,
        },
        temporalWakeup: DEFAULT_TEMPORAL_WAKEUP_CONFIG,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
