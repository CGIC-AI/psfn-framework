import { join } from 'node:path';
import {
  cacheJsonValue,
  invalidateCachedJsonValue,
  loadOrSeedJsonCached,
  writeJsonAtomic,
} from '../config/load-or-seed.js';
import { createComponentLogger } from '../logger.js';
import { isRecord } from '../utils/types.js';
import { SETTINGS_FILE_NAME, type EditableSettings } from './contracts.js';
import { normalizeEditableSettings, splitSettingsByDomain } from './schema.js';

const log = createComponentLogger('Settings');

const SETTINGS_FILE = SETTINGS_FILE_NAME;
const SETTINGS_SEED_FILE = 'settings.seed.json';

/** Load saved settings from data/settings.json, seeding from config/settings.seed.json when missing/corrupt. */
export function loadSettings(
  dataDir: string,
  options?: { seedDir?: string },
): EditableSettings {
  const path = join(dataDir, SETTINGS_FILE);
  const seedDir = options?.seedDir ?? process.env.CONFIG_DIR ?? './config';
  const seedPath = join(seedDir, SETTINGS_SEED_FILE);

  const loaded = loadOrSeedJsonCached({
    dataPath: path,
    seedPath,
    validate: (raw, sourcePath) => {
      if (!isRecord(raw)) {
        throw new Error(`Invalid settings file format at ${sourcePath}`);
      }
      return normalizeEditableSettings(raw as EditableSettings);
    },
  });

  log.info('Loaded saved settings');
  return loaded;
}

/** Atomic write: write to .tmp then rename. */
export function saveSettings(dataDir: string, settings: EditableSettings): void {
  const path = join(dataDir, SETTINGS_FILE);
  const normalized = normalizeEditableSettings(settings);
  const split = splitSettingsByDomain(normalized);
  invalidateCachedJsonValue(path);
  writeJsonAtomic(path, split.runtime);
  cacheJsonValue(path, normalizeEditableSettings(split.runtime));
  if (split.legacyKeys.length > 0) {
    log.warn('Dropped non-runtime keys while saving settings.json', {
      keys: split.legacyKeys,
    });
  }
  log.info('Saved settings');
}
