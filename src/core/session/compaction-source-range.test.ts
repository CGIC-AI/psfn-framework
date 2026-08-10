import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../persistence/sessions/store.js';
import { buildMessageJournalEntry } from '../../persistence/journals/journal-utils.js';
import { makeRolledFilePath } from '../../persistence/sessions/store/channel-filenames.js';
import {
  buildCompactionSourceHashTag,
  buildCompactionSourceHashMetadata,
  formatCompactionSourceHashTag,
} from './compaction-audit.js';
import { resolveLatestCompactionSourceRange } from './compaction-source-range.js';
import type { CompactionSummary, SessionEntry } from './types.js';
import { createCompactionBoundaryStore } from './manager/compaction-boundary-store.js';
import { COMPACTION_SOURCE_DETAIL_HINT } from '../identity/prompt-composer.js';

describe('latest compaction source range', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('verifies an exact source range across rolled journals with non-message gaps', () => {
    const dir = mkdtempSync(join(tmpdir(), 'psfn-compaction-source-'));
    dirs.push(dir);
    const channelId = 'api:addressable';
    const rootPath = join(dir, '20260810_api-addressable_user_000001.jsonl');
    const segmentPath = makeRolledFilePath(rootPath, 2);
    const first = buildMessageJournalEntry(1, {
      channelId,
      role: 'user',
      content: 'Opening text with image context.',
      timestamp: 1_000,
      metadata: JSON.stringify({ imageRefs: ['image-1'] }),
    });
    const second = buildMessageJournalEntry(2, {
      channelId,
      role: 'assistant',
      content: 'Review of the image context.',
      timestamp: 2_000,
    });
    const marker = {
      type: 'marker' as const,
      id: 3,
      channelId,
      timestamp: 3_000,
      marker: 'extraction' as const,
      coveredUpTo: 2,
    };
    const fourth = buildMessageJournalEntry(4, {
      channelId,
      role: 'user',
      content: 'Decision after the extraction marker.',
      timestamp: 4_000,
    });
    writeFileSync(rootPath, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n${JSON.stringify(marker)}\n`);
    writeFileSync(segmentPath, `${JSON.stringify(fourth)}\n`);

    const store = new SessionStore(dir);
    const sourceEntries = store.getEntriesInRange(channelId, 1, 4);
    expect(sourceEntries.map(entry => entry.id)).toEqual([1, 2, 4]);
    store.insertCompaction(
      channelId,
      `Durable summary.\n\n${buildCompactionSourceHashTag(sourceEntries)}`,
      4,
    );

    const result = resolveLatestCompactionSourceRange(store, channelId);
    expect(result).toMatchObject({
      status: 'verified',
      channelId,
      firstMessageId: 1,
      lastMessageId: 4,
      messageCount: 3,
      coveredUpTo: 4,
    });
    expect(result.status === 'verified' ? result.entries.map(entry => entry.id) : []).toEqual([1, 2, 4]);
  });

  it('selects one latest summary snapshot even if a newer compaction arrives during its source read', () => {
    const entries: SessionEntry[] = [
      { id: 1, channelId: 'api:stable', role: 'user', content: 'one', timestamp: 1 },
      { id: 2, channelId: 'api:stable', role: 'assistant', content: 'two', timestamp: 2 },
    ];
    const metadata = buildCompactionSourceHashMetadata(entries);
    if (!metadata) throw new Error('Expected source metadata');
    const summaries: CompactionSummary[] = [{
      id: 3,
      channelId: 'api:stable',
      summary: `first\n${formatCompactionSourceHashTag(metadata)}`,
      coveredUpTo: 2,
      createdAt: 3,
    }];
    const store = {
      getCompactionSummaries: () => [...summaries],
      getEntriesInRange: () => {
        summaries.push({
          id: 4,
          channelId: 'api:stable',
          summary: 'newer legacy summary',
          coveredUpTo: 2,
          createdAt: 4,
        });
        return entries;
      },
    };

    expect(resolveLatestCompactionSourceRange(store, 'api:stable')).toMatchObject({
      status: 'verified',
      summaryEntryId: 3,
    });
  });

  it('selects the newest pre-existing compaction instead of an older valid range', () => {
    const channelId = 'api:multiple';
    const olderEntries: SessionEntry[] = [
      { id: 1, channelId, role: 'user', content: 'older', timestamp: 1 },
    ];
    const newerEntries: SessionEntry[] = [
      { id: 4, channelId, role: 'user', content: 'newer', timestamp: 4 },
      { id: 5, channelId, role: 'assistant', content: 'newer reply', timestamp: 5 },
    ];
    const olderMetadata = buildCompactionSourceHashMetadata(olderEntries);
    const newerMetadata = buildCompactionSourceHashMetadata(newerEntries);
    if (!olderMetadata || !newerMetadata) throw new Error('Expected source metadata');
    const store = {
      getCompactionSummaries: () => [
        {
          id: 2,
          channelId,
          summary: formatCompactionSourceHashTag(olderMetadata),
          coveredUpTo: 1,
          createdAt: 2,
        },
        {
          id: 6,
          channelId,
          summary: formatCompactionSourceHashTag(newerMetadata),
          coveredUpTo: 5,
          createdAt: 6,
        },
      ],
      getEntriesInRange: (_requestedChannelId: string, firstMessageId: number) => (
        firstMessageId === 4 ? newerEntries : olderEntries
      ),
    };

    const result = resolveLatestCompactionSourceRange(store, channelId);
    expect(result).toMatchObject({
      status: 'verified',
      summaryEntryId: 6,
      firstMessageId: 4,
      lastMessageId: 5,
    });
  });

  it.each([
    {
      name: 'legacy summary',
      summary: 'Legacy summary without metadata.',
      expected: 'legacy_metadata',
    },
    {
      name: 'malformed metadata',
      summary: '<source_block_sha256 malformed>',
      expected: 'invalid_metadata',
    },
  ])('reports $name without widening the source range', ({ summary, expected }) => {
    const store = {
      getCompactionSummaries: () => [{
        id: 2,
        channelId: 'api:legacy',
        summary,
        coveredUpTo: 1,
        createdAt: 2,
      }],
      getEntriesInRange: () => {
        throw new Error('Unavailable metadata must not trigger a source read');
      },
    };
    expect(resolveLatestCompactionSourceRange(store, 'api:legacy').status).toBe(expected);
  });

  it('fails closed when source content is missing or changed', () => {
    const original: SessionEntry[] = [
      { id: 1, channelId: 'api:damaged', role: 'user', content: 'original', timestamp: 1 },
      { id: 2, channelId: 'api:damaged', role: 'assistant', content: 'reply', timestamp: 2 },
    ];
    const metadata = buildCompactionSourceHashMetadata(original);
    if (!metadata) throw new Error('Expected source metadata');
    const store = {
      getCompactionSummaries: () => [{
        id: 3,
        channelId: 'api:damaged',
        summary: formatCompactionSourceHashTag(metadata),
        coveredUpTo: 2,
        createdAt: 3,
      }],
      getEntriesInRange: () => [{ ...original[0]!, content: 'changed' }],
    };

    expect(resolveLatestCompactionSourceRange(store, 'api:damaged')).toMatchObject({
      status: 'source_mismatch',
    });

    const promptStore = createCompactionBoundaryStore(store as unknown as SessionStore);
    expect(promptStore.getCompactionSummaries('api:damaged')[0]?.summary).not.toContain(
      COMPACTION_SOURCE_DETAIL_HINT,
    );
  });
});
