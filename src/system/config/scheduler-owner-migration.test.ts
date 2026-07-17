import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BACKGROUND_WORK_TUNING,
  DEFAULT_BACKGROUND_MAINTENANCE_CONFIG,
  loadSchedulerConfig,
  SCHEDULER_FILE_NAME,
} from './scheduler-config.js';
import { migrateLegacySchedulerOwner } from './scheduler-owner-migration.js';

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'scheduler.pre-bundled-owner.json',
);
let tempDir: string | null = null;

function prepareOwner(mutator?: (owner: Record<string, unknown>) => void): {
  dataDir: string;
  filePath: string;
  original: Record<string, unknown>;
} {
  tempDir = mkdtempSync(join(tmpdir(), 'scheduler-owner-migration-'));
  const filePath = join(tempDir, SCHEDULER_FILE_NAME);
  const original = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>;
  mutator?.(original);
  writeFileSync(filePath, `${JSON.stringify(original, null, 2)}\n`, 'utf8');
  return { dataDir: tempDir, filePath, original };
}

function makePreCaretakerCanonical(owner: Record<string, unknown>): void {
  delete owner.salienceDecayIntervalMs;
  if (typeof owner.socialGraphBuilder === 'object' && owner.socialGraphBuilder !== null) {
    delete (owner.socialGraphBuilder as Record<string, unknown>).intervalMs;
  }
  owner.backgroundMaintenance = structuredClone(DEFAULT_BACKGROUND_MAINTENANCE_CONFIG);
  delete (owner.backgroundMaintenance as Record<string, unknown>).sharedWorldWikiCaretaker;
}

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('migrateLegacySchedulerOwner', () => {
  it('CLI requires an explicit companion owner root even when layout env is configured', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scheduler-owner-cli-'));
    const dataDir = join(tempDir, 'data');
    const systemDataDir = join(tempDir, 'system-data');
    const companionDataDir = join(tempDir, 'companion-data');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(companionDataDir, { recursive: true });
    const legacyBytes = readFileSync(fixturePath, 'utf8');
    writeFileSync(join(dataDir, SCHEDULER_FILE_NAME), legacyBytes, 'utf8');
    writeFileSync(join(systemDataDir, SCHEDULER_FILE_NAME), legacyBytes, 'utf8');
    writeFileSync(join(companionDataDir, SCHEDULER_FILE_NAME), legacyBytes, 'utf8');
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

    const result = spawnSync(
      resolve(repoRoot, 'node_modules/.bin/tsx'),
      [resolve(repoRoot, 'src/app/maintenance/migrate-scheduler-owner.ts'), '--apply'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          PSFN_SKIP_DOTENV: 'true',
          DATA_DIR: dataDir,
          SYSTEM_DATA_DIR: systemDataDir,
          COMPANION_DATA_DIR: companionDataDir,
        },
      },
    );

    expect(result.status, `${result.stderr}${result.stdout}`).toBe(1);
    expect(`${result.stderr}${result.stdout}`).toContain('--data-dir is required');
    expect(readFileSync(join(dataDir, SCHEDULER_FILE_NAME), 'utf8')).toBe(legacyBytes);
    expect(readFileSync(join(systemDataDir, SCHEDULER_FILE_NAME), 'utf8')).toBe(legacyBytes);
    expect(readFileSync(join(companionDataDir, SCHEDULER_FILE_NAME), 'utf8')).toBe(legacyBytes);
  });

  it('CLI migrates only the explicitly selected companion owner root', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'scheduler-owner-cli-explicit-'));
    const systemDataDir = join(tempDir, 'system-data');
    const companionDataDir = join(tempDir, 'companion-data');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(companionDataDir, { recursive: true });
    const legacyBytes = readFileSync(fixturePath, 'utf8');
    writeFileSync(join(systemDataDir, SCHEDULER_FILE_NAME), legacyBytes, 'utf8');
    writeFileSync(join(companionDataDir, SCHEDULER_FILE_NAME), legacyBytes, 'utf8');
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

    const result = spawnSync(
      resolve(repoRoot, 'node_modules/.bin/tsx'),
      [
        resolve(repoRoot, 'src/app/maintenance/migrate-scheduler-owner.ts'),
        '--apply',
        '--data-dir',
        companionDataDir,
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          PSFN_SKIP_DOTENV: 'true',
          SYSTEM_DATA_DIR: systemDataDir,
          COMPANION_DATA_DIR: companionDataDir,
        },
      },
    );

    expect(result.status, `${result.stderr}${result.stdout}`).toBe(0);
    expect(readFileSync(join(systemDataDir, SCHEDULER_FILE_NAME), 'utf8')).toBe(legacyBytes);
    expect(loadSchedulerConfig(companionDataDir).backgroundMaintenance.intervalMs).toBe(3_600_000);
  });

  it('dry-runs the deterministic pre-bundled owner without touching it', () => {
    const { dataDir, filePath } = prepareOwner();
    const before = readFileSync(filePath, 'utf8');

    expect(migrateLegacySchedulerOwner({ dataDir })).toMatchObject({
      mode: 'dry-run',
      status: 'planned',
      selectedIntervalMs: 3_600_000,
      selectedFrom: 'salienceDecayIntervalMs',
      legacyIntervals: {
        salienceDecayIntervalMs: 3_600_000,
        socialGraphBuilderIntervalMs: 1_800_000,
      },
      removedPaths: ['salienceDecayIntervalMs', 'socialGraphBuilder.intervalMs'],
    });
    expect(readFileSync(filePath, 'utf8')).toBe(before);
  });

  it('refuses a scheduler owner leaf symlink without importing or replacing its target', () => {
    const { dataDir, filePath } = prepareOwner();
    const otherCompanionDir = join(dataDir, 'other-companion');
    const otherCompanionOwner = join(otherCompanionDir, SCHEDULER_FILE_NAME);
    mkdirSync(otherCompanionDir);
    const targetBytes = readFileSync(filePath, 'utf8');
    writeFileSync(otherCompanionOwner, targetBytes, 'utf8');
    rmSync(filePath);
    symlinkSync(otherCompanionOwner, filePath);

    expect(() => migrateLegacySchedulerOwner({ dataDir, apply: true })).toThrow(
      /regular file without symlinks/,
    );
    expect(lstatSync(filePath).isSymbolicLink()).toBe(true);
    expect(readFileSync(otherCompanionOwner, 'utf8')).toBe(targetBytes);
  });

  it('refuses a symlinked data-directory ancestor without mutating its scheduler owner', () => {
    const { dataDir, filePath } = prepareOwner();
    const realCompanionDir = join(dataDir, 'real-companion');
    const linkedCompanionDir = join(dataDir, 'linked-companion');
    mkdirSync(realCompanionDir);
    const realOwnerPath = join(realCompanionDir, SCHEDULER_FILE_NAME);
    renameSync(filePath, realOwnerPath);
    symlinkSync(realCompanionDir, linkedCompanionDir);
    const before = readFileSync(realOwnerPath, 'utf8');

    expect(() => migrateLegacySchedulerOwner({
      dataDir: linkedCompanionDir,
      apply: true,
    })).toThrow(/directory without symlinks/);
    expect(readFileSync(realOwnerPath, 'utf8')).toBe(before);
  });

  it('fails closed and cleans its temporary when the pinned data directory path is swapped', () => {
    const { dataDir, filePath } = prepareOwner();
    const movedDataDir = `${dataDir}-moved`;
    const before = readFileSync(filePath, 'utf8');
    const replacementBytes = '{"replacement":true}\n';

    try {
      expect(() => migrateLegacySchedulerOwner({
        dataDir,
        apply: true,
        faultInjection: (stage) => {
          if (stage !== 'after_file_sync') return;
          renameSync(dataDir, movedDataDir);
          mkdirSync(dataDir);
          writeFileSync(filePath, replacementBytes, 'utf8');
        },
      })).toThrow(/changed identity/);

      expect(readFileSync(join(movedDataDir, SCHEDULER_FILE_NAME), 'utf8')).toBe(before);
      expect(readFileSync(filePath, 'utf8')).toBe(replacementBytes);
      expect(readdirSync(movedDataDir).filter(name => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      rmSync(movedDataDir, { recursive: true, force: true });
    }
  });

  it('validates then atomically applies once while preserving unrelated owner data', () => {
    const { dataDir, filePath, original } = prepareOwner((owner) => {
      owner.operatorExtension = { note: 'preserve me', enabled: true };
    });

    expect(migrateLegacySchedulerOwner({ dataDir, apply: true })).toMatchObject({
      mode: 'apply',
      status: 'applied',
      selectedIntervalMs: 3_600_000,
      selectedFrom: 'salienceDecayIntervalMs',
    });
    const migratedRaw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect(migratedRaw).not.toHaveProperty('salienceDecayIntervalMs');
    expect(migratedRaw.socialGraphBuilder).toEqual({
      coPresenceMinSessions: 3,
      coPresenceWindowMinutes: 1440,
      scanMemoryLimit: 500,
    });
    expect(migratedRaw.backgroundMaintenance).toEqual({
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
    expect(migratedRaw.temporalWakeup).toEqual(original.temporalWakeup);
    expect(migratedRaw.operatorExtension).toEqual(original.operatorExtension);
    expect(loadSchedulerConfig(dataDir).backgroundMaintenance.intervalMs).toBe(3_600_000);

    const inodeAfterApply = statSync(filePath).ino;
    const bytesAfterApply = readFileSync(filePath, 'utf8');
    expect(migrateLegacySchedulerOwner({ dataDir, apply: true })).toMatchObject({
      mode: 'apply',
      status: 'not_needed',
    });
    expect(readFileSync(filePath, 'utf8')).toBe(bytesAfterApply);
    expect(statSync(filePath).ino).toBe(inodeAfterApply);
  });

  it('explicitly plans and applies the shared-world caretaker schema addition', () => {
    const { dataDir, filePath } = prepareOwner((owner) => {
      makePreCaretakerCanonical(owner);
      owner.operatorExtension = { note: 'preserve me', enabled: true };
    });
    const before = readFileSync(filePath, 'utf8');

    expect(migrateLegacySchedulerOwner({ dataDir })).toMatchObject({
      mode: 'dry-run',
      status: 'planned',
      addedPaths: ['backgroundMaintenance.sharedWorldWikiCaretaker'],
    });
    expect(readFileSync(filePath, 'utf8')).toBe(before);

    expect(migrateLegacySchedulerOwner({ dataDir, apply: true })).toMatchObject({
      mode: 'apply',
      status: 'applied',
      addedPaths: ['backgroundMaintenance.sharedWorldWikiCaretaker'],
    });
    const migratedRaw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect(migratedRaw.operatorExtension).toEqual({ note: 'preserve me', enabled: true });
    expect(loadSchedulerConfig(dataDir).backgroundMaintenance.sharedWorldWikiCaretaker)
      .toEqual({ batchSize: 25 });
    expect(loadSchedulerConfig(dataDir).backgroundWork).toEqual(DEFAULT_BACKGROUND_WORK_TUNING);

    const inodeAfterApply = statSync(filePath).ino;
    const bytesAfterApply = readFileSync(filePath, 'utf8');
    expect(migrateLegacySchedulerOwner({ dataDir, apply: true })).toMatchObject({
      mode: 'apply',
      status: 'not_needed',
    });
    expect(readFileSync(filePath, 'utf8')).toBe(bytesAfterApply);
    expect(statSync(filePath).ino).toBe(inodeAfterApply);
  });

  it('explicitly adds background-work tuning to owners written before it existed', () => {
    const { dataDir, filePath } = prepareOwner((owner) => {
      delete owner.salienceDecayIntervalMs;
      if (typeof owner.socialGraphBuilder === 'object' && owner.socialGraphBuilder !== null) {
        delete (owner.socialGraphBuilder as Record<string, unknown>).intervalMs;
      }
      owner.backgroundMaintenance = structuredClone(DEFAULT_BACKGROUND_MAINTENANCE_CONFIG);
      delete owner.backgroundWork;
      owner.operatorExtension = { note: 'preserve me' };
    });

    expect(migrateLegacySchedulerOwner({ dataDir })).toMatchObject({
      mode: 'dry-run',
      status: 'planned',
      addedPaths: ['backgroundWork'],
    });
    expect(migrateLegacySchedulerOwner({ dataDir, apply: true })).toMatchObject({
      mode: 'apply',
      status: 'applied',
      addedPaths: ['backgroundWork'],
    });
    const migratedRaw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect(migratedRaw.backgroundWork).toEqual(DEFAULT_BACKGROUND_WORK_TUNING);
    expect(migratedRaw.operatorExtension).toEqual({ note: 'preserve me' });
    expect(migrateLegacySchedulerOwner({ dataDir, apply: true })).toMatchObject({
      status: 'not_needed',
    });
  });

  it('refuses a malformed shared-world caretaker instead of replacing it', () => {
    const { dataDir, filePath } = prepareOwner((owner) => {
      makePreCaretakerCanonical(owner);
      (owner.backgroundMaintenance as Record<string, unknown>).sharedWorldWikiCaretaker = null;
    });
    const before = readFileSync(filePath, 'utf8');

    expect(() => migrateLegacySchedulerOwner({ dataDir, apply: true })).toThrow(
      'backgroundMaintenance.sharedWorldWikiCaretaker must be an object',
    );
    expect(readFileSync(filePath, 'utf8')).toBe(before);
  });

  it.each([
    ['after_file_sync', 'legacy'],
    ['after_publish', 'canonical'],
    ['after_directory_sync', 'canonical'],
  ] as const)('publishes through the durable atomic %s boundary', (stage, expectedState) => {
    const { dataDir, filePath } = prepareOwner();
    const before = readFileSync(filePath, 'utf8');

    expect(() => migrateLegacySchedulerOwner({
      dataDir,
      apply: true,
      faultInjection: (currentStage) => {
        if (currentStage === stage) throw new Error(`crash:${stage}`);
      },
    })).toThrow(`crash:${stage}`);

    if (expectedState === 'legacy') {
      expect(readFileSync(filePath, 'utf8')).toBe(before);
      expect(migrateLegacySchedulerOwner({ dataDir })).toMatchObject({ status: 'planned' });
    } else {
      expect(loadSchedulerConfig(dataDir).backgroundMaintenance.intervalMs).toBe(3_600_000);
      expect(migrateLegacySchedulerOwner({ dataDir })).toMatchObject({ status: 'not_needed' });
    }
  });

  it('refuses a mixed legacy/canonical owner without changing its bytes', () => {
    const { dataDir, filePath } = prepareOwner((owner) => {
      owner.backgroundMaintenance = structuredClone(DEFAULT_BACKGROUND_MAINTENANCE_CONFIG);
    });
    const before = readFileSync(filePath, 'utf8');

    expect(() => migrateLegacySchedulerOwner({ dataDir, apply: true })).toThrow(
      /refuses a mixed shape/,
    );
    expect(readFileSync(filePath, 'utf8')).toBe(before);
  });

  it('falls back to the legacy social-graph cadence when no salience cadence exists', () => {
    const { dataDir } = prepareOwner((owner) => {
      delete owner.salienceDecayIntervalMs;
    });

    expect(migrateLegacySchedulerOwner({ dataDir, apply: true })).toMatchObject({
      status: 'applied',
      selectedIntervalMs: 1_800_000,
      selectedFrom: 'socialGraphBuilder.intervalMs',
    });
    expect(loadSchedulerConfig(dataDir).backgroundMaintenance.intervalMs).toBe(1_800_000);
  });

  it('refuses an invalid candidate before replacing the legacy owner file', () => {
    const { dataDir, filePath } = prepareOwner((owner) => {
      owner.salienceDecayIntervalMs = 999;
    });
    const before = readFileSync(filePath, 'utf8');

    expect(() => migrateLegacySchedulerOwner({ dataDir, apply: true })).toThrow(
      'backgroundMaintenance.intervalMs must be an integer >= 1000',
    );
    expect(readFileSync(filePath, 'utf8')).toBe(before);
  });
});
