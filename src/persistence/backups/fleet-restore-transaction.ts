import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  ensureDirectoryDurableSync,
  fsyncDirectorySync,
  fsyncTreeSync,
  unlinkDurableSync,
  writeFileDurableAtomicSync,
} from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';
import { isStrictSubpath } from '../layout.js';
import type { FleetRestoreDatabaseOperation } from './fleet-restore-database-marker.js';

export type { FleetRestoreDatabaseOperation } from './fleet-restore-database-marker.js';

export type FleetRestoreKind = 'companion' | 'cluster' | 'group';
export type FleetRestoreFaultStage =
  | 'after_journal'
  | 'after_database_commit'
  | 'after_tree_publish'
  | 'after_rollback_marker_removal';

export interface FleetRestoreFaultInjectionOptions {
  /** Deterministic crash seam for recovery tests. */
  faultInjection?: (stage: FleetRestoreFaultStage, publishedTreeCount: number) => void;
}

export interface StagedRestoreTree {
  source: string;
  destination: string;
  staging: string;
  published: boolean;
}

export interface FleetRestoreTreeSpec {
  treeDirName: string;
  destination: string;
}

interface FleetRestoreJournal {
  schemaVersion: 1;
  operationId: string;
  operationIdentity: string;
  kind: FleetRestoreKind;
  artifactDir: string;
  dumpPath: string;
  databaseTarget: string;
  expectedSchemas: string[];
  phase: 'prepared' | 'database_committed' | 'rolling_back';
  trees: StagedRestoreTree[];
}

export interface FleetRestoreTransactionOptions extends FleetRestoreFaultInjectionOptions {
  kind: FleetRestoreKind;
  artifactDir: string;
  backupRootDir: string;
  dumpPath: string;
  databaseTarget: string;
  expectedSchemas: string[];
  specs: readonly FleetRestoreTreeSpec[];
  prepareStaging?: (trees: readonly StagedRestoreTree[]) => void;
  assertTargetDatabaseSafe: () => Promise<void>;
  inspectDatabaseState: () => Promise<'none' | 'all' | 'partial'>;
  inspectDatabaseOperation: (
    operation: FleetRestoreDatabaseOperation,
  ) => Promise<FleetRestoreDatabaseOperationState>;
  prepareDatabaseOperation: (operation: FleetRestoreDatabaseOperation) => Promise<void>;
  commitDatabaseOperation: (operation: FleetRestoreDatabaseOperation) => Promise<void>;
  removeDatabaseOperation: (operation: FleetRestoreDatabaseOperation) => Promise<void>;
  restoreDatabase: () => Promise<void>;
  rollbackDatabase: (operation: FleetRestoreDatabaseOperation) => Promise<void>;
}

export type FleetRestoreDatabaseOperationState = 'absent' | 'prepared' | 'committed' | 'foreign';

function pathsOverlap(first: string, second: string): boolean {
  return first === second || isStrictSubpath(first, second) || isStrictSubpath(second, first);
}

function resolveCanonicalDestination(destinationValue: string): string {
  const requested = resolve(destinationValue);
  let existingAncestor = requested;
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  return resolve(realpathSync(existingAncestor), relative(existingAncestor, requested));
}

function cleanupStagedTrees(staged: readonly StagedRestoreTree[]): void {
  for (const tree of staged) {
    if (!existsSync(tree.staging)) continue;
    rmSync(tree.staging, { recursive: true, force: true });
    fsyncDirectorySync(dirname(tree.staging));
  }
}

function cleanupPublishedTrees(staged: readonly StagedRestoreTree[]): void {
  for (const tree of staged) {
    const owned = tree.published
      || (!existsSync(tree.staging) && existsSync(tree.destination));
    if (!owned || !existsSync(tree.destination)) continue;
    rmSync(tree.destination, { recursive: true, force: true });
    fsyncDirectorySync(dirname(tree.destination));
  }
}

function resolveRestoreTrees(options: FleetRestoreTransactionOptions): StagedRestoreTree[] {
  const artifactDir = resolve(options.artifactDir);
  const backupRoot = resolve(options.backupRootDir);
  const resolvedSpecs = options.specs.map(spec => ({
    source: join(artifactDir, spec.treeDirName),
    destination: resolveCanonicalDestination(spec.destination),
  }));
  for (const spec of resolvedSpecs) {
    if (pathsOverlap(spec.destination, artifactDir) || pathsOverlap(spec.destination, backupRoot)) {
      throw new Error(`Fleet restore destination overlaps its immutable backup root: ${spec.destination}`);
    }
  }
  for (let index = 0; index < resolvedSpecs.length; index += 1) {
    for (let peer = index + 1; peer < resolvedSpecs.length; peer += 1) {
      if (pathsOverlap(resolvedSpecs[index].destination, resolvedSpecs[peer].destination)) {
        throw new Error('Fleet restore destinations must be distinct, non-overlapping roots');
      }
    }
  }
  return resolvedSpecs.map(spec => ({ ...spec, staging: '', published: false }));
}

