import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPORAL_WAKEUP_CONFIG,
  loadSchedulerSeedDefaults,
  SCHEDULER_SEED_FILE_NAME,
} from './scheduler-config.js';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function buildValidSchedulerConfig(): Record<string, unknown> {
  return {
    tickIntervalMs: 60_000,
    heartbeatIntervalMs: 90_000,
    salienceDecayIntervalMs: 123_000,
    artifactLifecycle: {
      scratchpadRetentionDays: 10,
      generatedMediaRetentionDays: 20,
      workspaceTempRetentionDays: 30,
      cleanupBatchSize: 40,
    },
    episodicProcessing: {
      enabled: true,
      startLocalTime: '23:00',
      endLocalTime: '07:30',
      timeZone: 'America/New_York',
      inactivityThresholdMinutes: 45,
    },
    nearTurnMemory: {
      direct: { cadenceTurns: 5 },
      group: { minIntervalMinutes: 20, minNewEntries: 12 },
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
      topicSegmentationEnabled: false,
    },
    sleepConsolidation: {
      reviewWindowDays: 60,
      refinementWindowHours: 36,
      adjacencyGapMinutes: 45,
      maxRefinementsPerRun: 8,
    },
    arcFormation: {
      passIntervalDays: 6,
      reviewWindowDays: 30,
      minConfidence: 0.5,
    },
    socialGraphBuilder: {
      intervalMs: 900_000,
      coPresenceMinSessions: 4,
      coPresenceWindowMinutes: 720,
      scanMemoryLimit: 250,
    },
  };
}

