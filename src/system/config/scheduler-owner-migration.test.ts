import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSchedulerConfig, SCHEDULER_FILE_NAME } from './scheduler-config.js';
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

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('migrateLegacySchedulerOwner', () => {
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
