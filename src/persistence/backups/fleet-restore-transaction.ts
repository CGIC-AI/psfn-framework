import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
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

export type FleetRestoreKind = 'companion' | 'cluster' | 'group';
export type FleetRestoreFaultStage =
  | 'after_journal'
  | 'after_database_commit'
  | 'after_tree_publish';

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
  restoreDatabase: () => Promise<void>;
  rollbackDatabase: () => Promise<void>;
}

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

function createRestoreOperationId(
  options: FleetRestoreTransactionOptions,
  trees: readonly StagedRestoreTree[],
): string {
  return createHash('sha256').update(JSON.stringify({
    kind: options.kind,
    artifactDir: options.artifactDir,
    dumpPath: options.dumpPath,
    databaseTarget: options.databaseTarget,
    expectedSchemas: options.expectedSchemas,
    destinations: trees.map(tree => tree.destination),
  })).digest('hex').slice(0, 32);
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
  try {
    for (const tree of staged) {
      ensureDirectoryDurableSync(dirname(tree.destination));
      if (existsSync(tree.staging)) {
        rmSync(tree.staging, { recursive: true, force: true });
        fsyncDirectorySync(dirname(tree.staging));
      }
      cpSync(tree.source, tree.staging, { recursive: true, errorOnExist: true, force: false });
    }
    prepareStaging?.(staged);
    for (const tree of staged) {
      fsyncTreeSync(tree.staging);
      fsyncDirectorySync(dirname(tree.staging));
    }
    return staged;
  } catch (error) {
    cleanupStagedTrees(staged);
    throw error;
  }
}

function restoreJournalPath(operationId: string, trees: readonly StagedRestoreTree[]): string {
  return join(dirname(trees[0].destination), `.psfn-fleet-restore-${operationId}.json`);
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
  rollbackDatabase: () => Promise<void>,
): Promise<void> {
  await rollbackDatabase();
  cleanupPublishedTrees(journal.trees);
  cleanupStagedTrees(journal.trees);
  removeRestoreJournal(journalPath);
}

export async function executeFleetRestoreTransaction(
  options: FleetRestoreTransactionOptions,
): Promise<{ restoredDestinations: string[] }> {
  const plannedTrees = resolveRestoreTrees(options);
  const operationId = createRestoreOperationId(options, plannedTrees);
  const expectedTrees = plannedTrees.map(tree => ({
    ...tree,
    staging: join(dirname(tree.destination), `.${basename(tree.destination)}.restore-${operationId}`),
  }));
  const journalPath = restoreJournalPath(operationId, expectedTrees);
  const expectedJournal: FleetRestoreJournal = {
    schemaVersion: 1,
    operationId,
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
      await finishRestoreRollback(journalPath, interrupted, options.rollbackDatabase);
      return await executeFleetRestoreTransaction(options);
    }
  }

  let journal: FleetRestoreJournal;
  if (existsSync(journalPath)) {
    journal = parseRestoreJournal(journalPath, expectedJournal);
  } else {
    assertDestinationsDoNotExist(plannedTrees);
    await options.assertTargetDatabaseSafe();
    // Database preflight invokes external tooling, so recheck filesystem
    // collisions immediately before recording intent and touching Postgres.
    assertDestinationsDoNotExist(plannedTrees);
    journal = {
      ...expectedJournal,
      trees: stageRestoreTrees(plannedTrees, operationId, options.prepareStaging),
    };
    writeRestoreJournal(journalPath, journal, true);
    options.faultInjection?.('after_journal', 0);
  }

  let databaseCommitted = journal.phase === 'database_committed';
  let preserveJournal = false;
  try {
    let databaseState: 'none' | 'all' | 'partial';
    try {
      databaseState = await options.inspectDatabaseState();
    } catch (error) {
      preserveJournal = true;
      throw error;
    }
    if (databaseState === 'partial'
      || (journal.phase === 'database_committed' && databaseState !== 'all')) {
      preserveJournal = true;
      throw new Error('Fleet restore journal and target Postgres schemas are inconsistent; refusing destructive recovery');
    }
    if (journal.phase === 'prepared') {
      if (databaseState === 'none') {
        assertDestinationsDoNotExist(journal.trees);
        await options.restoreDatabase();
        databaseCommitted = true;
        options.faultInjection?.('after_database_commit', 0);
      } else {
        databaseCommitted = true;
      }
      journal.phase = 'database_committed';
      writeRestoreJournal(journalPath, journal);
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
    removeRestoreJournal(journalPath);
  } catch (error) {
    if (preserveJournal) throw error;
    if (databaseCommitted) {
      journal.phase = 'rolling_back';
      writeRestoreJournal(journalPath, journal);
      try {
        await finishRestoreRollback(journalPath, journal, options.rollbackDatabase);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Fleet restore failed and durable rollback remains pending');
      }
    } else {
      cleanupStagedTrees(journal.trees);
      removeRestoreJournal(journalPath);
    }
    throw error;
  }
  return { restoredDestinations: journal.trees.map(tree => tree.destination) };
}
