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
  destination: string;
  staging: string;
}

async function createPendingRollback(
  failureStage: 'after_database_commit' | 'after_tree_publish' = 'after_database_commit',
): Promise<PendingRollbackFixture> {
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
      if (stage === failureStage) throw new Error('injected restore interruption');
    },
  };

  await expect(executeFleetRestoreTransaction(options)).rejects.toThrow(/durable rollback remains pending/);
  const journalName = readdirSync(join(root, 'restore'))
    .find(name => name.startsWith('.restore-operation-'));
  if (!journalName) throw new Error('Expected a durable restore journal');
  const journalPath = join(root, 'restore', journalName);
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    phase: string;
    trees: Array<{ staging: string }>;
  };
  expect(journal).toMatchObject({ phase: 'rolling_back' });
  return { options, root, journalPath, destination, staging: journal.trees[0].staging };
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

  it('never uses an absent marker to clean restore trees after marker-removal response loss', async () => {
    const fixture = await createPendingRollback('after_tree_publish');
    const calls = { rollback: 0, removeMarker: 0 };
    let treesGoneWhenMarkerRemoved = false;

    await expect(executeFleetRestoreTransaction({
      ...recoveryOptions(fixture, 'all', 'committed', calls),
      removeDatabaseOperation: async () => {
        calls.removeMarker += 1;
        treesGoneWhenMarkerRemoved = !existsSync(fixture.destination)
          && !existsSync(fixture.staging);
        throw new Error('injected lost marker-removal response');
      },
    })).rejects.toThrow(/lost marker-removal response/);
    expect(calls).toEqual({ rollback: 1, removeMarker: 1 });
    expect(treesGoneWhenMarkerRemoved).toBe(true);
    expect(existsSync(fixture.journalPath)).toBe(true);

    mkdirSync(fixture.destination, { recursive: true });
    const recreatedPath = join(fixture.destination, 'recreated.txt');
    writeFileSync(recreatedPath, 'new owner\n');
    const recoveryCalls = { rollback: 0, removeMarker: 0 };
    await expect(executeFleetRestoreTransaction(recoveryOptions(
      fixture,
      'none',
      'absent',
      recoveryCalls,
    ))).rejects.toThrow(/no matching durable operation marker/);
    expect(recoveryCalls).toEqual({ rollback: 0, removeMarker: 0 });
    expect(readFileSync(recreatedPath, 'utf8')).toBe('new owner\n');
    expect(existsSync(fixture.journalPath)).toBe(true);
  });

  it('refuses an absent marker when schemas are absent but staged cleanup remains', async () => {
    const fixture = await createPendingRollback();
    const calls = { rollback: 0, removeMarker: 0 };
    await expect(executeFleetRestoreTransaction(recoveryOptions(
      fixture,
      'none',
      'absent',
      calls,
    ))).rejects.toThrow(/no matching durable operation marker/);
    expect(calls).toEqual({ rollback: 0, removeMarker: 0 });
    expect(existsSync(fixture.staging)).toBe(true);
    expect(existsSync(fixture.journalPath)).toBe(true);
  });

  it('removes only the journal after an absent marker when owned cleanup already completed', async () => {
    const fixture = await createPendingRollback();
    rmSync(fixture.staging, { recursive: true, force: true });
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

describe('executeFleetRestoreTransaction pre-commit cleanup', () => {
  it('retains its prepared marker until staged trees are removed', async () => {
    const root = join(tmpdir(), `fleet-restore-prepared-cleanup-${Date.now()}-${Math.random()}`);
    roots.push(root);
    const artifactDir = join(root, 'artifact');
    const source = join(artifactDir, 'tree');
    const destination = join(root, 'restore', 'destination');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'payload.txt'), 'payload\\n');
    let staging = '';
    let stagingGoneWhenMarkerRemoved = false;

    await expect(executeFleetRestoreTransaction({
      kind: 'companion',
      artifactDir,
      backupRootDir: join(root, 'backups'),
      dumpPath: join(artifactDir, 'database', 'scope.dump'),
      databaseTarget: 'postgresql://restore@127.0.0.1/runtime',
      expectedSchemas: ['companion_alpha'],
      specs: [{ treeDirName: 'tree', destination }],
      prepareStaging: trees => {
        staging = trees[0].staging;
      },
      assertTargetDatabaseSafe: async () => undefined,
      inspectDatabaseState: async () => 'none',
      inspectDatabaseOperation: async () => 'absent',
      prepareDatabaseOperation: async () => undefined,
      commitDatabaseOperation: async () => undefined,
      removeDatabaseOperation: async () => {
        stagingGoneWhenMarkerRemoved = !existsSync(staging);
      },
      restoreDatabase: async () => {
        throw new Error('injected database restore failure');
      },
      rollbackDatabase: async () => undefined,
    })).rejects.toThrow(/database restore failure/);

    expect(stagingGoneWhenMarkerRemoved).toBe(true);
    expect(existsSync(destination)).toBe(false);
    expect(readdirSync(join(root, 'restore'))).toEqual([]);
  });
});
