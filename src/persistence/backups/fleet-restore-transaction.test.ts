import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  executeFleetRestoreTransaction,
  type FleetRestoreDatabaseOperationState,
  type FleetRestoreTransactionOptions,
} from './fleet-restore-transaction.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface PendingRollbackFixture {
  options: FleetRestoreTransactionOptions;
  root: string;
  journalPath: string;
}

async function createPendingRollback(): Promise<PendingRollbackFixture> {
  const root = join(tmpdir(), `fleet-restore-rolling-back-${Date.now()}-${Math.random()}`);
  roots.push(root);
  const artifactDir = join(root, 'artifact');
  const source = join(artifactDir, 'tree');
  const destination = join(root, 'restore', 'destination');
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, 'payload.txt'), 'payload\n');
  const options: FleetRestoreTransactionOptions = {
    kind: 'companion',
    artifactDir,
    backupRootDir: join(root, 'backups'),
    dumpPath: join(artifactDir, 'database', 'scope.dump'),
    databaseTarget: 'postgresql://restore@127.0.0.1/runtime',
    expectedSchemas: ['companion_alpha'],
    specs: [{ treeDirName: 'tree', destination }],
    assertTargetDatabaseSafe: async () => undefined,
    inspectDatabaseState: async () => 'none',
    inspectDatabaseOperation: async () => 'absent',
    prepareDatabaseOperation: async () => undefined,
    commitDatabaseOperation: async () => undefined,
    removeDatabaseOperation: async () => undefined,
    restoreDatabase: async () => undefined,
    rollbackDatabase: async () => {
      throw new Error('injected rollback interruption');
    },
    faultInjection: (stage) => {
      if (stage === 'after_database_commit') throw new Error('injected restore interruption');
    },
  };

  await expect(executeFleetRestoreTransaction(options)).rejects.toThrow(/durable rollback remains pending/);
  const journalName = readdirSync(join(root, 'restore'))
    .find(name => name.startsWith('.restore-operation-'));
  if (!journalName) throw new Error('Expected a durable restore journal');
  const journalPath = join(root, 'restore', journalName);
  expect(JSON.parse(readFileSync(journalPath, 'utf8'))).toMatchObject({ phase: 'rolling_back' });
  return { options, root, journalPath };
}

function recoveryOptions(
  fixture: PendingRollbackFixture,
  databaseState: 'none' | 'all' | 'partial',
  markerState: FleetRestoreDatabaseOperationState,
  calls: { rollback: number; removeMarker: number },
): FleetRestoreTransactionOptions {
  return {
    ...fixture.options,
    assertTargetDatabaseSafe: async () => {
      throw new Error('recovery finalized');
    },
    inspectDatabaseState: async () => databaseState,
    inspectDatabaseOperation: async () => markerState,
    rollbackDatabase: async () => {
      calls.rollback += 1;
    },
    removeDatabaseOperation: async () => {
      calls.removeMarker += 1;
    },
    faultInjection: undefined,
  };
}

describe('executeFleetRestoreTransaction rolling-back recovery', () => {
  it.each(['prepared', 'committed'] as const)(
    'resumes destructive rollback only for its exact %s marker',
    async (markerState) => {
      const fixture = await createPendingRollback();
      const calls = { rollback: 0, removeMarker: 0 };
      await expect(executeFleetRestoreTransaction(recoveryOptions(
        fixture,
        'all',
        markerState,
        calls,
      ))).rejects.toThrow(/recovery finalized/);
      expect(calls).toEqual({ rollback: 1, removeMarker: 1 });
      expect(existsSync(fixture.journalPath)).toBe(false);
    },
  );

  it('refuses a foreign marker without invoking either destructive callback', async () => {
    const fixture = await createPendingRollback();
    const calls = { rollback: 0, removeMarker: 0 };
    const entriesBefore = readdirSync(join(fixture.root, 'restore')).sort();
    await expect(executeFleetRestoreTransaction(recoveryOptions(
      fixture,
      'all',
      'foreign',
      calls,
    ))).rejects.toThrow(/marker.*inconsistent|destructive recovery/);
    expect(calls).toEqual({ rollback: 0, removeMarker: 0 });
    expect(existsSync(fixture.journalPath)).toBe(true);
    expect(readdirSync(join(fixture.root, 'restore')).sort()).toEqual(entriesBefore);
  });

  it('refuses an absent marker while expected schemas remain without invoking rollback', async () => {
    const fixture = await createPendingRollback();
    const calls = { rollback: 0, removeMarker: 0 };
    const entriesBefore = readdirSync(join(fixture.root, 'restore')).sort();
    await expect(executeFleetRestoreTransaction(recoveryOptions(
      fixture,
      'all',
      'absent',
      calls,
    ))).rejects.toThrow(/no matching durable operation marker/);
    expect(calls).toEqual({ rollback: 0, removeMarker: 0 });
    expect(existsSync(fixture.journalPath)).toBe(true);
    expect(readdirSync(join(fixture.root, 'restore')).sort()).toEqual(entriesBefore);
  });

  it('finalizes an absent marker without rollback only when expected schemas are already absent', async () => {
    const fixture = await createPendingRollback();
    const calls = { rollback: 0, removeMarker: 0 };
    await expect(executeFleetRestoreTransaction(recoveryOptions(
      fixture,
      'none',
      'absent',
      calls,
    ))).rejects.toThrow(/recovery finalized/);
    expect(calls).toEqual({ rollback: 0, removeMarker: 0 });
    expect(existsSync(fixture.journalPath)).toBe(false);
  });
});
