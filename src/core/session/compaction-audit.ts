import { createHash } from 'node:crypto';
import type { SessionEntry } from './types.js';
import { buildSessionSummarySourceBlock } from './manager-primitives.js';

const SOURCE_BLOCK_SHA256_TAG_PATTERN = /<source_block_sha256\s+first_message_id="(\d+)"\s+last_message_id="(\d+)"\s+message_count="(\d+)">([0-9a-f]{64})<\/source_block_sha256>/i;

export interface CompactionSourceHashMetadata {
  firstMessageId: number;
  lastMessageId: number;
  messageCount: number;
  sha256: string;
}

export function buildCompactionSourceBlock(entries: SessionEntry[]): string {
  return buildSessionSummarySourceBlock({ entries });
}

export function computeCompactionSourceSha256(sourceBlock: string): string {
  return createHash('sha256')
    .update(sourceBlock, 'utf8')
    .digest('hex');
}

export function buildCompactionSourceHashMetadata(
  entries: SessionEntry[],
): CompactionSourceHashMetadata | null {
  if (entries.length === 0) return null;
  const firstMessageId = entries[0].id;
  const lastMessageId = entries[entries.length - 1].id;
  if (!Number.isInteger(firstMessageId) || !Number.isInteger(lastMessageId) || firstMessageId <= 0 || lastMessageId <= 0) {
    return null;
  }

  return {
    firstMessageId,
    lastMessageId,
    messageCount: entries.length,
    sha256: computeCompactionSourceSha256(buildCompactionSourceBlock(entries)),
  };
}

export function formatCompactionSourceHashTag(metadata: CompactionSourceHashMetadata): string {
  return (
    `<source_block_sha256 first_message_id="${metadata.firstMessageId}" `
    + `last_message_id="${metadata.lastMessageId}" `
    + `message_count="${metadata.messageCount}">${metadata.sha256}</source_block_sha256>`
  );
}

export function buildCompactionSourceHashTag(entries: SessionEntry[]): string {
  const metadata = buildCompactionSourceHashMetadata(entries);
  return metadata ? formatCompactionSourceHashTag(metadata) : '';
}

export function parseCompactionSourceHashTag(summary: string): CompactionSourceHashMetadata | null {
  const match = SOURCE_BLOCK_SHA256_TAG_PATTERN.exec(summary);
  if (!match) return null;

  const firstMessageId = Number.parseInt(match[1], 10);
  const lastMessageId = Number.parseInt(match[2], 10);
  const messageCount = Number.parseInt(match[3], 10);
  const sha256 = match[4].toLowerCase();

  if (!Number.isInteger(firstMessageId) || firstMessageId <= 0) return null;
  if (!Number.isInteger(lastMessageId) || lastMessageId <= 0) return null;
  if (!Number.isInteger(messageCount) || messageCount <= 0) return null;
  if (lastMessageId < firstMessageId) return null;

  return {
    firstMessageId,
    lastMessageId,
    messageCount,
    sha256,
  };
}
