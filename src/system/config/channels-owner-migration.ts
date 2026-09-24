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
  pinnedLeafExists,
  pinnedLeafPath,
  readPinnedRegularFile,
} from '../../persistence/pinned-filesystem.js';
import { CHANNELS_FILE_NAME } from '../../channels/backplane/config.js';
import { createBuiltinChannelPluginRegistry } from '../../channels/plugins/builtin.js';
import { parseChannelPluginSections } from '../../channels/plugins/load-sections.js';
import { RETIRED_CHANNEL_PLUGIN_IDS } from '../../channels/plugins/retired.js';
import { canonicalOwnerFileMode } from './owner-file-modes.js';

export interface ChannelsOwnerMigrationOptions {
  dataDir: string;
  apply?: boolean;
  faultInjection?: DurableWriteOptions['faultInjection'];
}

export interface ChannelsOwnerMigrationResult {
  mode: 'dry-run' | 'apply';
  status: 'not_needed' | 'planned' | 'applied';
  filePath: string;
  removedPaths?: string[];
}

/**
 * The runtime loader accepts either a root-level channel map or one nested
 * under `channels`; the migration edits whichever shape the owner file uses.
 */
function resolveScopedRoot(
  candidate: Record<string, unknown>,
  filePath: string,
): { scopedRoot: Record<string, unknown>; prefix: string } {
  if (candidate.channels === undefined) return { scopedRoot: candidate, prefix: '' };
  if (!isRecord(candidate.channels)) {
    throw new Error(`Invalid channels owner at ${filePath}: channels must be an object`);
  }
  return { scopedRoot: candidate.channels, prefix: 'channels.' };
}

/**
 * psfn-framework-lef2o: strips the sections of removed channel plugins (Buzz,
 * Multica) from the system `channels.json`. Only those exact keys are removed;
 * every other key is preserved byte-for-byte in value. The candidate is then
 * checked against the live plugin registry, so any other unknown plugin key
 * still fails closed here instead of being silently dropped. Dry-run is the
 * default, an absent owner file is `not_needed`, and an already-clean file is
 * validated without being rewritten.
 */
export function migrateRetiredChannelPluginSections(
  options: ChannelsOwnerMigrationOptions,
): ChannelsOwnerMigrationResult {
  const filePath = join(options.dataDir, CHANNELS_FILE_NAME);
  const mode = options.apply ? 'apply' : 'dry-run';
  const dataDirectory = pinAbsoluteDirectory(options.dataDir, 'Channels owner data directory');
  try {
    if (!pinnedLeafExists(dataDirectory, CHANNELS_FILE_NAME)) {
      return { mode, status: 'not_needed', filePath };
    }
    const source = readPinnedRegularFile(dataDirectory, CHANNELS_FILE_NAME, 'Channels owner file');
    const assertSourceStillCurrent = (): void => {
      assertPinnedDirectoryAtLogicalPath(dataDirectory, 'Channels owner data directory');
      const current = inspectPinnedRegularFile(
        dataDirectory,
        CHANNELS_FILE_NAME,
        'Channels owner file',
      );
      assertFilesystemIdentity(current, source, 'Channels owner file');
      if (current.bytes !== source.bytes || current.sha256 !== source.sha256) {
        throw new Error(`Channels owner changed while migration was prepared: ${filePath}`);
      }
    };
    const raw = JSON.parse(source.content.toString('utf8')) as unknown;
    if (!isRecord(raw)) {
      throw new Error(`Invalid channels owner at ${filePath}: expected object`);
    }

    const candidate = structuredClone(raw);
    const { scopedRoot, prefix } = resolveScopedRoot(candidate, filePath);
    const removedPaths: string[] = [];
    for (const pluginId of RETIRED_CHANNEL_PLUGIN_IDS) {
      if (Object.hasOwn(scopedRoot, pluginId)) {
        delete scopedRoot[pluginId];
        removedPaths.push(`${prefix}${pluginId}`);
      }
    }

    try {
      parseChannelPluginSections(scopedRoot, createBuiltinChannelPluginRegistry());
    } catch (error) {
      throw new Error(
        `Channels owner migration at ${filePath} refuses to continue: `
        + `${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    if (removedPaths.length === 0) {
      assertSourceStillCurrent();
      return { mode, status: 'not_needed', filePath };
    }

    if (options.apply) {
      writeFileDurableAtomicSync(
        pinnedLeafPath(dataDirectory, CHANNELS_FILE_NAME),
        `${JSON.stringify(candidate, null, 2)}\n`,
        {
          mode: canonicalOwnerFileMode({ ownerFileName: CHANNELS_FILE_NAME, scope: 'system' }),
          faultInjection: (stage) => {
            options.faultInjection?.(stage, filePath);
            if (stage !== 'after_file_sync') return;
            assertSourceStillCurrent();
          },
        },
      );
      assertPinnedDirectoryAtLogicalPath(dataDirectory, 'Channels owner data directory');
    } else {
      assertSourceStillCurrent();
    }
    return {
      mode,
      status: options.apply ? 'applied' : 'planned',
      filePath,
      removedPaths,
    };
  } finally {
    closePinnedDirectory(dataDirectory);
  }
}
