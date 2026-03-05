import { join } from 'node:path';
import type { CharacterImportResult, CharacterMemorySeed } from '../../../../identity/importer.js';
import { persistExtractedCharacterAssets } from '../../../../identity/importer.js';
import type { MemoryWriteOptions, MemoryWriter } from '../../../../memory/writer.js';
import { resolveConfiguredCompanionDataDir } from '../../../../persistence/layout.js';
import type { SubstrateConfig } from '../../../../types.js';
import { toErrorMessage } from '../../../../utils/errors.js';
import { uniqueLowercase } from '../../utils.js';

export interface PersistImportedAssetsResult {
  persistedAssetCount: number;
  assetRootDir: string | null;
  warnings: string[];
}

export interface CharacterBookSeedImportResult {
  attempted: number;
  written: number;
  deduplicated: number;
  superseded: number;
  errors: number;
  skippedReason?: string;
}

export function resolveCharacterImportAssetRootDir(config: SubstrateConfig): string | null {
  const dataDir = resolveConfiguredCompanionDataDir(config).trim();
  if (!dataDir) return null;
  return join(dataDir, 'identity-assets');
}

export function persistImportedAssets(
  assets: CharacterImportResult['assets'],
  config: SubstrateConfig,
): PersistImportedAssetsResult {
  let persistedAssetCount = 0;
  let assetRootDir: string | null = null;
  const warnings: string[] = [];
  if (assets.length === 0) {
    return { persistedAssetCount, assetRootDir, warnings };
  }

  assetRootDir = resolveCharacterImportAssetRootDir(config);
  if (!assetRootDir) {
    warnings.push('Extracted media assets were not persisted because dataDir is not configured.');
    return { persistedAssetCount, assetRootDir, warnings };
  }

  try {
    persistExtractedCharacterAssets(assets, assetRootDir);
    persistedAssetCount = assets.length;
  } catch (error) {
    warnings.push(`Extracted media assets were not persisted: ${toErrorMessage(error)}`);
  }
  return { persistedAssetCount, assetRootDir, warnings };
}

export function buildCharacterBookSeedWrites(
  seeds: readonly CharacterMemorySeed[],
  sourcePath: string,
): MemoryWriteOptions[] {
  const sourceToken = encodeURIComponent(sourcePath);
  return seeds.map((seed, index) => ({
    text: seed.text,
    type: seed.type,
    importance: seed.importance,
    tags: uniqueLowercase(['character_import', ...seed.tags]),
    sourceRef: `admin:import:character_book:${sourceToken}:${index + 1}`,
    sensitivity: seed.sensitivity,
  }));
}

export async function importCharacterBookSeeds(
  importMemoryWriter: MemoryWriter | null,
  seeds: readonly CharacterMemorySeed[],
  sourcePath: string,
): Promise<CharacterBookSeedImportResult> {
  if (seeds.length === 0) {
    return {
      attempted: 0,
      written: 0,
      deduplicated: 0,
      superseded: 0,
      errors: 0,
    };
  }

  if (!importMemoryWriter) {
    return {
      attempted: seeds.length,
      written: 0,
      deduplicated: 0,
      superseded: 0,
      errors: 0,
      skippedReason: 'memory writer is not configured',
    };
  }

  try {
    const result = await importMemoryWriter.importBatch(
      buildCharacterBookSeedWrites(seeds, sourcePath),
    );
    return {
      attempted: seeds.length,
      written: result.written,
      deduplicated: result.deduplicated,
      superseded: result.superseded,
      errors: result.errors,
    };
  } catch (error) {
    return {
      attempted: seeds.length,
      written: 0,
      deduplicated: 0,
      superseded: 0,
      errors: 0,
      skippedReason: toErrorMessage(error),
    };
  }
}
