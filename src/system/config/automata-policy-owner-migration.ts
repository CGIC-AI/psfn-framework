import { join } from 'node:path';
import {
  writeFileDurableAtomicSync,
  type DurableWriteOptions,
} from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  assertFilesystemIdentity,
  assertPinnedDirectoryAtLogicalPath,
  closePinnedDirectory,
  inspectPinnedRegularFile,
  pinAbsoluteDirectory,
  pinnedLeafPath,
  readPinnedRegularFile,
  setPinnedRegularFileMode,
} from '../../persistence/pinned-filesystem.js';
import {
  PRODUCTION_AUTOMATA_CLASSES,
  parseAutomataOwnerPolicy,
  type AutomataOwnerPolicy,
} from '../../faculties/automata/registry-contract.js';
import {
  AUTOMATA_FILE_NAME,
  loadAutomataPolicySeedDefaults,
} from './automata-policy-config.js';
import { canonicalOwnerFileMode } from './owner-file-modes.js';

export interface AutomataPolicyOwnerMigrationOptions {
  dataDir: string;
  seedDir?: string;
  apply?: boolean;
  faultInjection?: DurableWriteOptions['faultInjection'];
}

export interface AutomataPolicyOwnerMigrationResult {
  mode: 'dry-run' | 'apply';
  status: 'not_needed' | 'planned' | 'applied';
  filePath: string;
  addedPaths?: string[];
  updatedPaths?: string[];
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * psfn-framework-o61vb.16: an owner file written before a class was registered
 * names that class in neither bus list, so the registry contract fails the
 * owner file closed on a class the operator could not have known about
 * ("does not assign bus policy for: ..."). Seed exactly the canonical seed
 * assignment for every production class the owner leaves unassigned, and leave
 * every assignment the operator did make untouched -- including one that moved
 * a class to the list the seed does not put it in.
 *
 * Assigning per class id from the seed's own lists, rather than from a literal
 * here, is what makes this one function correct for every future class: a new
 * class is added to config/automata-policy.seed.json and this migration picks
 * it up with no edit here.
 */
function addMissingBusClassAssignments(
  bus: Record<string, unknown>,
  requireSeedDefaults: () => AutomataOwnerPolicy,
  addedPaths: string[],
): void {
  const eligible = bus.eligibleClasses;
  const excluded = bus.excludedClasses;
  // A non-array list is operator corruption, not a missing assignment. Leave it
  // for validation to reject with the real reason rather than appending to it.
  if (!isUnknownArray(eligible) || !isUnknownArray(excluded)) return;
  const assigned = new Set<unknown>([...eligible, ...excluded]);
  // Keep the settled path free of any seed read: an owner file that already
  // assigns every registered class needs no canonical default at all.
  if (PRODUCTION_AUTOMATA_CLASSES.every(entry => assigned.has(entry.id))) return;
  const defaults = requireSeedDefaults();
  const lists: Record<'eligibleClasses' | 'excludedClasses', unknown[]> = {
    eligibleClasses: eligible,
    excludedClasses: excluded,
  };
  for (const listKey of ['eligibleClasses', 'excludedClasses'] as const) {
    for (const classId of defaults.bus[listKey]) {
      if (assigned.has(classId)) continue;
      lists[listKey].push(classId);
      assigned.add(classId);
      addedPaths.push(`bus.${listKey}[${classId}]`);
    }
  }
}

/** Add default-bearing Automata policy blocks introduced after an owner was written. */
export function migrateAutomataPolicyOwner(
  options: AutomataPolicyOwnerMigrationOptions,
): AutomataPolicyOwnerMigrationResult {
  const filePath = join(options.dataDir, AUTOMATA_FILE_NAME);
  const mode = options.apply ? 'apply' : 'dry-run';
  const dataDirectory = pinAbsoluteDirectory(
    options.dataDir,
    'Automata policy owner data directory',
  );
  try {
    const source = readPinnedRegularFile(
      dataDirectory,
      AUTOMATA_FILE_NAME,
      'Automata policy owner file',
    );
    const assertSourceStillCurrent = (): void => {
      assertPinnedDirectoryAtLogicalPath(
        dataDirectory,
        'Automata policy owner data directory',
      );
      const current = inspectPinnedRegularFile(
        dataDirectory,
        AUTOMATA_FILE_NAME,
        'Automata policy owner file',
      );
      assertFilesystemIdentity(current, source, 'Automata policy owner file');
      if (current.bytes !== source.bytes || current.sha256 !== source.sha256) {
        throw new Error(`Automata policy owner changed while migration was prepared: ${filePath}`);
      }
    };

    const raw = JSON.parse(source.content.toString('utf8')) as unknown;
    if (!isRecord(raw)) {
      throw new Error(`Invalid automata policy at ${filePath}: expected object`);
    }
    if (!isRecord(raw.bus)) {
      throw new Error(`Invalid automata policy at ${filePath}: bus must be an object`);
    }

    let seedDefaults: AutomataOwnerPolicy | undefined;
    const requireSeedDefaults = (): AutomataOwnerPolicy => {
      seedDefaults ??= loadAutomataPolicySeedDefaults(
        options.seedDir ? { seedDir: options.seedDir } : {},
      );
      return seedDefaults;
    };

    const addedPaths: string[] = [];
    const candidate: Record<string, unknown> = structuredClone(raw);
    const bus: Record<string, unknown> = structuredClone(raw.bus);
    candidate.bus = bus;
    if (!Object.hasOwn(bus, 'reindex')) {
      bus.reindex = structuredClone(requireSeedDefaults().bus.reindex);
      addedPaths.push('bus.reindex');
    }
    addMissingBusClassAssignments(bus, requireSeedDefaults, addedPaths);

    if (addedPaths.length === 0) {
      parseAutomataOwnerPolicy(raw, filePath);
      assertSourceStillCurrent();
      const canonicalMode = canonicalOwnerFileMode({
        ownerFileName: AUTOMATA_FILE_NAME,
        scope: 'system',
      });
      if (source.mode !== canonicalMode) {
        if (options.apply) {
          setPinnedRegularFileMode(
            dataDirectory,
            AUTOMATA_FILE_NAME,
            'Automata policy owner file',
            canonicalMode,
            source,
          );
        }
        return {
          mode,
          status: options.apply ? 'applied' : 'planned',
          filePath,
          updatedPaths: ['mode'],
        };
      }
      return { mode, status: 'not_needed', filePath };
    }

    parseAutomataOwnerPolicy(candidate, filePath);
    const result: AutomataPolicyOwnerMigrationResult = {
      mode,
      status: options.apply ? 'applied' : 'planned',
      filePath,
      addedPaths,
    };
    if (options.apply) {
      // Preserve every unrelated raw owner key. Validation above proves the
      // canonical projection is safe before this durable atomic publish occurs.
      writeFileDurableAtomicSync(
        pinnedLeafPath(dataDirectory, AUTOMATA_FILE_NAME),
        `${JSON.stringify(candidate, null, 2)}\n`,
        {
          mode: canonicalOwnerFileMode({
            ownerFileName: AUTOMATA_FILE_NAME,
            scope: 'system',
          }),
          faultInjection: (stage) => {
            options.faultInjection?.(stage, filePath);
            if (stage === 'after_file_sync') assertSourceStillCurrent();
          },
        },
      );
      assertPinnedDirectoryAtLogicalPath(
        dataDirectory,
        'Automata policy owner data directory',
      );
    } else {
      assertSourceStillCurrent();
    }
    return result;
  } finally {
    closePinnedDirectory(dataDirectory);
  }
}