function assertDestinationsDoNotExist(trees: readonly StagedRestoreTree[]): void {
  const collision = trees.find(tree => existsSync(tree.destination));
  if (collision) {
    throw new Error(
      `Fleet restore destination already exists; no-overwrite policy refuses collision: ${collision.destination}`,
    );
  }
}

function assertStagingDoesNotExist(trees: readonly StagedRestoreTree[]): void {
  const collision = trees.find(tree => existsSync(tree.staging));
  if (collision) {
    throw new Error(
      `Fleet restore staging path already exists without an authenticated restore journal: ${collision.staging}`,
    );
  }
}

function createRestoreDatabaseOperation(
  options: FleetRestoreTransactionOptions,
  trees: readonly StagedRestoreTree[],
): FleetRestoreDatabaseOperation {
  const operationIdentity = createHash('sha256').update(JSON.stringify({
    kind: options.kind,
    artifactDir: options.artifactDir,
    dumpPath: options.dumpPath,
    databaseTarget: options.databaseTarget,
    expectedSchemas: options.expectedSchemas,
    destinations: trees.map(tree => tree.destination),
  })).digest('hex');
  return { operationId: operationIdentity.slice(0, 32), operationIdentity };
}

function stageRestoreTrees(
  trees: readonly StagedRestoreTree[],
  operationId: string,
  prepareStaging?: (trees: readonly StagedRestoreTree[]) => void,
): StagedRestoreTree[] {
  const staged = trees.map(tree => ({
    ...tree,
    staging: join(dirname(tree.destination), `.${basename(tree.destination)}.restore-${operationId}`),
  }));
  const claimed: StagedRestoreTree[] = [];
  try {
    for (const tree of staged) {
      ensureDirectoryDurableSync(dirname(tree.destination));
      try {
        mkdirSync(tree.staging);
      } catch (error) {
        assertStagingDoesNotExist([tree]);
        throw error;
      }
      claimed.push(tree);
      cpSync(tree.source, tree.staging, { recursive: true, errorOnExist: true, force: false });
    }
    prepareStaging?.(staged);
    for (const tree of staged) {
      fsyncTreeSync(tree.staging);
      fsyncDirectorySync(dirname(tree.staging));
    }
    return staged;
  } catch (error) {
    cleanupStagedTrees(claimed);
    throw error;
  }
}

function restoreJournalPath(operationId: string, trees: readonly StagedRestoreTree[]): string {
  return join(dirname(trees[0].destination), `.restore-operation-${operationId}.json`);
}

function writeRestoreJournal(path: string, journal: FleetRestoreJournal, exclusive = false): void {
  writeFileDurableAtomicSync(path, `${JSON.stringify(journal, null, 2)}\n`, { exclusive });
}

function parseRestoreJournal(path: string, expected: FleetRestoreJournal): FleetRestoreJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`Fleet restore journal is missing or malformed: ${String(error)}`);
  }
  if (!isRecord(parsed)
    || parsed.schemaVersion !== 1
    || parsed.operationId !== expected.operationId
    || parsed.operationIdentity !== expected.operationIdentity
    || parsed.kind !== expected.kind
    || parsed.artifactDir !== expected.artifactDir
    || parsed.dumpPath !== expected.dumpPath
    || parsed.databaseTarget !== expected.databaseTarget
    || !Array.isArray(parsed.expectedSchemas)
    || JSON.stringify(parsed.expectedSchemas) !== JSON.stringify(expected.expectedSchemas)
    || (parsed.phase !== 'prepared'
      && parsed.phase !== 'database_committed'
      && parsed.phase !== 'rolling_back')
    || !Array.isArray(parsed.trees)
    || parsed.trees.length !== expected.trees.length) {
    throw new Error('Fleet restore journal does not match the requested restore');
  }
  const trees: StagedRestoreTree[] = parsed.trees.map((tree, index) => {
    const expectedTree = expected.trees[index];
    if (!isRecord(tree)
      || Object.keys(tree).sort().join(',') !== 'destination,published,source,staging'
      || tree.source !== expectedTree.source
      || tree.destination !== expectedTree.destination
      || tree.staging !== expectedTree.staging
      || typeof tree.published !== 'boolean') {
      throw new Error('Fleet restore journal tree does not match the requested restore');
    }
    return tree as unknown as StagedRestoreTree;
  });
  return { ...(parsed as unknown as FleetRestoreJournal), trees };
}

