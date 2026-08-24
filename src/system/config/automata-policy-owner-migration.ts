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
import { parseAutomataOwnerPolicy } from '../../faculties/automata/registry-contract.js';
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
    if (Object.hasOwn(raw.bus, 'reindex')) {
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

    const defaults = loadAutomataPolicySeedDefaults(
      options.seedDir ? { seedDir: options.seedDir } : {},
    );
    const candidate: Record<string, unknown> = structuredClone(raw);
    candidate.bus = {
      ...structuredClone(raw.bus),
      reindex: structuredClone(defaults.bus.reindex),
    };
    parseAutomataOwnerPolicy(candidate, filePath);
    const result: AutomataPolicyOwnerMigrationResult = {
      mode,
      status: options.apply ? 'applied' : 'planned',
      filePath,
      addedPaths: ['bus.reindex'],
    };
    if (options.apply) {
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
