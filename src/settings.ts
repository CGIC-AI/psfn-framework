// ── Persistent Editable Settings ──
// Subset of SubstrateConfig that can be changed at runtime via admin GUI.
// Persisted to data/settings.json. Loaded at startup, merged over env defaults.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ModelCatalogEntry,
  ModelPurpose,
  ModelRoleAssignments,
  ModelSlot,
  ModelSlotDefaults,
  ModelSlotOverrides,
  SubstrateConfig,
} from './types.js';
import { createComponentLogger } from './logger.js';

const log = createComponentLogger('Settings');

const SETTINGS_FILE = 'settings.json';
const PRIMARY_MODEL_SLOT_KEY = 'primary';
const EXTRACTION_MODEL_SLOT_KEY = 'extraction';
const KNOWN_MODEL_PURPOSES: ModelPurpose[] = ['chat', 'background', 'reasoning', 'longContext'];

export const MODEL_SLOT_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

export const DEFAULT_MODEL_ROLE_ASSIGNMENTS: Readonly<ModelRoleAssignments> = {
  chat: PRIMARY_MODEL_SLOT_KEY,
  background: EXTRACTION_MODEL_SLOT_KEY,
  extraction: EXTRACTION_MODEL_SLOT_KEY,
  summary: PRIMARY_MODEL_SLOT_KEY,
  reasoning: PRIMARY_MODEL_SLOT_KEY,
  longContext: PRIMARY_MODEL_SLOT_KEY,
};

export interface EditableSettings {
  primaryModel?: string;
  primaryProvider?: string;
  extractionModel?: string;
  extractionProvider?: string;
  primaryMaxTokens?: number;
  extractionMaxTokens?: number;
  modelCatalog?: Record<string, ModelCatalogEntry>;
  modelRoleAssignments?: ModelRoleAssignments;
  modelRoster?: Partial<Record<ModelPurpose, ModelSlot>>;
  sessionMessageLimit?: number;
  memoryRetrievalLimit?: number;
  extractionInterval?: number;
  thinkMaxTokens?: number;
  thinkMaxWallTimeMs?: number;
  thinkMaxSubQueries?: number;
  retryMaxAttempts?: number;
  retryBaseDelayMs?: number;
}

export const RUNTIME_SETTINGS_KEYS = [
  'primaryModel',
  'primaryProvider',
  'primaryMaxTokens',
  'extractionModel',
  'extractionProvider',
  'extractionMaxTokens',
  'sessionMessageLimit',
  'memoryRetrievalLimit',
  'extractionInterval',
  'maintenanceIntervalMs',
  'defaultContextWindow',
  'memoryBudgetPct',
  'extractionThresholdPct',
  'compactionThresholdPct',
  'thinkMaxTokens',
  'thinkMaxWallTimeMs',
  'thinkMaxSubQueries',
  'retryMaxAttempts',
  'retryBaseDelayMs',
] as const;

