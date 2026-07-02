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

describe('scheduler config seed defaults', () => {
  it('reads seed defaults without requiring a data directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'scheduler-seed-defaults-'));
    const seedDir = join(root, 'seed');
    mkdirSync(seedDir, { recursive: true });

    try {
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), {
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
        sleeptime: {
          direct: { cadenceTurns: 5 },
          group: { minIntervalMinutes: 20, minNewEntries: 12 },
        },
        socialGraphBuilder: {
          intervalMs: 900_000,
          coPresenceMinSessions: 4,
          coPresenceWindowMinutes: 720,
          scanMemoryLimit: 250,
        },
      });

      expect(loadSchedulerSeedDefaults({ seedDir })).toEqual({
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
        sleeptime: {
          direct: { cadenceTurns: 5 },
          group: { minIntervalMinutes: 20, minNewEntries: 12 },
        },
        socialGraphBuilder: {
          intervalMs: 900_000,
          coPresenceMinSessions: 4,
          coPresenceWindowMinutes: 720,
          scanMemoryLimit: 250,
        },
        temporalWakeup: DEFAULT_TEMPORAL_WAKEUP_CONFIG,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies temporalWakeup overrides and fails closed on malformed wake time', () => {
    const root = mkdtempSync(join(tmpdir(), 'scheduler-temporal-wakeup-'));
    const seedDir = join(root, 'seed');
    mkdirSync(seedDir, { recursive: true });

    const baseSeed = {
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
      sleeptime: {
        direct: { cadenceTurns: 5 },
        group: { minIntervalMinutes: 20, minNewEntries: 12 },
      },
    };

    try {
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), {
        ...baseSeed,
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
        ...baseSeed,
        temporalWakeup: {
          morningWake: { localTime: '25:00' },
        },
      });
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        'temporalWakeup.morningWake.localTime must be HH:mm local time',
      );

      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), {
        ...baseSeed,
        temporalWakeup: {
          morningWake: { timezone: 'America/New_York' },
        },
      });
      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        'temporalWakeup.morningWake.timezone must be "local" or "utc"',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed on malformed rest-window config', () => {
    const root = mkdtempSync(join(tmpdir(), 'scheduler-rest-window-invalid-'));
    const seedDir = join(root, 'seed');
    mkdirSync(seedDir, { recursive: true });

    try {
      writeJson(join(seedDir, SCHEDULER_SEED_FILE_NAME), {
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
          startLocalTime: '24:00',
          endLocalTime: '09:00',
          timeZone: 'Mars/Base',
          inactivityThresholdMinutes: 0,
        },
      });

      expect(() => loadSchedulerSeedDefaults({ seedDir })).toThrow(
        'episodicProcessing.startLocalTime must be HH:mm local time',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
