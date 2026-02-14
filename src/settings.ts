// ── Persistent Editable Settings ──
// Subset of SubstrateConfig that can be changed at runtime via admin GUI.
// Persisted to data/settings.json. Loaded at startup, merged over env defaults.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SubstrateConfig } from './types.js';
import { createComponentLogger } from './logger.js';

const log = createComponentLogger('Settings');

export interface EditableSettings {
  primaryModel?: string;
  primaryProvider?: string;
  extractionModel?: string;
  extractionProvider?: string;
  primaryMaxTokens?: number;
  extractionMaxTokens?: number;
  sessionMessageLimit?: number;
  memoryRetrievalLimit?: number;
  extractionInterval?: number;
  thinkMaxTokens?: number;
  thinkMaxWallTimeMs?: number;
  thinkMaxSubQueries?: number;
}

const SETTINGS_FILE = 'settings.json';

/** Load saved settings from data/settings.json. Returns {} if file missing. */
export function loadSettings(dataDir: string): EditableSettings {
  const path = join(dataDir, SETTINGS_FILE);
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      log.warn('Invalid settings file format, ignoring');
      return {};
    }
    log.info('Loaded saved settings');
    return parsed as EditableSettings;
  } catch (err: any) {
    if (err.code === 'ENOENT') return {};
    log.warn('Error reading settings file', { error: String(err) });
    return {};
  }
}

/** Atomic write: write to .tmp then rename. */
export function saveSettings(dataDir: string, settings: EditableSettings): void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, SETTINGS_FILE);
  const tmpPath = path + '.tmp';
  writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, path);
  log.info('Saved settings');
}

/** Mutate config in place with defined settings values. */
export function applySettings(config: SubstrateConfig, settings: EditableSettings): void {
  if (settings.primaryModel !== undefined) config.primaryModel = settings.primaryModel;
  if (settings.primaryProvider !== undefined) config.primaryProvider = settings.primaryProvider;
  if (settings.extractionModel !== undefined) config.extractionModel = settings.extractionModel;
  if (settings.extractionProvider !== undefined) config.extractionProvider = settings.extractionProvider;
  if (settings.primaryMaxTokens !== undefined) config.primaryMaxTokens = settings.primaryMaxTokens;
  if (settings.extractionMaxTokens !== undefined) config.extractionMaxTokens = settings.extractionMaxTokens;
  if (settings.sessionMessageLimit !== undefined) config.sessionMessageLimit = settings.sessionMessageLimit;
  if (settings.memoryRetrievalLimit !== undefined) config.memoryRetrievalLimit = settings.memoryRetrievalLimit;
  if (settings.extractionInterval !== undefined) config.extractionInterval = settings.extractionInterval;
  if (settings.thinkMaxTokens !== undefined) config.thinkMaxTokens = settings.thinkMaxTokens;
  if (settings.thinkMaxWallTimeMs !== undefined) config.thinkMaxWallTimeMs = settings.thinkMaxWallTimeMs;
  if (settings.thinkMaxSubQueries !== undefined) config.thinkMaxSubQueries = settings.thinkMaxSubQueries;
}

/** Validation ranges for settings values. */
export const SETTINGS_VALIDATION = {
  primaryMaxTokens: { min: 256, max: 65536 },
  extractionMaxTokens: { min: 256, max: 65536 },
  sessionMessageLimit: { min: 5, max: 200 },
  memoryRetrievalLimit: { min: 1, max: 50 },
  extractionInterval: { min: 1, max: 50 },
  thinkMaxTokens: { min: 1000, max: 1000000 },
  thinkMaxWallTimeMs: { min: 5000, max: 600000 },
  thinkMaxSubQueries: { min: 1, max: 100 },
} as const;

/** Validate and parse form data into EditableSettings. Returns [settings, errors]. */
export function parseSettingsForm(params: URLSearchParams): [EditableSettings, string[]] {
  const settings: EditableSettings = {};
  const errors: string[] = [];

  // String fields
  const primaryModel = params.get('primaryModel')?.trim();
  if (primaryModel) settings.primaryModel = primaryModel;

  const primaryProvider = params.get('primaryProvider')?.trim();
  if (primaryProvider) settings.primaryProvider = primaryProvider;

  const extractionModel = params.get('extractionModel')?.trim();
  if (extractionModel) settings.extractionModel = extractionModel;

  const extractionProvider = params.get('extractionProvider')?.trim();
  if (extractionProvider) settings.extractionProvider = extractionProvider;

  // Numeric fields
  for (const [field, range] of Object.entries(SETTINGS_VALIDATION)) {
    const raw = params.get(field);
    if (raw === null || raw === '') continue;
    const val = parseInt(raw, 10);
    if (isNaN(val) || val < range.min || val > range.max) {
      errors.push(`${field} must be ${range.min}-${range.max}`);
    } else {
      (settings as any)[field] = val;
    }
  }

  return [settings, errors];
}
