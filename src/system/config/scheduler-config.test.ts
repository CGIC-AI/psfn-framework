import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BACKGROUND_WORK_TUNING,
  DEFAULT_FREE_TIME_CONFIG,
  DEFAULT_SOCIAL_AUTONOMY_CONFIG,
  DEFAULT_TEMPORAL_WAKEUP_CONFIG,
  DEFAULT_WEIGHTED_THOUGHT_OUTREACH_CONFIG,
  loadSchedulerSeedDefaults,
  SCHEDULER_SEED_FILE_NAME,
  validateSchedulerConfig,
} from './scheduler-config.js';
import { assertPositiveInteger } from './validators.js';
import { DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG } from './icp-autonomy-scheduler-config.js';
import { isRecord } from '../../shared/utils/types.js';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

function buildValidSchedulerConfig(): Record<string, unknown> {
  return {
    tickIntervalMs: 60_000,
    heartbeatIntervalMs: 90_000,
    backgroundMaintenance: {
      intervalMs: 3_600_000,
      sharedWorldWikiCaretaker: {
        batchSize: 25,
      },
      ambientPresence: {
        minIdleMinutes: 180,
        minNoteIntervalMinutes: 360,
      },
      concernGrooming: {
        maxActiveConcerns: 7,
      },
    },
    backgroundWork: structuredClone(DEFAULT_BACKGROUND_WORK_TUNING),
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
      maxPriorCandidates: 24,
    },
    sleepConsolidation: {
      reviewWindowDays: 60,
      refinementWindowHours: 36,
      adjacencyGapMinutes: 45,
      maxRefinementsPerRun: 8,
      maxConsolidationsPerRun: 6,
      transcriptMessageLimit: 200,
      maxTranscriptCharsPerEpisode: 6000,
    },
    orientationRewrite: {
      minNewEntriesSinceRewrite: 4,
      refreshAfterQuietDays: 7,
    },
    reflectionNovelty: {
      minNewEntries: 1,
    },
    wikiPass: {
      enabled: true,
      reviewWindowHours: 36,
      minNewCanonicalEpisodes: 1,
      minNewDurableMemories: 3,
      maxEntriesPerRun: 3,
      maxSourceEpisodes: 12,
      maxSourceMemories: 30,
    },
    arcFormation: {
      passIntervalDays: 6,
      reviewWindowDays: 30,
      minConfidence: 0.5,
      maxArcsPerRun: 12,
      maxEpisodesPerRun: 60,
    },
    socialGraphBuilder: {
      coPresenceMinSessions: 4,
      coPresenceWindowMinutes: 720,
      scanMemoryLimit: 250,
    },
    icpAutonomy: DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG,
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

describe('config validators', () => {
  it('validates positive integer min and max boundaries', () => {
    const options = { min: 2, max: 4 };

    expect(() => assertPositiveInteger(1, 'sample.field', options)).toThrow(
      'sample.field must be between 2 and 4',
    );
    expect(assertPositiveInteger(2, 'sample.field', options)).toBe(2);
    expect(assertPositiveInteger(4, 'sample.field', options)).toBe(4);
    expect(() => assertPositiveInteger(5, 'sample.field', options)).toThrow(
      'sample.field must be between 2 and 4',
    );
    expect(() => assertPositiveInteger(2.5, 'sample.field', options)).toThrow(
      'sample.field must be a positive integer',
    );
    expect(() => assertPositiveInteger('2', 'sample.field', options)).toThrow(
      'sample.field must be a positive integer',
    );
  });
});

describe('scheduler config seed defaults', () => {
  it('owns the complete durable background-work tuning group', () => {
    expect(loadSchedulerSeedDefaults().backgroundWork).toEqual(DEFAULT_BACKGROUND_WORK_TUNING);
  });

  it('fails closed on missing, unknown, unsafe, or incoherent background-work tuning', () => {
    withSeedDir((seedDir) => {
      const missing = buildValidSchedulerConfig();
      delete missing.backgroundWork;
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), missing);
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        'backgroundWork must be an object',
      );

      const unknown = buildValidSchedulerConfig();
      unknown.backgroundWork = {
        ...structuredClone(DEFAULT_BACKGROUND_WORK_TUNING),
        parallelFallback: 8,
      };
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), unknown);
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        /backgroundWork contains unknown keys: parallelFallback/u,
      );

      const unsafe = buildValidSchedulerConfig();
      unsafe.backgroundWork = {
        ...structuredClone(DEFAULT_BACKGROUND_WORK_TUNING),
        supervisor: {
          ...DEFAULT_BACKGROUND_WORK_TUNING.supervisor,
          leaseDurationMs: Number.MAX_SAFE_INTEGER + 1,
        },
      };
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), unsafe);
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        'backgroundWork.supervisor.leaseDurationMs must be a positive safe integer',
      );

      const incoherent = buildValidSchedulerConfig();
      incoherent.backgroundWork = {
        ...structuredClone(DEFAULT_BACKGROUND_WORK_TUNING),
        supervisor: {
          ...DEFAULT_BACKGROUND_WORK_TUNING.supervisor,
          retryBaseDelayMs: 2_000,
          retryMaxDelayMs: 1_000,
        },
      };
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), incoherent);
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        /retryMaxDelayMs must be greater than or equal to .*retryBaseDelayMs/u,
      );

      const negativeShutdown = buildValidSchedulerConfig();
      negativeShutdown.backgroundWork = {
        ...structuredClone(DEFAULT_BACKGROUND_WORK_TUNING),
        supervisor: {
          ...DEFAULT_BACKGROUND_WORK_TUNING.supervisor,
          shutdownTimeoutMs: -1,
        },
      };
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), negativeShutdown);
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        'backgroundWork.supervisor.shutdownTimeoutMs must be a non-negative safe integer',
      );
    });
  });

  it('checks in one hourly background-maintenance cadence with owned ambient thresholds', () => {
    expect(loadSchedulerSeedDefaults().backgroundMaintenance).toEqual({
      intervalMs: 3_600_000,
      sharedWorldWikiCaretaker: {
        batchSize: 25,
      },
      ambientPresence: {
        minIdleMinutes: 180,
        minNoteIntervalMinutes: 360,
      },
      concernGrooming: {
        maxActiveConcerns: 7,
      },
    });
    expect(loadSchedulerSeedDefaults().socialGraphBuilder).not.toHaveProperty('intervalMs');
  });

  it('requires an owner-file caretaker cleanup batch with no runtime default', () => {
    withSeedDir((seedDir) => {
      const missing = buildValidSchedulerConfig();
      const backgroundMaintenance = missing.backgroundMaintenance;
      if (!isRecord(backgroundMaintenance)) {
        throw new Error('test scheduler config backgroundMaintenance is malformed');
      }
      delete backgroundMaintenance.sharedWorldWikiCaretaker;
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), missing);
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        'backgroundMaintenance.sharedWorldWikiCaretaker must be an object',
      );

      const invalid = buildValidSchedulerConfig();
      const invalidMaintenance = invalid.backgroundMaintenance;
      if (!isRecord(invalidMaintenance)) {
        throw new Error('test scheduler config backgroundMaintenance is malformed');
      }
      invalidMaintenance.sharedWorldWikiCaretaker = { batchSize: 0 };
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), invalid);
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        'backgroundMaintenance.sharedWorldWikiCaretaker.batchSize',
      );
    });
  });

  it('rejects retired per-operation cadence keys instead of silently aliasing them', () => {
    withSeedDir((seedDir) => {
      const topLevelLegacy = {
        ...buildValidSchedulerConfig(),
        salienceDecayIntervalMs: 300_000,
      };
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), topLevelLegacy);
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        /salienceDecayIntervalMs.*backgroundMaintenance\.intervalMs/s,
      );

      const nestedLegacy = buildValidSchedulerConfig();
      nestedLegacy.socialGraphBuilder = {
        ...(nestedLegacy.socialGraphBuilder as Record<string, unknown>),
        intervalMs: 300_000,
      };
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), nestedLegacy);
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        /socialGraphBuilder\.intervalMs.*backgroundMaintenance\.intervalMs/s,
      );
    });
  });

  it('keeps weighted-thought outreach on its justified 30-minute cadence', () => {
    expect(loadSchedulerSeedDefaults().weightedThoughtOutreach.checkIntervalMs).toBe(1_800_000);
  });

  it('reads seed defaults without requiring a data directory', () => {
    withSeedDir((seedDir) => {
      const config = buildValidSchedulerConfig();
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), config);
      expect(loadSchedulerSeedDefaults({ seedDir })).toEqual({
        ...config,
        temporalWakeup: DEFAULT_TEMPORAL_WAKEUP_CONFIG,
        freeTime: DEFAULT_FREE_TIME_CONFIG,
        socialAutonomy: DEFAULT_SOCIAL_AUTONOMY_CONFIG,
        weightedThoughtOutreach: DEFAULT_WEIGHTED_THOUGHT_OUTREACH_CONFIG,
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
        activeChannelLookbackHours: DEFAULT_TEMPORAL_WAKEUP_CONFIG.activeChannelLookbackHours,
        morningWake: {
          ...DEFAULT_TEMPORAL_WAKEUP_CONFIG.morningWake,
          localTime: '07:15',
          fullTurnMaxIdleHours: 24,
        },
        idleRefresher: {
          ...DEFAULT_TEMPORAL_WAKEUP_CONFIG.idleRefresher,
          minIdleMinutes: 120,
        },
        wakeSummary: { ...DEFAULT_TEMPORAL_WAKEUP_CONFIG.wakeSummary },
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

  it('owns the wake summary budgets and continuity floor with validated defaults (67ka)', () => {
    withSeedDir((seedDir) => {
      expect(DEFAULT_TEMPORAL_WAKEUP_CONFIG.wakeSummary).toEqual({
        sessionSummaryMaxTokens: 160,
        continuitySummaryMaxTokens: 160,
        continuityMinEntries: 2,
      });

      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), {
        ...buildValidSchedulerConfig(),
        temporalWakeup: {
          wakeSummary: { continuitySummaryMaxTokens: 96, continuityMinEntries: 3 },
        },
      });
      expect(loadSchedulerSeedDefaults({ seedDir }).temporalWakeup.wakeSummary).toEqual({
        sessionSummaryMaxTokens: 160,
        continuitySummaryMaxTokens: 96,
        continuityMinEntries: 3,
      });

      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), {
        ...buildValidSchedulerConfig(),
        temporalWakeup: {
          wakeSummary: { sessionSummaryMaxTokens: 0 },
        },
      });
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        'temporalWakeup.wakeSummary.sessionSummaryMaxTokens must be an integer >= 1',
      );

      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), {
        ...buildValidSchedulerConfig(),
        temporalWakeup: {
          wakeSummary: { continuityMinEntries: 0 },
        },
      });
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        'temporalWakeup.wakeSummary.continuityMinEntries must be an integer >= 1',
      );

      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), {
        ...buildValidSchedulerConfig(),
        temporalWakeup: {
          wakeSummary: 'tiny',
        },
      });
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        'temporalWakeup.wakeSummary must be an object',
      );
    });
  });

  describe('scheduler config active-channel + cadence defaults', () => {
    it('defaults activeChannelLookbackHours to 72h and fails closed on non-positive values', () => {
      withSeedDir((seedDir) => {
        expect(DEFAULT_TEMPORAL_WAKEUP_CONFIG.activeChannelLookbackHours).toBe(72);

        writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), {
          ...buildValidSchedulerConfig(),
          temporalWakeup: { morningWake: { localTime: '08:00' } },
        });
        expect(loadSchedulerSeedDefaults({ seedDir }).temporalWakeup.activeChannelLookbackHours).toBe(72);

        writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), {
          ...buildValidSchedulerConfig(),
          temporalWakeup: { activeChannelLookbackHours: 24 },
        });
        expect(loadSchedulerSeedDefaults({ seedDir }).temporalWakeup.activeChannelLookbackHours).toBe(24);

        writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), {
          ...buildValidSchedulerConfig(),
          temporalWakeup: { activeChannelLookbackHours: 0 },
        });
        expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
          'temporalWakeup.activeChannelLookbackHours must be an integer >= 1',
        );
      });
    });

    it('defaults the idle refresher thresholds to the 2h temporal-update cadence', () => {
      expect(DEFAULT_TEMPORAL_WAKEUP_CONFIG.idleRefresher.minIdleMinutes).toBe(120);
      expect(DEFAULT_TEMPORAL_WAKEUP_CONFIG.idleRefresher.minNoteIntervalMinutes).toBe(120);
    });
  });

  it('owns the free-time return-note summary budget with validated defaults (zpgz)', () => {
    withSeedDir((seedDir) => {
      expect(DEFAULT_FREE_TIME_CONFIG.returnNote).toEqual({ summaryMaxTokens: 160 });

      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), {
        ...buildValidSchedulerConfig(),
        freeTime: { returnNote: { summaryMaxTokens: 96 } },
      });
      expect(loadSchedulerSeedDefaults({ seedDir }).freeTime).toEqual({
        ...DEFAULT_FREE_TIME_CONFIG,
        returnNote: { summaryMaxTokens: 96 },
      });

      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), {
        ...buildValidSchedulerConfig(),
        freeTime: { returnNote: { summaryMaxTokens: 0 } },
      });
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        'freeTime.returnNote.summaryMaxTokens must be an integer >= 1',
      );

      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), {
        ...buildValidSchedulerConfig(),
        freeTime: { returnNote: 'tiny' },
      });
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        'freeTime.returnNote must be an object',
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

  it('fails before startup when the relative background cadence can phase-lock outside the rest window', () => {
    withSeedDir((seedDir) => {
      const config = buildValidSchedulerConfig();
      config.backgroundMaintenance = {
        ...(config.backgroundMaintenance as Record<string, unknown>),
        intervalMs: 8 * 60 * 60_000 + 29 * 60_000,
      };
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), config);

      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        /backgroundMaintenance\.intervalMs.*plus tickIntervalMs.*must be less than.*rest-window duration.*phase-lock/s,
      );
    });
  });

  it('does not impose the rest-window coverage invariant when episodic processing is disabled', () => {
    withSeedDir((seedDir) => {
      const config = buildValidSchedulerConfig();
      config.backgroundMaintenance = {
        ...(config.backgroundMaintenance as Record<string, unknown>),
        intervalMs: 24 * 60 * 60_000,
      };
      config.episodicProcessing = {
        ...(config.episodicProcessing as Record<string, unknown>),
        enabled: false,
      };
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), config);

      expect(loadSchedulerSeedDefaults({ seedDir }).backgroundMaintenance.intervalMs)
        .toBe(24 * 60 * 60_000);
    });
  });

  it('allows any relative cadence when equal rest-window endpoints mean all day', () => {
    withSeedDir((seedDir) => {
      const config = buildValidSchedulerConfig();
      config.backgroundMaintenance = {
        ...(config.backgroundMaintenance as Record<string, unknown>),
        intervalMs: 48 * 60 * 60_000,
      };
      config.episodicProcessing = {
        ...(config.episodicProcessing as Record<string, unknown>),
        startLocalTime: '00:00',
        endLocalTime: '00:00',
      };
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), config);

      expect(loadSchedulerSeedDefaults({ seedDir }).backgroundMaintenance.intervalMs)
        .toBe(48 * 60 * 60_000);
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

  // ── zet.7: episodic tuning knobs owned by scheduler.json ──
  it('defaults the zet.7 episodic tuning knobs when keys are absent (compiled defaults preserved)', () => {
    withSeedDir((seedDir) => {
      const config = buildValidSchedulerConfig();
      const episodeSynthesis = { ...(config.episodeSynthesis as Record<string, unknown>) };
      delete episodeSynthesis.maxPriorCandidates;
      config.episodeSynthesis = episodeSynthesis;
      const sleepConsolidation = { ...(config.sleepConsolidation as Record<string, unknown>) };
      delete sleepConsolidation.transcriptMessageLimit;
      delete sleepConsolidation.maxTranscriptCharsPerEpisode;
      config.sleepConsolidation = sleepConsolidation;
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), config);

      const loaded = loadSchedulerSeedDefaults({ seedDir });
      // Mirrors DEFAULT_MAX_PRIOR_CANDIDATES (synthesis.ts),
      // DEFAULT_TRANSCRIPT_MESSAGE_LIMIT and DEFAULT_MAX_TRANSCRIPT_CHARS
      // (sleep-consolidation.ts) exactly.
      expect(loaded.episodeSynthesis.maxPriorCandidates).toBe(24);
      expect(loaded.sleepConsolidation.transcriptMessageLimit).toBe(200);
      expect(loaded.sleepConsolidation.maxTranscriptCharsPerEpisode).toBe(6000);
    });
  });

  it('threads operator-set zet.7 episodic tuning values and fails closed on invalid ones', () => {
    withSeedDir((seedDir) => {
      const config = buildValidSchedulerConfig();
      config.episodeSynthesis = {
        ...(config.episodeSynthesis as Record<string, unknown>),
        maxPriorCandidates: 48,
      };
      config.sleepConsolidation = {
        ...(config.sleepConsolidation as Record<string, unknown>),
        transcriptMessageLimit: 120,
        maxTranscriptCharsPerEpisode: 9000,
      };
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), config);

      const loaded = loadSchedulerSeedDefaults({ seedDir });
      expect(loaded.episodeSynthesis.maxPriorCandidates).toBe(48);
      expect(loaded.sleepConsolidation.transcriptMessageLimit).toBe(120);
      expect(loaded.sleepConsolidation.maxTranscriptCharsPerEpisode).toBe(9000);
    });

    withSeedDir((seedDir) => {
      const config = buildValidSchedulerConfig();
      config.sleepConsolidation = {
        ...(config.sleepConsolidation as Record<string, unknown>),
        transcriptMessageLimit: 0,
      };
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), config);
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        'sleepConsolidation.transcriptMessageLimit must be an integer >= 1',
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

  describe('tool-usage evaluator config (b0yl.5)', () => {
    it('is absent by default and loads a valid opt-in block', () => {
      withSeedDir((seedDir) => {
        writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), buildValidSchedulerConfig());
        expect(loadSchedulerSeedDefaults({ seedDir }).toolUsageEvaluator).toBeUndefined();

        writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), {
          ...buildValidSchedulerConfig(),
          toolUsageEvaluator: {
            enabled: true,
            intervalMs: 21_600_000,
            usageWindow: 'month',
            minPinSuggestionInvocations: 25,
          },
        });
        expect(loadSchedulerSeedDefaults({ seedDir }).toolUsageEvaluator).toEqual({
          enabled: true,
          intervalMs: 21_600_000,
          usageWindow: 'month',
          minPinSuggestionInvocations: 25,
        });
      });
    });

    it('fails closed on an unsupported usage window', () => {
      withSeedDir((seedDir) => {
        writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), {
          ...buildValidSchedulerConfig(),
          toolUsageEvaluator: {
            enabled: true,
            intervalMs: 21_600_000,
            usageWindow: 'custom',
            minPinSuggestionInvocations: 25,
          },
        });
        expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
          'toolUsageEvaluator.usageWindow must be one of',
        );
      });
    });
  });
});