function removeRestoreJournal(path: string): void {
  if (existsSync(path)) unlinkDurableSync(path);
}

async function finishRestoreRollback(
  journalPath: string,
  journal: FleetRestoreJournal,
  operation: FleetRestoreDatabaseOperation,
  rollbackDatabase: (operation: FleetRestoreDatabaseOperation) => Promise<void>,
  removeDatabaseOperation: (operation: FleetRestoreDatabaseOperation) => Promise<void>,
  faultInjection?: FleetRestoreFaultInjectionOptions['faultInjection'],
): Promise<void> {
  await rollbackDatabase(operation);
  cleanupPublishedTrees(journal.trees);
  cleanupStagedTrees(journal.trees);
  await removeDatabaseOperation(operation);
  faultInjection?.('after_rollback_marker_removal', 0);
  removeRestoreJournal(journalPath);
}

export async function executeFleetRestoreTransaction(
  options: FleetRestoreTransactionOptions,
): Promise<{ restoredDestinations: string[] }> {
  const plannedTrees = resolveRestoreTrees(options);
  const operation = createRestoreDatabaseOperation(options, plannedTrees);
  const { operationId, operationIdentity } = operation;
  const expectedTrees = plannedTrees.map(tree => ({
    ...tree,
    staging: join(dirname(tree.destination), `.${basename(tree.destination)}.restore-${operationId}`),
  }));
  const journalPath = restoreJournalPath(operationId, expectedTrees);
  const expectedJournal: FleetRestoreJournal = {
    schemaVersion: 1,
    operationId,
    operationIdentity,
    kind: options.kind,
    artifactDir: options.artifactDir,
    dumpPath: options.dumpPath,
    databaseTarget: options.databaseTarget,
    expectedSchemas: options.expectedSchemas,
    phase: 'prepared',
    trees: expectedTrees,
  };

  if (existsSync(journalPath)) {
    const interrupted = parseRestoreJournal(journalPath, expectedJournal);
    if (interrupted.phase === 'rolling_back') {
      const markerState = await options.inspectDatabaseOperation(operation);
      if (markerState === 'prepared' || markerState === 'committed') {
        await finishRestoreRollback(
          journalPath,
          interrupted,
          operation,
          options.rollbackDatabase,
          options.removeDatabaseOperation,
          options.faultInjection,
        );
        return await executeFleetRestoreTransaction(options);
      }
      if (markerState === 'foreign') {
        throw new Error(
          'Fleet restore journal and database operation marker are inconsistent; refusing destructive recovery',
        );
      }
      const databaseState = await options.inspectDatabaseState();
      if (databaseState !== 'none') {
        throw new Error('Fleet restore database state has no matching durable operation marker');
      }
      const ownedCleanupComplete = interrupted.trees.every(tree => (
        !existsSync(tree.destination) && !existsSync(tree.staging)
      ));
      if (!ownedCleanupComplete) {
        throw new Error(
          'Fleet restore rollback has no matching durable operation marker; refusing filesystem cleanup',
        );
      }
      // The exact marker is removed only after database and filesystem
      // rollback are durable. With every owned path already absent, only the
      // journal response remains to finalize.
      removeRestoreJournal(journalPath);
      return await executeFleetRestoreTransaction(options);
    }
  }

  let journal: FleetRestoreJournal;
  const recovering = existsSync(journalPath);
  if (recovering) {
    journal = parseRestoreJournal(journalPath, expectedJournal);
  } else {
    assertDestinationsDoNotExist(plannedTrees);
    assertStagingDoesNotExist(expectedTrees);
    await options.assertTargetDatabaseSafe();
    // Database preflight invokes external tooling, so recheck filesystem
    // collisions immediately before recording intent and touching Postgres.
    assertDestinationsDoNotExist(plannedTrees);
    assertStagingDoesNotExist(expectedTrees);
    journal = {
      ...expectedJournal,
      trees: stageRestoreTrees(plannedTrees, operationId, options.prepareStaging),
    };
    writeRestoreJournal(journalPath, journal, true);
    options.faultInjection?.('after_journal', 0);
  }

  let databaseCommitted = journal.phase === 'database_committed';
  let markerPrepared = false;
  let preserveJournal = false;
  try {
    let databaseState: 'none' | 'all' | 'partial';
    let markerState: FleetRestoreDatabaseOperationState;
    try {
      databaseState = await options.inspectDatabaseState();
      markerState = await options.inspectDatabaseOperation(operation);
    } catch (error) {
      preserveJournal = true;
      throw error;
    }
    if (!recovering && (databaseState !== 'none' || markerState !== 'absent')) {
      preserveJournal = true;
      throw new Error('Fresh fleet restore observed unrelated database state; refusing to claim it as restored');
    }
    if (markerState === 'foreign' || databaseState === 'partial') {
      preserveJournal = true;
      throw new Error('Fleet restore journal and database operation marker are inconsistent; refusing destructive recovery');
    }

    const fullyPublished = journal.trees.every(tree => (
      tree.published && existsSync(tree.destination) && !existsSync(tree.staging)
    ));
    if (recovering && markerState === 'absent') {
      if (journal.phase === 'database_committed' && databaseState === 'all' && fullyPublished) {
        preserveJournal = true;
        removeRestoreJournal(journalPath);
        return { restoredDestinations: journal.trees.map(tree => tree.destination) };
      }
      if (journal.phase !== 'prepared' || databaseState !== 'none') {
        preserveJournal = true;
        throw new Error('Fleet restore database state has no matching durable operation marker');
      }
    }

    if (markerState === 'absent') {
      try {
        await options.prepareDatabaseOperation(operation);
        markerState = 'prepared';
      } catch (error) {
        preserveJournal = true;
        throw error;
      }
    }
    markerPrepared = true;

    if (journal.phase === 'prepared') {
      if (databaseState === 'none') {
        if (markerState !== 'prepared') {
          preserveJournal = true;
          throw new Error('Fleet restore database marker is not prepared for restore');
        }
        assertDestinationsDoNotExist(journal.trees);
        await options.restoreDatabase();
        databaseCommitted = true;
        await options.commitDatabaseOperation(operation);
        markerState = 'committed';
        options.faultInjection?.('after_database_commit', 0);
      } else {
        databaseCommitted = true;
        if (markerState === 'prepared') {
          await options.commitDatabaseOperation(operation);
          markerState = 'committed';
        }
      }
      journal.phase = 'database_committed';
      writeRestoreJournal(journalPath, journal);
    } else if (databaseState !== 'all' || markerState !== 'committed') {
      preserveJournal = true;
      throw new Error('Fleet restore committed journal does not match its database marker');
    }

    for (let index = 0; index < journal.trees.length; index += 1) {
      const tree = journal.trees[index];
      const destinationExists = existsSync(tree.destination);
      const stagingExists = existsSync(tree.staging);
      if (tree.published || (destinationExists && !stagingExists)) {
        if (!destinationExists || stagingExists) {
          preserveJournal = true;
          throw new Error('Fleet restore published-tree journal state is inconsistent; refusing destructive recovery');
        }
        if (!tree.published) {
          fsyncDirectorySync(dirname(tree.destination));
          tree.published = true;
          writeRestoreJournal(journalPath, journal);
        }
        continue;
      }
      if (destinationExists || !stagingExists) {
        throw new Error(
          destinationExists
            ? `Fleet restore destination already exists; no-overwrite policy refuses collision: ${tree.destination}`
            : `Fleet restore staged tree is missing: ${tree.staging}`,
        );
      }
      renameSync(tree.staging, tree.destination);
      fsyncDirectorySync(dirname(tree.destination));
      options.faultInjection?.('after_tree_publish', index + 1);
      tree.published = true;
      writeRestoreJournal(journalPath, journal);
    }
    // Once every tree is published, marker/journal cleanup is finalization;
    // transient cleanup failures must never roll back a complete restore.
    preserveJournal = true;
    await options.removeDatabaseOperation(operation);
    removeRestoreJournal(journalPath);
  } catch (error) {
    if (preserveJournal) throw error;
    if (databaseCommitted) {
      journal.phase = 'rolling_back';
      writeRestoreJournal(journalPath, journal);
      try {
        await finishRestoreRollback(
          journalPath,
          journal,
          operation,
          options.rollbackDatabase,
          options.removeDatabaseOperation,
          options.faultInjection,
        );
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Fleet restore failed and durable rollback remains pending');
      }
    } else if (markerPrepared) {
      try {
        cleanupStagedTrees(journal.trees);
        await options.removeDatabaseOperation(operation);
        removeRestoreJournal(journalPath);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Fleet restore failed and durable cleanup remains pending');
      }
    } else {
      cleanupStagedTrees(journal.trees);
      removeRestoreJournal(journalPath);
    }
    throw error;
  }
  return { restoredDestinations: journal.trees.map(tree => tree.destination) };
}