function withSeedDir(run: (seedDir: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'scheduler-config-test-'));
  const seedDir = join(root, 'seed');
  mkdirSync(seedDir, { recursive: true });
  try {
    run(seedDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('scheduler config seed defaults', () => {
  it('reads seed defaults without requiring a data directory', () => {
    withSeedDir((seedDir) => {
      const config = buildValidSchedulerConfig();
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), config);
      expect(loadSchedulerSeedDefaults({ seedDir })).toEqual({
        ...config,
        temporalWakeup: DEFAULT_TEMPORAL_WAKEUP_CONFIG,
      });
    });
  });

  it('applies temporalWakeup overrides and fails closed on malformed wake time', () => {
    withSeedDir((seedDir) => {
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), {
        ...buildValidSchedulerConfig(),
        temporalWakeup: {
          enabled: true,
          morningWake: { localTime: '07:15', fullTurnMaxIdleHours: 24 },
          idleRefresher: { minIdleMinutes: 120 },
        },
      });
      const loaded = loadSchedulerSeedDefaults({ seedDir });
      expect(loaded.temporalWakeup).toEqual({
        enabled: true,
        morningWake: {
          ...DEFAULT_TEMPORAL_WAKEUP_CONFIG.morningWake,
          localTime: '07:15',
          fullTurnMaxIdleHours: 24,
        },
        idleRefresher: {
          ...DEFAULT_TEMPORAL_WAKEUP_CONFIG.idleRefresher,
          minIdleMinutes: 120,
        },
      });

      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), {
        ...buildValidSchedulerConfig(),
        temporalWakeup: {
          morningWake: { localTime: '25:00' },
        },
      });
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        'temporalWakeup.morningWake.localTime must be HH:mm local time',
      );

      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), {
        ...buildValidSchedulerConfig(),
        temporalWakeup: {
          morningWake: { timezone: 'America/New_York' },
        },
      });
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        'temporalWakeup.morningWake.timezone must be "local" or "utc"',
      );
    });
  });

  it('accepts the habit wake-timing toggle and habit overrides (E7.2)', () => {
    withSeedDir((seedDir) => {
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), {
        ...buildValidSchedulerConfig(),
        temporalWakeup: {
          enabled: true,
          morningWake: {
            timing: 'habit',
            habit: { minSampleDays: 3, wakeBandStartHour: 4, recentWeight: 3 },
          },
          idleRefresher: {},
        },
      });
      const loaded = loadSchedulerSeedDefaults({ seedDir });
      expect(loaded.temporalWakeup.morningWake.timing).toBe('habit');
      expect(loaded.temporalWakeup.morningWake.habit).toEqual({
        ...DEFAULT_TEMPORAL_WAKEUP_CONFIG.morningWake.habit,
        minSampleDays: 3,
        wakeBandStartHour: 4,
        recentWeight: 3,
      });
    });
  });

  it('defaults wake timing to fixed and fails closed on invalid timing/habit config (E7.2)', () => {
    withSeedDir((seedDir) => {
      // Default remains 'fixed' when unspecified.
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), buildValidSchedulerConfig());
      expect(loadSchedulerSeedDefaults({ seedDir }).temporalWakeup.morningWake.timing).toBe('fixed');

      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), {
        ...buildValidSchedulerConfig(),
        temporalWakeup: { morningWake: { timing: 'sensor' } },
      });
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        'temporalWakeup.morningWake.timing must be "fixed" or "habit"',
      );

      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), {
        ...buildValidSchedulerConfig(),
        temporalWakeup: { morningWake: { habit: { extendedWindowDays: 3, recentWindowDays: 7 } } },
      });
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        'temporalWakeup.morningWake.habit.extendedWindowDays must be >= recentWindowDays',
      );

      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), {
        ...buildValidSchedulerConfig(),
        temporalWakeup: { morningWake: { habit: { wakeBandStartHour: 12, wakeBandEndHour: 6 } } },
      });
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        'temporalWakeup.morningWake.habit.wakeBandEndHour must be greater than wakeBandStartHour',
      );
    });
  });

  it('fails closed on malformed rest-window config', () => {
    withSeedDir((seedDir) => {
      const config = buildValidSchedulerConfig();
      config.episodicProcessing = {
        enabled: true,
        startLocalTime: '24:00',
        endLocalTime: '09:00',
        timeZone: 'Mars/Base',
        inactivityThresholdMinutes: 0,
      };
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), config);
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        'episodicProcessing.startLocalTime must be HH:mm local time',
      );
    });
  });

  it('rejects the removed "sleeptime" cadence key with rename guidance (no legacy alias)', () => {
    withSeedDir((seedDir) => {
      const config = buildValidSchedulerConfig();
      config.sleeptime = {
        direct: { cadenceTurns: 3 },
        group: { minIntervalMinutes: 15, minNewEntries: 8 },
      };
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), config);
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        /"sleeptime" cadence key was removed.*nearTurnMemory/s,
      );
    });
  });

  it.each([
    'nearTurnMemory',
    'episodeSynthesis',
    'sleepConsolidation',
    'arcFormation',
  ])('fails closed when the %s block is missing', (block) => {
    withSeedDir((seedDir) => {
      const config = buildValidSchedulerConfig();
      delete config[block];
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), config);
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        new RegExp(`${block} must be an object`),
      );
    });
  });

  it('fails closed on invalid episode-synthesis gate thresholds', () => {
    withSeedDir((seedDir) => {
      const config = buildValidSchedulerConfig();
      config.episodeSynthesis = {
        ...(config.episodeSynthesis as Record<string, unknown>),
        minRelevantTurns: 0,
      };
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), config);
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        'episodeSynthesis.minRelevantTurns must be an integer >= 1',
      );
    });
  });

  it('defaults topicSegmentationEnabled to false when the key is absent (E5.4)', () => {
    withSeedDir((seedDir) => {
      const config = buildValidSchedulerConfig();
      const episodeSynthesis = { ...(config.episodeSynthesis as Record<string, unknown>) };
      delete episodeSynthesis.topicSegmentationEnabled;
      config.episodeSynthesis = episodeSynthesis;
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), config);
      expect(loadSchedulerSeedDefaults({ seedDir }).episodeSynthesis.topicSegmentationEnabled).toBe(false);
    });
  });

  it('fails closed when topicSegmentationEnabled is not a boolean', () => {
    withSeedDir((seedDir) => {
      const config = buildValidSchedulerConfig();
      config.episodeSynthesis = {
        ...(config.episodeSynthesis as Record<string, unknown>),
        topicSegmentationEnabled: 'yes',
      };
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), config);
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        'episodeSynthesis.topicSegmentationEnabled must be true or false',
      );
    });
  });

  it('fails closed when arcFormation.minConfidence is out of the unit interval', () => {
    withSeedDir((seedDir) => {
      const config = buildValidSchedulerConfig();
      config.arcFormation = {
        ...(config.arcFormation as Record<string, unknown>),
        minConfidence: 1.5,
      };
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), config);
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        'arcFormation.minConfidence must be a number between 0 and 1',
      );
    });
  });
});
