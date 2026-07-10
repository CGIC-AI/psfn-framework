import { join } from 'node:path';
import {
  cacheJsonValue,
  invalidateCachedJsonValue,
  loadRequiredJsonCached,
} from '../config/load-or-seed.js';
import { createComponentLogger } from '../../shared/logger.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  SETTINGS_FILE_NAME,
  validateObsidianCliPathSetting,
  type EditableSettings,
} from './contracts.js';
import { normalizeEditableSettings, splitSettingsByDomain } from './schema.js';

const log = createComponentLogger('Settings');

const SETTINGS_FILE = SETTINGS_FILE_NAME;
const SETTINGS_SEED_FILE = 'settings.seed.json';

function hasOwnKey(target: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

function applyLegacyVoiceProviderDefaults(
  raw: Record<string, unknown>,
  normalized: EditableSettings,
): EditableSettings {
  const migrated: EditableSettings = { ...normalized };
  if (!hasOwnKey(raw, 'ttsProvider')) {
    migrated.ttsProvider = 'disabled';
  }
  if (!hasOwnKey(raw, 'sttProvider')) {
    migrated.sttProvider = 'disabled';
  }
  return migrated;
}

/** Load saved settings from data/settings.json. Missing owner files fail closed with example-copy guidance. */
export function loadSettings(
  dataDir: string,
  options?: { seedDir?: string },
): EditableSettings {
  const path = join(dataDir, SETTINGS_FILE);
  const seedDir = options?.seedDir ?? process.env.CONFIG_DIR ?? './config';
  const seedPath = join(seedDir, SETTINGS_SEED_FILE);

  const loaded = loadRequiredJsonCached({
    dataPath: path,
    examplePath: seedPath,
    validate: (raw, sourcePath) => {
      if (!isRecord(raw)) {
        throw new Error(`Invalid settings file format at ${sourcePath}`);
      }
      return applyLegacyVoiceProviderDefaults(
        raw,
        normalizeEditableSettings(raw as EditableSettings),
      );
    },
  });

  log.info('Loaded saved settings');
  return loaded;
}

/** Atomic write: write to .tmp then rename. */
export function saveSettings(dataDir: string, settings: EditableSettings): void {
  const path = join(dataDir, SETTINGS_FILE);
  // Fail closed on a shell-injection payload before it is ever persisted
  // (bead lget/w3pj). obsidianCliPath is admin-mutable and later spawned.
  if (settings.obsidianCliPath !== undefined) {
    validateObsidianCliPathSetting(settings.obsidianCliPath);
  }
  const normalized = normalizeEditableSettings(settings);
  const split = splitSettingsByDomain(normalized);
  if (split.legacyKeys.length > 0) {
    throw new Error(
      'Refusing to save non-runtime keys to settings.json: '
      + `${split.legacyKeys.join(', ')}. Save these fields through their canonical owner files.`,
    );
  }
  invalidateCachedJsonValue(path);
  writeJsonAtomic(path, split.runtime);
  cacheJsonValue(path, normalizeEditableSettings(split.runtime));
  log.info('Saved settings');
}
