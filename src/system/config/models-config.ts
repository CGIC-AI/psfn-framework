import { join } from 'node:path';
import {
  normalizeEditableSettings,
  normalizeCanonicalModelRegistry,
} from '../settings.js';
import { MODELS_SEED_FILE_NAME } from './seed-defaults.js';
import type { CanonicalModelRegistry, ModelCatalogEntry, ModelRoleAssignments, ModelPurpose, ModelSlot } from '../../shared/contracts/runtime.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import { loadRequiredJson } from './load-or-seed.js';

export const MODELS_FILE_NAME = 'models.json';
export { MODELS_SEED_FILE_NAME };

export interface ModelsRuntimeConfig {
  modelRegistry: CanonicalModelRegistry;
  modelCatalog: Record<string, ModelCatalogEntry>;
  modelRoleAssignments: ModelRoleAssignments;
  modelRoster: Partial<Record<ModelPurpose, ModelSlot>>;
  primaryModel: string;
  primaryProvider: string;
  primaryMaxTokens: number;
  extractionModel: string;
  extractionProvider: string;
  extractionMaxTokens: number;
}

interface ModelsRuntimeLoadOptions {
  seedDir?: string;
  defaultContextWindow?: number;
}

export interface ModelsLoadResult {
  config: ModelsRuntimeConfig;
}

function validateModelsConfig(
  raw: unknown,
  sourcePath: string,
  defaultContextWindow?: number,
): ModelsRuntimeConfig {
  const modelRegistry = normalizeCanonicalModelRegistry(raw, sourcePath);
  const normalized = normalizeEditableSettings({ modelRegistry }, {
    defaultContextWindow,
  });

  const modelCatalog = normalized.modelCatalog ?? {};
  const modelRoleAssignments = normalized.modelRoleAssignments ?? {};
  const modelRoster = normalized.modelRoster ?? {};
  const primaryModel = normalized.primaryModel;
  const primaryProvider = normalized.primaryProvider;
  const primaryMaxTokens = normalized.primaryMaxTokens;
  const extractionModel = normalized.extractionModel;
  const extractionProvider = normalized.extractionProvider;
  const extractionMaxTokens = normalized.extractionMaxTokens;
  if (
    Object.keys(modelCatalog).length === 0
    || Object.keys(modelRoleAssignments).length === 0
    || !primaryModel
    || !primaryProvider
    || primaryMaxTokens === undefined
    || !extractionModel
    || !extractionProvider
    || extractionMaxTokens === undefined
  ) {
    throw new Error(`Invalid models config at ${sourcePath}: canonical registry projection failed`);
  }

  return {
    modelRegistry,
    modelCatalog,
    modelRoleAssignments,
    modelRoster,
    primaryModel,
    primaryProvider,
    primaryMaxTokens,
    extractionModel,
    extractionProvider,
    extractionMaxTokens,
  };
}

export function loadModelsConfig(
  dataDir: string,
  options: ModelsRuntimeLoadOptions = {},
): ModelsRuntimeConfig {
  const seedDir = options.seedDir ?? process.env.CONFIG_DIR ?? './config';
  const dataPath = join(dataDir, MODELS_FILE_NAME);
  const seedPath = join(seedDir, MODELS_SEED_FILE_NAME);

  return loadRequiredJson({
    dataPath,
    examplePath: seedPath,
    validate: (raw, sourcePath) => validateModelsConfig(raw, sourcePath, options.defaultContextWindow),
  });
}

export function loadStartupModelsConfig(
  dataDir: string,
  options: ModelsRuntimeLoadOptions = {},
): ModelsLoadResult {
  const persisted = loadModelsConfig(dataDir, options);
  return {
    config: persisted,
  };
}

export function saveModelsConfig(
  dataDir: string,
  nextConfig: unknown,
  options: ModelsRuntimeLoadOptions = {},
): ModelsRuntimeConfig {
  const validated = validateModelsConfig(nextConfig, MODELS_FILE_NAME, options.defaultContextWindow);
  writeJsonAtomic(join(dataDir, MODELS_FILE_NAME), validated.modelRegistry);
  return validated;
}
