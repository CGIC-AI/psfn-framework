import { countTokens } from '../../../llm/tokens.js';
import type { LegacyChatImportRange, SessionStore } from '../../../persistence/sessions/store.js';
import type { SessionEntry } from '../types.js';
import { normalizeImportBootstrapMaxTokens } from '../manager-primitives.js';
import type { PreCompactionExtractionHandler } from './contracts.js';

export interface ImportedHistoryBootstrapChunk {
  startId: number;
  endId: number;
  entryCount: number;
  approxTokens: number;
}

export interface ImportedHistoryBootstrapResult {
  channelId: string;
  totalEntries: number;
  maxChunkTokens: number;
  chunkCount: number;
  processedChunks: number;
  chunks: ImportedHistoryBootstrapChunk[];
}

function collectImportedEntries(
  store: SessionStore,
  channelId: string,
  entryRanges: LegacyChatImportRange[],
): SessionEntry[] {
  if (entryRanges.length === 0) return [];

  const deduped = new Map<number, SessionEntry>();
  for (const range of entryRanges) {
    const entries = store.getEntriesInRange(
      channelId,
      range.firstEntryId,
      range.lastEntryId,
    );
    for (const entry of entries) {
      deduped.set(entry.id, entry);
    }
  }

  return [...deduped.values()].sort((left, right) => left.id - right.id);
}

function chunkImportedEntries(
  entries: SessionEntry[],
  maxChunkTokens: number,
): Array<{ entries: SessionEntry[]; tokens: number }> {
  const chunks: Array<{ entries: SessionEntry[]; tokens: number }> = [];
  let currentEntries: SessionEntry[] = [];
  let currentTokens = 0;

  for (const entry of entries) {
    const entryTokens = Math.max(1, countTokens(entry.content));
    const shouldStartNewChunk = currentEntries.length > 0 && currentTokens + entryTokens > maxChunkTokens;
    if (shouldStartNewChunk) {
      chunks.push({
        entries: currentEntries,
        tokens: currentTokens,
      });
      currentEntries = [];
      currentTokens = 0;
    }

    currentEntries.push(entry);
    currentTokens += entryTokens;
  }

  if (currentEntries.length > 0) {
    chunks.push({
      entries: currentEntries,
      tokens: currentTokens,
    });
  }

  return chunks;
}

export async function bootstrapImportedHistory(params: {
  store: SessionStore;
  channelId: string;
  entryRanges: LegacyChatImportRange[];
  canonicalContactId?: string;
  maxChunkTokens?: number;
  preCompactionExtractionHandler: PreCompactionExtractionHandler | null;
}): Promise<ImportedHistoryBootstrapResult> {
  const maxChunkTokens = normalizeImportBootstrapMaxTokens(params.maxChunkTokens);
  const importedEntries = collectImportedEntries(params.store, params.channelId, params.entryRanges);
  if (importedEntries.length === 0) {
    return {
      channelId: params.channelId,
      totalEntries: 0,
      maxChunkTokens,
      chunkCount: 0,
      processedChunks: 0,
      chunks: [],
    };
  }

  const chunkPlans = chunkImportedEntries(importedEntries, maxChunkTokens);
  let processedChunks = 0;
  for (const chunk of chunkPlans) {
    if (!params.preCompactionExtractionHandler) break;
    await params.preCompactionExtractionHandler({
      channelId: params.channelId,
      entries: [...chunk.entries],
      canonicalContactId: params.canonicalContactId,
    });
    processedChunks += 1;
  }

  return {
    channelId: params.channelId,
    totalEntries: importedEntries.length,
    maxChunkTokens,
    chunkCount: chunkPlans.length,
    processedChunks,
    chunks: chunkPlans.map(chunk => ({
      startId: chunk.entries[0].id,
      endId: chunk.entries[chunk.entries.length - 1].id,
      entryCount: chunk.entries.length,
      approxTokens: chunk.tokens,
    })),
  };
}
