// psfn-framework-bxnyu — boot-time adaptation of owner files that predate a
// required contract field.
//
// Both new required blocks of this slice are written into an existing owner
// file only by the Helm seed init container (migrate-required-settings-blocks,
// migrate-scheduler-owner). A deployment that manages its owner files itself —
// bare docker, compose, a custom operator — never runs those steps, and every
// process then failed closed on a key the file could not have known about.
// These tests pin the in-memory adaptation that replaces that crash loop, and
// the two things it must NOT do: touch the owner file, or paper over a real
// migration.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  clearDiagnosticLogRingBufferForTests,
  getRecentDiagnosticLogRecords,
} from '../../shared/logger.js';
import { invalidateCachedJsonValue } from './load-or-seed.js';
import {
  applyMissingRuntimeSettingsDefaults,
  resetRuntimeSettingsDefaultAdaptationWarnings,
} from './settings-owner-backfill.js';
import {
  adaptSchedulerOwnerToCurrentContract,
  resetSchedulerOwnerAdaptationWarnings,
} from './scheduler-owner-defaults.js';
import { loadStartupRuntimeSettingsOwnerFile } from './startup-owner-files.js';
import { loadSchedulerConfig, SCHEDULER_FILE_NAME } from './scheduler-config.js';
import { DEFAULT_HUMAN_ESCALATION_CONFIG } from './scheduler-config/human-escalation.js';
import { SETTINGS_FILE_NAME } from '../settings/contracts.js';

const SEED_DIR = join(process.cwd(), 'config');

/**
 * Every settings.json field this slice made required. `requirePostgresStore-
 * ReadinessRetry` and `requireSharedWorkspaceListBounds` both throw at
 * composition when their field is absent, which is the fail-closed boot the
 * adaptation exists to prevent.
 */
