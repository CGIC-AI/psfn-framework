import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { clampUnit } from '../../shared/utils/numeric.js';
import {
  parseCard,
  type CCv3Data,
  type ContainerFormat,
  type ExtractedAsset,
} from '@character-foundry/character-foundry/loader';
import type { CharacterCardV2 } from './types.js';
import { normalizeImportedCard } from './card-normalizer.js';

export { normalizeImportedCard } from './card-normalizer.js';

const DEFAULT_ASSET_DIRNAME = 'character-assets';
const DEFAULT_LOREBOOK_IMPORTANCE = 0.55;
const LOREBOOK_KEYWORD_LIMIT = 6;

interface ParseMetadata {
  containerFormat: ContainerFormat;
  sourceFormat: string;
  spec: string;
  warnings: string[];
}

export interface CharacterMemorySeed {
  text: string;
  type: 'semantic';
  importance: number;
  tags: string[];
  source: 'character_book';
  sensitivity: 'personal';
  entryName?: string;
  entryId?: number;
}

export interface ImportedAssetMetadata {
  name: string;
  type: ExtractedAsset['type'];
  ext: string;
  path?: string;
  isMain: boolean;
  byteLength: number;
  runtimePath?: string;
  runtimeRelativePath?: string;
}

export interface CharacterImportResult extends ParseMetadata {
  sourcePath: string;
  card: CharacterCardV2;
  assets: ExtractedAsset[];
  assetMetadata: ImportedAssetMetadata[];
  primaryAsset: ImportedAssetMetadata | null;
  memorySeeds: CharacterMemorySeed[];
}

export interface CharacterImportWriteOptions {
  assetRootDir?: string;
  persistAssets?: boolean;
}

export interface CharacterImportWriteResult extends CharacterImportResult {
  destinationPath: string;
  assetRootDir?: string;
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toNonEmptyText(value: unknown): string | undefined {
  const text = toText(value).trim();
  return text.length > 0 ? text : undefined;
}

function toTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

function uniqueLowercase(values: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (normalized.length > 0) {
      seen.add(normalized);
    }
  }
  return [...seen];
}

function sanitizePathToken(value: string, fallback: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : fallback;
}

function normalizeExtension(ext: string): string {
  const cleaned = ext.trim().toLowerCase().replace(/^\.+/, '');
  return cleaned.length > 0 ? cleaned : 'bin';
}

function buildAssetMetadata(asset: ExtractedAsset): ImportedAssetMetadata {
  return {
    name: asset.name,
    type: asset.type,
    ext: normalizeExtension(asset.ext),
    path: asset.path,
    isMain: Boolean(asset.isMain),
    byteLength: asset.data.byteLength,
  };
}

function pickPrimaryAsset(assets: readonly ImportedAssetMetadata[]): ImportedAssetMetadata | null {
  if (assets.length === 0) return null;
  const ranked = assets.find(asset => asset.type === 'icon' && asset.isMain)
    ?? assets.find(asset => asset.type === 'icon')
    ?? assets.find(asset => asset.isMain)
    ?? assets[0];
  return ranked ?? null;
}

export function mapCharacterBookEntriesToMemorySeeds(card: CCv3Data): CharacterMemorySeed[] {
  const entries = card.data.character_book?.entries ?? [];
  const seeds: CharacterMemorySeed[] = [];
  for (const entry of entries) {
    if (entry.enabled === false) continue;
    const text = entry.content.trim();
    if (!text) continue;

    const keywords = toTextArray(entry.keys)
      .concat(toTextArray(entry.secondary_keys))
      .slice(0, LOREBOOK_KEYWORD_LIMIT);
    const tags = uniqueLowercase(['lorebook', 'character_book', ...keywords]);
    const entryName = toNonEmptyText(entry.name);
    const entryId = typeof entry.id === 'number' && Number.isFinite(entry.id)
      ? Math.floor(entry.id)
      : undefined;

    seeds.push({
      text,
      type: 'semantic',
      importance: clampUnit(entry.priority, DEFAULT_LOREBOOK_IMPORTANCE),
      tags,
      source: 'character_book',
      sensitivity: 'personal',
      entryName,
      entryId,
    });
  }
  return seeds;
}

export function persistExtractedCharacterAssets(
  assets: readonly ExtractedAsset[],
  assetRootDir: string,
): ImportedAssetMetadata[] {
  const resolvedAssetRoot = resolve(assetRootDir);
  mkdirSync(resolvedAssetRoot, { recursive: true });

  return assets.map((asset, index) => {
    const metadata = buildAssetMetadata(asset);
    const typeToken = sanitizePathToken(asset.type, 'unknown');
    const nameToken = sanitizePathToken(asset.name, `${typeToken}-${index + 1}`);
    const digest = createHash('sha256').update(asset.data).digest('hex').slice(0, 16);
    const fileName = `${nameToken}-${digest}.${metadata.ext}`;
    const directoryPath = join(resolvedAssetRoot, typeToken);
    mkdirSync(directoryPath, { recursive: true });
    const runtimePath = join(directoryPath, fileName);
    writeFileSync(runtimePath, asset.data);

    return {
      ...metadata,
      runtimePath,
      runtimeRelativePath: relative(resolvedAssetRoot, runtimePath),
    };
  });
}

export function parseImportedCharacterCard(raw: Uint8Array): Omit<CharacterImportResult, 'sourcePath'> {
  const parsed = parseCard(raw);
  const assetMetadata = parsed.assets.map(buildAssetMetadata);
  return {
    card: normalizeImportedCard(parsed.card),
    assets: parsed.assets,
    assetMetadata,
    primaryAsset: pickPrimaryAsset(assetMetadata),
    memorySeeds: mapCharacterBookEntriesToMemorySeeds(parsed.card),
    containerFormat: parsed.containerFormat,
    sourceFormat: String(parsed.sourceFormat),
    spec: String(parsed.spec),
    warnings: parsed.warnings ?? [],
  };
}

export function importCharacterCardFromPath(sourcePath: string): CharacterImportResult {
  const resolvedPath = resolve(sourcePath);
  const raw = readFileSync(resolvedPath);
  return {
    sourcePath: resolvedPath,
    ...parseImportedCharacterCard(raw),
  };
}

export function writeNormalizedCharacterCard(path: string, card: CharacterCardV2): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(card, null, 2)}\n`, 'utf-8');
}

export function importCharacterCardToPath(
  sourcePath: string,
  destinationPath: string,
  options: CharacterImportWriteOptions = {},
): CharacterImportWriteResult {
  const resolvedDestination = resolve(destinationPath);
  const imported = importCharacterCardFromPath(sourcePath);
  writeNormalizedCharacterCard(resolvedDestination, imported.card);
  const persistAssets = options.persistAssets ?? true;
  const resolvedAssetRoot = resolve(
    options.assetRootDir ?? join(dirname(resolvedDestination), DEFAULT_ASSET_DIRNAME),
  );
  const persistedAssetMetadata = persistAssets && imported.assets.length > 0
    ? persistExtractedCharacterAssets(imported.assets, resolvedAssetRoot)
    : imported.assetMetadata;

  return {
    ...imported,
    destinationPath: resolvedDestination,
    assetMetadata: persistedAssetMetadata,
    primaryAsset: pickPrimaryAsset(persistedAssetMetadata),
    ...(persistAssets && imported.assets.length > 0
      ? { assetRootDir: resolvedAssetRoot }
      : {}),
  };
}