export type RuntimeSettingKey = typeof RUNTIME_SETTINGS_KEYS[number];
export type RuntimeSettingValue = string | number | boolean | null;
export type RuntimeSettingsSnapshot = Record<RuntimeSettingKey, RuntimeSettingValue>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sanitizeModelSlotDefaults(value: unknown): ModelSlotDefaults | undefined {
  if (!isRecord(value)) return undefined;
  const maxTokens = toPositiveInteger(value.maxTokens);
  const contextWindow = toPositiveInteger(value.contextWindow);
  const description = toNonEmptyString(value.description);
  if (maxTokens === undefined && contextWindow === undefined && description === undefined) {
    return undefined;
  }
  return {
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

function sanitizeModelSlotOverrides(value: unknown): ModelSlotOverrides | undefined {
  if (!isRecord(value)) return undefined;
  const maxTokens = toPositiveInteger(value.maxTokens);
  const contextWindow = toPositiveInteger(value.contextWindow);
  if (maxTokens === undefined && contextWindow === undefined) {
    return undefined;
  }
  return {
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

function sanitizeModelCatalog(value: unknown): Record<string, ModelCatalogEntry> {
  if (!isRecord(value)) return {};
  const catalog: Record<string, ModelCatalogEntry> = {};
  for (const [rawSlotKey, rawEntry] of Object.entries(value)) {
    const slotKey = rawSlotKey.trim();
    if (!slotKey || !MODEL_SLOT_KEY_PATTERN.test(slotKey) || !isRecord(rawEntry)) continue;

    const model = toNonEmptyString(rawEntry.model);
    const provider = toNonEmptyString(rawEntry.provider);
    if (!model || !provider) continue;

    const defaults = sanitizeModelSlotDefaults(rawEntry.defaults);
    const overrides = sanitizeModelSlotOverrides(rawEntry.overrides);

    catalog[slotKey] = {
      model,
      provider,
      ...(defaults ? { defaults } : {}),
      ...(overrides ? { overrides } : {}),
    };
  }
  return catalog;
}

function sanitizeModelRoleAssignments(value: unknown): ModelRoleAssignments {
  if (!isRecord(value)) return {};
  const assignments: ModelRoleAssignments = {};
  for (const [rawPurpose, rawSlotKey] of Object.entries(value)) {
    const purpose = rawPurpose.trim();
    const slotKey = toNonEmptyString(rawSlotKey);
    if (!purpose || !slotKey || !MODEL_SLOT_KEY_PATTERN.test(slotKey)) continue;
    assignments[purpose] = slotKey;
  }
  return assignments;
}

function sanitizeModelRoster(value: unknown): Partial<Record<ModelPurpose, ModelSlot>> {
  if (!isRecord(value)) return {};
  const roster: Partial<Record<ModelPurpose, ModelSlot>> = {};

  for (const purpose of KNOWN_MODEL_PURPOSES) {
    const candidate = value[purpose];
    if (!isRecord(candidate)) continue;

    const model = toNonEmptyString(candidate.model);
    const provider = toNonEmptyString(candidate.provider);
    const maxTokens = toPositiveInteger(candidate.maxTokens);
    const contextWindow = toPositiveInteger(candidate.contextWindow);
    if (!model || !provider || maxTokens === undefined) continue;

    roster[purpose] = {
      model,
      provider,
      maxTokens,
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    };
  }

  return roster;
}

function mergeCatalogSlot(
  catalog: Record<string, ModelCatalogEntry>,
  slotKey: string,
  slot: {
    model?: string;
    provider?: string;
    maxTokens?: number;
    contextWindow?: number;
  },
): void {
  const model = toNonEmptyString(slot.model);
  const provider = toNonEmptyString(slot.provider);
  if (!model || !provider || !MODEL_SLOT_KEY_PATTERN.test(slotKey)) return;

  const existing = catalog[slotKey];
  const merged: ModelCatalogEntry = {
    ...(existing ?? {}),
    model,
    provider,
  };

  const overrides: ModelSlotOverrides = {
    ...(existing?.overrides ?? {}),
  };
  if (slot.maxTokens !== undefined) overrides.maxTokens = slot.maxTokens;
  if (slot.contextWindow !== undefined) overrides.contextWindow = slot.contextWindow;
  merged.overrides = Object.keys(overrides).length > 0 ? overrides : undefined;

  catalog[slotKey] = merged;
}

function defaultSlotKeyForPurpose(purpose: string): string {
  if (purpose === 'background' || purpose === 'extraction') {
    return EXTRACTION_MODEL_SLOT_KEY;
  }
  if (purpose === 'chat' || purpose === 'summary' || purpose === 'reasoning' || purpose === 'longContext') {
    return PRIMARY_MODEL_SLOT_KEY;
  }
  return purpose;
}

function resolveCatalogSlotKey(
  catalog: Record<string, ModelCatalogEntry>,
  assignments: ModelRoleAssignments,
  purpose: string,
  fallbackSlotKey?: string,
): string | undefined {
  const candidates = [
    assignments[purpose],
    purpose === 'background' ? assignments.extraction : undefined,
    purpose === 'extraction' ? assignments.background : undefined,
    fallbackSlotKey,
    defaultSlotKeyForPurpose(purpose),
    assignments.chat,
    PRIMARY_MODEL_SLOT_KEY,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (catalog[candidate]) return candidate;
  }

  const firstCatalogSlot = Object.keys(catalog)[0];
  return firstCatalogSlot;
}

function modelSlotFromCatalogEntry(
  entry: ModelCatalogEntry,
  fallback: { maxTokens?: number; contextWindow?: number },
): ModelSlot | undefined {
  const maxTokens = entry.overrides?.maxTokens
    ?? entry.defaults?.maxTokens
    ?? fallback.maxTokens;
  if (maxTokens === undefined) return undefined;

  const contextWindow = entry.overrides?.contextWindow
    ?? entry.defaults?.contextWindow
    ?? fallback.contextWindow;

  return {
    model: entry.model,
    provider: entry.provider,
    maxTokens,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

function resolvePurposeSlot(
  catalog: Record<string, ModelCatalogEntry>,
  assignments: ModelRoleAssignments,
  purpose: string,
  fallback: { maxTokens?: number; contextWindow?: number },
  fallbackSlotKey?: string,
): ModelSlot | undefined {
  const slotKey = resolveCatalogSlotKey(catalog, assignments, purpose, fallbackSlotKey);
  if (!slotKey) return undefined;
  const entry = catalog[slotKey];
  if (!entry) return undefined;
  return modelSlotFromCatalogEntry(entry, fallback);
}

function hasModelSettings(settings: EditableSettings): boolean {
  return settings.primaryModel !== undefined
    || settings.primaryProvider !== undefined
    || settings.primaryMaxTokens !== undefined
    || settings.extractionModel !== undefined
    || settings.extractionProvider !== undefined
    || settings.extractionMaxTokens !== undefined
    || settings.modelCatalog !== undefined
    || settings.modelRoleAssignments !== undefined
    || settings.modelRoster !== undefined;
}

export function normalizeEditableSettings(
  settings: EditableSettings,
  options?: { defaultContextWindow?: number },
): EditableSettings {
  if (!hasModelSettings(settings)) {
    return { ...settings };
  }

  const normalized: EditableSettings = { ...settings };
  const catalog = sanitizeModelCatalog(settings.modelCatalog);
  const assignments = sanitizeModelRoleAssignments(settings.modelRoleAssignments);
  const roster = sanitizeModelRoster(settings.modelRoster);

  for (const [purpose, slot] of Object.entries(roster) as Array<[ModelPurpose, ModelSlot]>) {
    const slotKey = assignments[purpose] ?? defaultSlotKeyForPurpose(purpose);
    assignments[purpose] = slotKey;
    mergeCatalogSlot(catalog, slotKey, {
      model: slot.model,
      provider: slot.provider,
      maxTokens: slot.maxTokens,
      contextWindow: slot.contextWindow,
    });
  }

  mergeCatalogSlot(catalog, PRIMARY_MODEL_SLOT_KEY, {
    model: settings.primaryModel,
    provider: settings.primaryProvider,
    maxTokens: settings.primaryMaxTokens,
    contextWindow: roster.chat?.contextWindow ?? options?.defaultContextWindow,
  });
  mergeCatalogSlot(catalog, EXTRACTION_MODEL_SLOT_KEY, {
    model: settings.extractionModel,
    provider: settings.extractionProvider,
    maxTokens: settings.extractionMaxTokens,
  });

  if (catalog[PRIMARY_MODEL_SLOT_KEY]) {
    assignments.chat ??= PRIMARY_MODEL_SLOT_KEY;
    assignments.summary ??= assignments.chat;
    assignments.reasoning ??= assignments.chat;
    assignments.longContext ??= assignments.chat;
  }
  if (catalog[EXTRACTION_MODEL_SLOT_KEY]) {
    assignments.background ??= EXTRACTION_MODEL_SLOT_KEY;
    assignments.extraction ??= assignments.background;
  }

  for (const [purpose, slotKey] of Object.entries(assignments)) {
    if (!catalog[slotKey]) {
      delete assignments[purpose];
    }
  }

  const chatSlot = resolvePurposeSlot(
    catalog,
    assignments,
    'chat',
    {
      maxTokens: settings.primaryMaxTokens,
      contextWindow: roster.chat?.contextWindow ?? options?.defaultContextWindow,
    },
    PRIMARY_MODEL_SLOT_KEY,
  );

  const extractionSlot = resolvePurposeSlot(
    catalog,
    assignments,
    'extraction',
    {
      maxTokens: settings.extractionMaxTokens ?? settings.primaryMaxTokens,
    },
    assignments.background ?? EXTRACTION_MODEL_SLOT_KEY,
  );

  const backgroundSlot = resolvePurposeSlot(
    catalog,
    assignments,
    'background',
    {
      maxTokens: extractionSlot?.maxTokens ?? settings.extractionMaxTokens ?? settings.primaryMaxTokens,
    },
    assignments.extraction ?? EXTRACTION_MODEL_SLOT_KEY,
  );

  const reasoningSlot = resolvePurposeSlot(
    catalog,
    assignments,
    'reasoning',
    {
      maxTokens: chatSlot?.maxTokens ?? settings.primaryMaxTokens,
      contextWindow: chatSlot?.contextWindow ?? options?.defaultContextWindow,
    },
    assignments.chat ?? PRIMARY_MODEL_SLOT_KEY,
  );

  const longContextSlot = resolvePurposeSlot(
    catalog,
    assignments,
    'longContext',
    {
      maxTokens: chatSlot?.maxTokens ?? settings.primaryMaxTokens,
      contextWindow: chatSlot?.contextWindow ?? options?.defaultContextWindow,
    },
    assignments.chat ?? PRIMARY_MODEL_SLOT_KEY,
  );

  const nextRoster: Partial<Record<ModelPurpose, ModelSlot>> = {
    ...roster,
  };
  if (chatSlot) nextRoster.chat = chatSlot;
  if (backgroundSlot) nextRoster.background = backgroundSlot;
  if (reasoningSlot) nextRoster.reasoning = reasoningSlot;
  if (longContextSlot) nextRoster.longContext = longContextSlot;

  if (chatSlot) {
    normalized.primaryModel = chatSlot.model;
    normalized.primaryProvider = chatSlot.provider;
    normalized.primaryMaxTokens = chatSlot.maxTokens;
  }
  if (extractionSlot) {
    normalized.extractionModel = extractionSlot.model;
    normalized.extractionProvider = extractionSlot.provider;
    normalized.extractionMaxTokens = extractionSlot.maxTokens;
  }

  if (Object.keys(catalog).length > 0) {
    normalized.modelCatalog = catalog;
  }
  if (Object.keys(assignments).length > 0) {
    normalized.modelRoleAssignments = assignments;
  }
  if (Object.keys(nextRoster).length > 0) {
    normalized.modelRoster = nextRoster;
  }

  return normalized;
}

function mergeModelSettingsWithConfig(config: SubstrateConfig, settings: EditableSettings): EditableSettings {
  return {
    primaryModel: settings.primaryModel ?? config.primaryModel,
    primaryProvider: settings.primaryProvider ?? config.primaryProvider,
    extractionModel: settings.extractionModel ?? config.extractionModel,
    extractionProvider: settings.extractionProvider ?? config.extractionProvider,
    primaryMaxTokens: settings.primaryMaxTokens ?? config.primaryMaxTokens,
    extractionMaxTokens: settings.extractionMaxTokens ?? config.extractionMaxTokens,
    modelCatalog: settings.modelCatalog ?? config.modelCatalog,
    modelRoleAssignments: settings.modelRoleAssignments ?? config.modelRoleAssignments,
    modelRoster: settings.modelRoster,
  };
}

export function isRuntimeSettingKey(value: string): value is RuntimeSettingKey {
  return (RUNTIME_SETTINGS_KEYS as readonly string[]).includes(value);
}

export function getRuntimeSettingsSnapshot(config: SubstrateConfig): RuntimeSettingsSnapshot {
  return {
    primaryModel: config.primaryModel,
    primaryProvider: config.primaryProvider,
    primaryMaxTokens: config.primaryMaxTokens,
    extractionModel: config.extractionModel,
    extractionProvider: config.extractionProvider,
    extractionMaxTokens: config.extractionMaxTokens,
    sessionMessageLimit: config.sessionMessageLimit,
    memoryRetrievalLimit: config.memoryRetrievalLimit,
    extractionInterval: config.extractionInterval,
    maintenanceIntervalMs: config.maintenanceIntervalMs,
    defaultContextWindow: config.defaultContextWindow,
    memoryBudgetPct: config.memoryBudgetPct,
    extractionThresholdPct: config.extractionThresholdPct,
    compactionThresholdPct: config.compactionThresholdPct,
    thinkMaxTokens: config.thinkMaxTokens ?? null,
    thinkMaxWallTimeMs: config.thinkMaxWallTimeMs ?? null,
    thinkMaxSubQueries: config.thinkMaxSubQueries ?? null,
    retryMaxAttempts: config.retryMaxAttempts ?? null,
    retryBaseDelayMs: config.retryBaseDelayMs ?? null,
  };
}

/** Load saved settings from data/settings.json. Returns {} if file missing. */
export function loadSettings(dataDir: string): EditableSettings {
  const path = join(dataDir, SETTINGS_FILE);
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) {
      log.warn('Invalid settings file format, ignoring');
      return {};
    }
    log.info('Loaded saved settings');
    return normalizeEditableSettings(parsed as EditableSettings);
  } catch (err: unknown) {
    const code = isRecord(err) ? err.code : undefined;
    if (code === 'ENOENT') return {};
    log.warn('Error reading settings file', { error: String(err) });
    return {};
  }
}

/** Atomic write: write to .tmp then rename. */
export function saveSettings(dataDir: string, settings: EditableSettings): void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, SETTINGS_FILE);
  const tmpPath = path + '.tmp';
  const normalized = normalizeEditableSettings(settings);
  writeFileSync(tmpPath, JSON.stringify(normalized, null, 2) + '\n', 'utf-8');
  renameSync(tmpPath, path);
  log.info('Saved settings');
}

/** Mutate config in place with defined settings values. */
export function applySettings(config: SubstrateConfig, settings: EditableSettings): void {
  if (settings.sessionMessageLimit !== undefined) config.sessionMessageLimit = settings.sessionMessageLimit;
  if (settings.memoryRetrievalLimit !== undefined) config.memoryRetrievalLimit = settings.memoryRetrievalLimit;
  if (settings.extractionInterval !== undefined) config.extractionInterval = settings.extractionInterval;
  if (settings.thinkMaxTokens !== undefined) config.thinkMaxTokens = settings.thinkMaxTokens;
  if (settings.thinkMaxWallTimeMs !== undefined) config.thinkMaxWallTimeMs = settings.thinkMaxWallTimeMs;
  if (settings.thinkMaxSubQueries !== undefined) config.thinkMaxSubQueries = settings.thinkMaxSubQueries;
  if (settings.retryMaxAttempts !== undefined) config.retryMaxAttempts = settings.retryMaxAttempts;
  if (settings.retryBaseDelayMs !== undefined) config.retryBaseDelayMs = settings.retryBaseDelayMs;

  const shouldSyncModels = hasModelSettings(settings)
    || config.modelCatalog !== undefined
    || config.modelRoleAssignments !== undefined;

  if (!shouldSyncModels) return;

  const merged = mergeModelSettingsWithConfig(config, settings);
  const normalized = normalizeEditableSettings(merged, {
    defaultContextWindow: config.defaultContextWindow,
  });

  if (normalized.primaryModel !== undefined) config.primaryModel = normalized.primaryModel;
  if (normalized.primaryProvider !== undefined) config.primaryProvider = normalized.primaryProvider;
  if (normalized.primaryMaxTokens !== undefined) config.primaryMaxTokens = normalized.primaryMaxTokens;

  if (normalized.extractionModel !== undefined) config.extractionModel = normalized.extractionModel;
  if (normalized.extractionProvider !== undefined) config.extractionProvider = normalized.extractionProvider;
  if (normalized.extractionMaxTokens !== undefined) config.extractionMaxTokens = normalized.extractionMaxTokens;

  if (normalized.modelRoster !== undefined) config.modelRoster = normalized.modelRoster;
  if (normalized.modelCatalog !== undefined) config.modelCatalog = normalized.modelCatalog;
  if (normalized.modelRoleAssignments !== undefined) {
    config.modelRoleAssignments = normalized.modelRoleAssignments;
  }
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
  retryMaxAttempts: { min: 0, max: 10 },
  retryBaseDelayMs: { min: 500, max: 30000 },
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
    const val = Number.parseInt(raw, 10);
    if (Number.isNaN(val) || val < range.min || val > range.max) {
      errors.push(`${field} must be ${range.min}-${range.max}`);
    } else {
      (settings as Record<string, number>)[field] = val;
    }
  }

  const modelCatalogJson = params.get('modelCatalogJson')?.trim();
  if (modelCatalogJson) {
    try {
      const parsed = JSON.parse(modelCatalogJson);
      if (!isRecord(parsed)) {
        errors.push('modelCatalogJson must be a JSON object');
      } else {
        const catalog = sanitizeModelCatalog(parsed);
        if (Object.keys(catalog).length === 0) {
          errors.push('modelCatalogJson must include at least one valid slot');
        } else {
          settings.modelCatalog = catalog;
        }
      }
    } catch {
      errors.push('modelCatalogJson must be valid JSON');
    }
  }

  const modelRoleAssignmentsJson = params.get('modelRoleAssignmentsJson')?.trim();
  if (modelRoleAssignmentsJson) {
    try {
      const parsed = JSON.parse(modelRoleAssignmentsJson);
      if (!isRecord(parsed)) {
        errors.push('modelRoleAssignmentsJson must be a JSON object');
      } else {
        const assignments = sanitizeModelRoleAssignments(parsed);
        if (Object.keys(assignments).length === 0) {
          errors.push('modelRoleAssignmentsJson must include at least one valid purpose mapping');
        } else {
          settings.modelRoleAssignments = assignments;
        }
      }
    } catch {
      errors.push('modelRoleAssignmentsJson must be valid JSON');
    }
  }

  if (settings.modelCatalog && settings.modelRoleAssignments) {
    for (const [purpose, slotKey] of Object.entries(settings.modelRoleAssignments)) {
      if (!settings.modelCatalog[slotKey]) {
        errors.push(`purpose "${purpose}" references unknown model slot "${slotKey}"`);
      }
    }
  }

  if (errors.length > 0) {
    return [settings, errors];
  }

  return [normalizeEditableSettings(settings), errors];
}