const REQUIRED_FIELDS_ADDED_THIS_SLICE = [
  'postgresStoreReadinessRetryAttempts',
  'postgresStoreReadinessRetryBackoffMs',
  'sharedWorkspaceListPageSize',
  'sharedWorkspaceListPageBytes',
] as const;

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function readSeed(fileName: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(SEED_DIR, fileName), 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  clearDiagnosticLogRingBufferForTests();
  resetRuntimeSettingsDefaultAdaptationWarnings();
  resetSchedulerOwnerAdaptationWarnings();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('settings owner-file contract adaptation', () => {
  it('resolves the required fields an owner file predates without touching it', () => {
    const dataDir = makeTempDir('psfn-settings-adaptation-');
    const ownerPath = join(dataDir, SETTINGS_FILE_NAME);
    const seed = readSeed('settings.seed.json');
    const expected: Record<string, unknown> = {};
    for (const field of REQUIRED_FIELDS_ADDED_THIS_SLICE) {
      expected[field] = seed[field];
      delete seed[field];
    }
    const ownerBytes = `${JSON.stringify(seed, null, 2)}\n`;
    writeFileSync(ownerPath, ownerBytes, 'utf8');
    invalidateCachedJsonValue(ownerPath);

    const loaded = loadStartupRuntimeSettingsOwnerFile({ dataDir, seedDir: SEED_DIR });

    for (const field of REQUIRED_FIELDS_ADDED_THIS_SLICE) {
      expect(loaded.runtimeSettings[field]).toBe(expected[field]);
      // The runtime-owned projection is what boot applies to SubstrateConfig.
      expect(loaded.settingsDomains.runtime[field]).toBe(expected[field]);
    }
    // In memory only: the fleet Garden mounts companion data read-only and
    // every app container runs a read-only root filesystem, so a boot that
    // rewrote the owner file would trade one crash loop for another.
    expect(readFileSync(ownerPath, 'utf8')).toBe(ownerBytes);
  });

  it('warns once, naming every adapted field and no value', () => {
    const settings = readSeed('settings.seed.json');
    settings.sessionHistoryBudgetPct = 41;
    for (const field of REQUIRED_FIELDS_ADDED_THIS_SLICE) delete settings[field];

    const first = applyMissingRuntimeSettingsDefaults(settings, {
      seedDir: SEED_DIR,
      sourceLabel: SETTINGS_FILE_NAME,
    });
    applyMissingRuntimeSettingsDefaults(settings, {
      seedDir: SEED_DIR,
      sourceLabel: SETTINGS_FILE_NAME,
    });

    // The operator's own value is authoritative; only absent keys are filled.
    expect(first.sessionHistoryBudgetPct).toBe(41);
    const warnings = getRecentDiagnosticLogRecords({ limit: 50 })
      .filter(record => record.component === 'SettingsOwnerBackfill');
    expect(warnings).toHaveLength(1);
    const [warning] = warnings;
    expect(warning?.level).toBe('warn');
    // Every adapted field is named, and nothing else is: no value reaches the
    // message, and the ring keeps it whole rather than truncating it away.
    for (const field of REQUIRED_FIELDS_ADDED_THIS_SLICE) {
      expect(warning?.message).toContain(field);
    }
    expect(warning?.message).not.toContain('[truncated]');
    expect(warning?.message).toContain('migrate-required-settings-blocks');
  });

  it('leaves a complete owner file untouched and silent', () => {
    const settings = readSeed('settings.seed.json');

    const adapted = applyMissingRuntimeSettingsDefaults(settings, {
      seedDir: SEED_DIR,
      sourceLabel: SETTINGS_FILE_NAME,
    });

    expect(adapted).toBe(settings);
    expect(
      getRecentDiagnosticLogRecords({ limit: 50 })
        .filter(record => record.component === 'SettingsOwnerBackfill'),
    ).toHaveLength(0);
  });
});

describe('scheduler owner-file contract adaptation', () => {
  function writeSchedulerOwner(mutate: (owner: Record<string, unknown>) => void): {
    dataDir: string;
    ownerPath: string;
    ownerBytes: string;
  } {
    const dataDir = makeTempDir('psfn-scheduler-adaptation-');
    const ownerPath = join(dataDir, SCHEDULER_FILE_NAME);
    const owner = readSeed('scheduler.seed.json');
    mutate(owner);
    const ownerBytes = `${JSON.stringify(owner, null, 2)}\n`;
    writeFileSync(ownerPath, ownerBytes, 'utf8');
    invalidateCachedJsonValue(ownerPath);
    return { dataDir, ownerPath, ownerBytes };
  }

  it('boots an owner file whose humanEscalation block predates retention', () => {
    // The exact shape psfn-framework-yu03d created: operators already had the
    // block, and `retention` was added to it afterwards.
    const { dataDir, ownerPath, ownerBytes } = writeSchedulerOwner((owner) => {
      const humanEscalation = owner.humanEscalation as Record<string, unknown>;
      delete humanEscalation.retention;
      humanEscalation.listLimit = 25;
    });

    const loaded = loadSchedulerConfig(dataDir, { seedDir: SEED_DIR });

    expect(loaded.humanEscalation.retention)
      .toEqual(DEFAULT_HUMAN_ESCALATION_CONFIG.retention);
    // The operator's own value survives the adaptation.
    expect(loaded.humanEscalation.listLimit).toBe(25);
    expect(readFileSync(ownerPath, 'utf8')).toBe(ownerBytes);

    const warnings = getRecentDiagnosticLogRecords({ limit: 50 })
      .filter(record => record.component === 'SchedulerOwnerDefaults');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.level).toBe('warn');
    expect(warnings[0]?.message).toContain('humanEscalation.retention');
    expect(warnings[0]?.message).toContain('migrate:scheduler-owner');
    expect(warnings[0]?.message).not.toContain('[truncated]');
  });

  it('boots an owner file with no humanEscalation block at all', () => {
    const { dataDir } = writeSchedulerOwner((owner) => {
      delete owner.humanEscalation;
    });

    expect(loadSchedulerConfig(dataDir, { seedDir: SEED_DIR }).humanEscalation)
      .toEqual(DEFAULT_HUMAN_ESCALATION_CONFIG);
  });

  it('declines a retired-cadence owner file so the real migration still runs', () => {
    // A pre-bundled cadence is a rewrite with an ambiguity only the CLI
    // resolves. Adapting it silently would hide a migration behind a warning.
    const raw = {
      salienceDecayIntervalMs: 900_000,
      humanEscalation: { listLimit: 25 },
    };

    expect(adaptSchedulerOwnerToCurrentContract(raw, 'scheduler.json')).toBe(raw);
    expect(
      getRecentDiagnosticLogRecords({ limit: 50 })
        .filter(record => record.component === 'SchedulerOwnerDefaults'),
    ).toHaveLength(0);
  });

  it('leaves a complete owner file untouched and silent', () => {
    const raw = readSeed('scheduler.seed.json');

    expect(adaptSchedulerOwnerToCurrentContract(raw, 'scheduler.json')).toBe(raw);
    expect(
      getRecentDiagnosticLogRecords({ limit: 50 })
        .filter(record => record.component === 'SchedulerOwnerDefaults'),
    ).toHaveLength(0);
  });
});
