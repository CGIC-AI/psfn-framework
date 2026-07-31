import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createComponentLogger } from '../../shared/logger.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  SETTINGS_FILE_NAME,
  type EditableSettings,
} from '../settings/contracts.js';
import { parseRuntimeSettingsOwnerPayload } from '../settings/schema.js';
import { saveSettings } from '../settings/io.js';
import { loadRuntimeSettingsContractDefaults } from './settings-contract-guard.js';

const log = createComponentLogger('SettingsOwnerBackfill');

export interface SettingsOwnerBackfillResult {
  status: 'not_needed' | 'applied';
  ownerPath: string;
  addedKeys: string[];
}

/**
 * Add only contract-backed defaults that are absent from an existing
 * settings.json. Existing values remain authoritative. The canonical settings
 * writer validates and atomically publishes the complete candidate, so a
 * malformed owner or failed write aborts startup without a partial migration.
 */
export function backfillMissingRuntimeSettingsDefaults(options: {
  dataDir: string;
  seedDir: string;
}): SettingsOwnerBackfillResult {
  const ownerPath = join(options.dataDir, SETTINGS_FILE_NAME);
  const rawOwner: unknown = JSON.parse(readFileSync(ownerPath, 'utf8'));
  if (!isRecord(rawOwner)) {
    throw new Error(`Invalid settings config at ${ownerPath}: expected object`);
  }
  parseRuntimeSettingsOwnerPayload(rawOwner);

  const defaults = loadRuntimeSettingsContractDefaults(options.seedDir);
  const addedKeys = Object.keys(defaults)
    .filter(key => !Object.prototype.hasOwnProperty.call(rawOwner, key))
    .sort();
  if (addedKeys.length === 0) {
    return { status: 'not_needed', ownerPath, addedKeys };
  }

  const candidate: EditableSettings = { ...rawOwner };
  for (const key of addedKeys) {
    Object.assign(candidate, {
      [key]: structuredClone(defaults[key as keyof EditableSettings]),
    });
  }
  const validated = parseRuntimeSettingsOwnerPayload(candidate);
  saveSettings(options.dataDir, validated);
  log.info('Backfilled missing settings owner-file contract defaults', {
    ownerPath,
    addedKeys,
  });
  return { status: 'applied', ownerPath, addedKeys };
}
