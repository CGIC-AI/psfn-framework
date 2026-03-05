import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { appendJsonLine } from '../../persistence/jsonl.js';
import {
  parseLegacyChatSource,
  type LegacyChatSourceRecord,
} from '../journal-utils.js';
import {
  IMPORT_MANIFEST_SCHEMA_VERSION,
  parseImportManifestLine,
  type LegacyChatImportManifest,
  type LegacyChatImportManifestFilter,
  type LegacyChatImportRange,
  type LegacyChatImportRequest,
  type LegacyChatImportResult,
} from '../store-primitives.js';

function parseImportedMetadataValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function buildLegacyImportMetadata(params: {
  importId: string;
  sourcePath: string;
  sourceHash: string;
  sourceIndex: number;
  sourceTimestamp: number;
  metadataTag?: string;
  sourceMetadata?: string;
}): string {
  const metadata: Record<string, unknown> = {
    type: 'legacy_import',
    importId: params.importId,
    sourcePath: params.sourcePath,
    sourceHash: params.sourceHash,
    sourceIndex: params.sourceIndex,
    sourceTimestamp: params.sourceTimestamp,
  };

  if (params.metadataTag) {
    metadata.tag = params.metadataTag;
  }
  if (params.sourceMetadata) {
    metadata.sourceMetadata = parseImportedMetadataValue(params.sourceMetadata);
  }

  return JSON.stringify(metadata);
}

function appendImportManifest(
  importManifestPath: string,
  manifest: LegacyChatImportManifest,
): void {
  appendJsonLine(importManifestPath, manifest);
}

export function readImportManifests(importManifestPath: string): LegacyChatImportManifest[] {
  if (!existsSync(importManifestPath)) return [];
  const raw = readFileSync(importManifestPath, 'utf-8');
  return raw
    .split('\n')
    .map(line => parseImportManifestLine(line))
    .filter((manifest): manifest is LegacyChatImportManifest => manifest !== null);
}

export function resolveLegacyImportResumeIndex(
  importManifestPath: string,
  channelId: string,
  sourcePath: string,
): number {
  let nextSourceIndex = 0;
  const manifests = readImportManifests(importManifestPath);
  for (const manifest of manifests) {
    if (manifest.channelId !== channelId) continue;
    if (manifest.sourcePath !== sourcePath) continue;
    nextSourceIndex = Math.max(nextSourceIndex, manifest.nextSourceIndex);
  }
  return nextSourceIndex;
}

export function listLegacyImportManifests(
  importManifestPath: string,
  filters: LegacyChatImportManifestFilter = {},
): LegacyChatImportManifest[] {
  return readImportManifests(importManifestPath).filter((manifest) => {
    if (filters.channelId && manifest.channelId !== filters.channelId) return false;
    if (filters.sourcePath && manifest.sourcePath !== filters.sourcePath) return false;
    return true;
  });
}

interface LegacyImportAppendParams {
  request: LegacyChatImportRequest;
  source: LegacyChatSourceRecord;
  importId: string;
  sourceHash: string;
}

interface RunLegacyChatImportParams {
  request: LegacyChatImportRequest;
  importManifestPath: string;
  readExistingManifests: () => LegacyChatImportManifest[];
  appendImportedRecord: (params: LegacyImportAppendParams) => { id: number } | null;
}

export function runLegacyChatImport(params: RunLegacyChatImportParams): LegacyChatImportResult {
  const raw = readFileSync(params.request.sourcePath, 'utf-8');
  const parsedSource = parseLegacyChatSource(raw);
  const importId = randomUUID();
  const importedAt = Date.now();
  const importableCount = parsedSource.records.length;

  const resumedFromSourceIndex = params.request.resumeFromManifest === false
    ? 0
    : (() => {
      let nextSourceIndex = 0;
      const manifests = params.readExistingManifests();
      for (const manifest of manifests) {
        if (manifest.channelId !== params.request.channelId) continue;
        if (manifest.sourcePath !== params.request.sourcePath) continue;
        nextSourceIndex = Math.max(nextSourceIndex, manifest.nextSourceIndex);
      }
      return nextSourceIndex;
    })();

  const importedEntryIds: number[] = [];
  const entryRanges: LegacyChatImportRange[] = [];

  let importedRecordCount = 0;
  let skippedRecordCount = 0;
  let lastImportedSourceIndex = resumedFromSourceIndex;
  for (const sourceRecord of parsedSource.records) {
    if (sourceRecord.sourceIndex < resumedFromSourceIndex) continue;

    const importedEntry = params.appendImportedRecord({
      request: params.request,
      source: sourceRecord,
      importId,
      sourceHash: parsedSource.sourceHash,
    });
    if (!importedEntry) {
      skippedRecordCount += 1;
      continue;
    }

    importedEntryIds.push(importedEntry.id);
    importedRecordCount += 1;
    lastImportedSourceIndex = Math.max(lastImportedSourceIndex, sourceRecord.sourceIndex + 1);

    const previousRange = entryRanges.at(-1);
    const canExtend = previousRange
      && sourceRecord.sourceIndex === previousRange.sourceEndIndex + 1
      && importedEntry.id === previousRange.lastEntryId + 1;
    if (canExtend) {
      previousRange.sourceEndIndex = sourceRecord.sourceIndex;
      previousRange.lastEntryId = importedEntry.id;
      previousRange.messageCount += 1;
    } else {
      entryRanges.push({
        sourceStartIndex: sourceRecord.sourceIndex,
        sourceEndIndex: sourceRecord.sourceIndex,
        firstEntryId: importedEntry.id,
        lastEntryId: importedEntry.id,
        messageCount: 1,
      });
    }
  }

  const remainingAfterResume = Math.max(0, importableCount - resumedFromSourceIndex);
  if (importedRecordCount + skippedRecordCount < remainingAfterResume) {
    skippedRecordCount += remainingAfterResume - importedRecordCount - skippedRecordCount;
  }

  const nextSourceIndex = importedRecordCount > 0
    ? lastImportedSourceIndex
    : resumedFromSourceIndex;

  const manifest: LegacyChatImportManifest = {
    schemaVersion: IMPORT_MANIFEST_SCHEMA_VERSION,
    importId,
    channelId: params.request.channelId,
    sourcePath: params.request.sourcePath,
    sourceHash: parsedSource.sourceHash,
    sourceFormat: parsedSource.format,
    importedAt,
    resumedFromSourceIndex,
    nextSourceIndex,
    sourceRecordCount: importableCount,
    importedRecordCount,
    skippedRecordCount,
    entryRanges,
  };
  appendImportManifest(params.importManifestPath, manifest);

  return {
    manifest,
    importedEntryIds,
  };
}
