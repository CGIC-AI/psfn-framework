import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ModelCatalogEntry, ModelRoleAssignments } from '../types.js';
import {
  extractModelSettings,
  hasModelSettings,
  normalizeEditableSettings,
  type EditableSettings,
} from '../settings.js';
import {
  loadOrSeedJson,
  writeJsonAtomic,
} from './load-or-seed.js';
import { isRecord } from '../utils/types.js';

export const MODELS_FILE_NAME = 'models.json';
export const MODELS_SEED_FILE_NAME = 'models.seed.json';

export interface ModelsRuntimeConfig {
  modelCatalog: Record<string, ModelCatalogEntry>;
  modelRoleAssignments: ModelRoleAssignments;
}

interface ModelsRuntimeLoadOptions {
  seedDir?: string;
  defaultContextWindow?: number;
}

export interface ModelsLoadResult {
  config: ModelsRuntimeConfig;
  migratedFromLegacySettings: boolean;
  legacyDriftDetected: boolean;
}

function validateModelsConfig(
  raw: unknown,
  sourcePath: string,
  defaultContextWindow?: number,
): ModelsRuntimeConfig {
  if (!isRecord(raw)) {
    throw new Error(`Invalid models config at ${sourcePath}: expected object`);
  }

  const candidate: EditableSettings = {};

  if (isRecord(raw.modelCatalog) || isRecord(raw.modelRoleAssignments)) {
    candidate.modelCatalog = raw.modelCatalog as EditableSettings['modelCatalog'];
    candidate.modelRoleAssignments = raw.modelRoleAssignments as EditableSettings['modelRoleAssignments'];
  } else {
    // Backward compatibility: accept direct slot map as the file root.
    candidate.modelCatalog = raw as EditableSettings['modelCatalog'];
  }

  const normalized = normalizeEditableSettings(candidate, {
    defaultContextWindow,
  });

  const modelCatalog = normalized.modelCatalog ?? {};
  if (Object.keys(modelCatalog).length === 0) {
    throw new Error(`Invalid models config at ${sourcePath}: no valid model slots found`);
  }

  return {
    modelCatalog,
    modelRoleAssignments: normalized.modelRoleAssignments ?? {},
  };
}

export function loadModelsConfig(
  dataDir: string,
  options: ModelsRuntimeLoadOptions = {},
): ModelsRuntimeConfig {
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  return loadOrSeedJson({
    dataPath: join(dataDir, MODELS_FILE_NAME),
    seedPath: join(seedDir, MODELS_SEED_FILE_NAME),
    validate: (raw, sourcePath) => validateModelsConfig(raw, sourcePath, options.defaultContextWindow),
  });
}

export function loadModelsConfigWithLegacyMigration(
  dataDir: string,
  options: ModelsRuntimeLoadOptions & { legacySettings?: EditableSettings } = {},
): ModelsLoadResult {
  const filePath = join(dataDir, MODELS_FILE_NAME);
  const modelsFileExisted = existsSync(filePath);
  const persisted = loadModelsConfig(dataDir, options);
  const legacySettings = options.legacySettings;
  if (!legacySettings) {
    return {
      config: persisted,
      migratedFromLegacySettings: false,
      legacyDriftDetected: false,
    };
  }

  const legacyModelSettings = extractModelSettings(legacySettings);
  if (!hasModelSettings(legacyModelSettings)) {
    return {
      config: persisted,
      migratedFromLegacySettings: false,
      legacyDriftDetected: false,
    };
  }

  const normalizedLegacy = normalizeEditableSettings(legacyModelSettings, {
    defaultContextWindow: options.defaultContextWindow,
  });
  const legacyConfig: ModelsRuntimeConfig = {
    modelCatalog: normalizedLegacy.modelCatalog ?? {},
    modelRoleAssignments: normalizedLegacy.modelRoleAssignments ?? {},
  };

  if (Object.keys(legacyConfig.modelCatalog).length === 0) {
    return {
      config: persisted,
      migratedFromLegacySettings: false,
      legacyDriftDetected: false,
    };
  }

  if (!modelsFileExisted) {
    const migrated = saveModelsConfig(dataDir, legacyConfig, options);
    return {
      config: migrated,
      migratedFromLegacySettings: true,
      legacyDriftDetected: false,
    };
  }

  return {
    config: persisted,
    migratedFromLegacySettings: false,
    legacyDriftDetected: !isDeepStrictEqual(persisted, legacyConfig),
  };
}

export function saveModelsConfig(
  dataDir: string,
  nextConfig: unknown,
  options: ModelsRuntimeLoadOptions = {},
): ModelsRuntimeConfig {
  const validated = validateModelsConfig(nextConfig, MODELS_FILE_NAME, options.defaultContextWindow);
  writeJsonAtomic(join(dataDir, MODELS_FILE_NAME), validated);
  return validated;
}