describe('social-autonomy owner-file config (jp36.8.2)', () => {
  it('checks the bundled seed in with the exact code defaults (byte-identical)', () => {
    expect(loadSchedulerSeedDefaults().socialAutonomy).toEqual(DEFAULT_SOCIAL_AUTONOMY_CONFIG);
  });

  it('defaults the whole block when socialAutonomy is absent', () => {
    const config = buildValidSchedulerConfig();
    expect(config).not.toHaveProperty('socialAutonomy');
    const validated = validateSchedulerConfig(config, 'test');
    expect(validated.socialAutonomy).toEqual(DEFAULT_SOCIAL_AUTONOMY_CONFIG);
  });

  it('applies overrides for each sub-block', () => {
    const validated = validateSchedulerConfig(
      {
        ...buildValidSchedulerConfig(),
        socialAutonomy: {
          passiveNameCandidate: {
            defaultAutonomyLevel: 'directed',
            channelAutonomyLevels: { 'channel-a': 'social', 'channel-b': 'off' },
            debounceWindowMs: 0,
          },
          appraiser: { appraisalDeadlineMs: 5_000 },
          reservationPhase: { minReserveDrawUnits: 0 },
          egressLease: { leaseTtlMs: 30_000, minReplyConfidence: 0 },
          freeTimeChooser: { silencePersistenceMinutes: 0, projectListCap: 0 },
        },
      },
      'test',
    );
    expect(validated.socialAutonomy.passiveNameCandidate.defaultAutonomyLevel).toBe('directed');
    expect(validated.socialAutonomy.passiveNameCandidate.channelAutonomyLevels).toEqual({
      'channel-a': 'social',
      'channel-b': 'off',
    });
    // Non-positive debounce is a valid "disable debounce" state.
    expect(validated.socialAutonomy.passiveNameCandidate.debounceWindowMs).toBe(0);
    expect(validated.socialAutonomy.appraiser.appraisalDeadlineMs).toBe(5_000);
    expect(validated.socialAutonomy.reservationPhase.minReserveDrawUnits).toBe(0);
    expect(validated.socialAutonomy.egressLease.leaseTtlMs).toBe(30_000);
    expect(validated.socialAutonomy.egressLease.minReplyConfidence).toBe(0);
    expect(validated.socialAutonomy.freeTimeChooser.silencePersistenceMinutes).toBe(0);
    expect(validated.socialAutonomy.freeTimeChooser.projectListCap).toBe(0);
  });

  it('never exposes an egress-lease enablement override (qgqw.3)', () => {
    expect(DEFAULT_SOCIAL_AUTONOMY_CONFIG.egressLease).not.toHaveProperty('enabled');
    expect(() =>
      validateSchedulerConfig(
        {
          ...buildValidSchedulerConfig(),
          socialAutonomy: { egressLease: { enabled: true } },
        },
        'test',
      ),
    ).toThrow(/socialAutonomy\.egressLease contains unknown keys: enabled/u);
  });

  it('fails closed on wrong types, unknown keys, and out-of-range values', () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ socialAutonomy: 'nope' }, /socialAutonomy must be an object/u],
      [{ socialAutonomy: { unknownBlock: {} } }, /socialAutonomy contains unknown keys: unknownBlock/u],
      [
        { socialAutonomy: { passiveNameCandidate: { enabled: 'yes' } } },
        /passiveNameCandidate\.enabled must be a boolean/u,
      ],
      [
        { socialAutonomy: { passiveNameCandidate: { defaultAutonomyLevel: 'loud' } } },
        /passiveNameCandidate\.defaultAutonomyLevel must be one of/u,
      ],
      [
        { socialAutonomy: { passiveNameCandidate: { channelAutonomyLevels: { c: 'loud' } } } },
        /passiveNameCandidate\.channelAutonomyLevels\.c must be one of/u,
      ],
      [
        { socialAutonomy: { appraiser: { appraisalDeadlineMs: 0 } } },
        /appraiser\.appraisalDeadlineMs must be a finite integer >= 1/u,
      ],
      [
        { socialAutonomy: { reservationPhase: { minReserveDrawUnits: -1 } } },
        /reservationPhase\.minReserveDrawUnits must be a finite number >= 0/u,
      ],
      [
        { socialAutonomy: { egressLease: { egressDrawUnits: 0 } } },
        /egressLease\.egressDrawUnits must be a finite number > 0/u,
      ],
      [
        { socialAutonomy: { egressLease: { minReplyConfidence: 1.5 } } },
        /egressLease\.minReplyConfidence must be a finite number between 0 and 1/u,
      ],
      [
        { socialAutonomy: { freeTimeChooser: { silencePersistenceMinutes: -5 } } },
        /freeTimeChooser\.silencePersistenceMinutes must be a finite integer >= 0/u,
      ],
      [
        { socialAutonomy: { freeTimeChooser: { chooserDeadlineMs: 1.5 } } },
        /freeTimeChooser\.chooserDeadlineMs must be a finite integer >= 1/u,
      ],
    ];
    for (const [override, pattern] of cases) {
      expect(() =>
        validateSchedulerConfig({ ...buildValidSchedulerConfig(), ...override }, 'test'),
      ).toThrow(pattern);
    }
  });
});
