import { createHash } from 'node:crypto';
import type { SessionEntry } from './types.js';
import { buildSessionSummarySourceBlock } from './manager-primitives.js';

const SOURCE_BLOCK_SHA256_TAG_PATTERN = /<source_block_sha256\s+first_message_id="(\d+)"\s+last_message_id="(\d+)"\s+message_count="(\d+)">([0-9a-f]{64})<\/source_block_sha256>/gi;

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
  const firstEntry = entries[0];
  const lastEntry = entries[entries.length - 1];
  if (firstEntry === undefined || lastEntry === undefined) return null;
  const firstMessageId = firstEntry.id;
  const lastMessageId = lastEntry.id;
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

export function findLatestCompactionSourceHashTagStart(summary: string): number {
  return [...summary.matchAll(SOURCE_BLOCK_SHA256_TAG_PATTERN)].at(-1)?.index ?? -1;
}

export function parseCompactionSourceHashTag(summary: string): CompactionSourceHashMetadata | null {
  // The authoritative tag is appended by the runtime after model-generated
  // summary text. Selecting the last syntactically valid tag prevents a
  // summary that happens to contain tag-shaped prose from shadowing it.
  const match = [...summary.matchAll(SOURCE_BLOCK_SHA256_TAG_PATTERN)].at(-1);
  if (!match) return null;

  const rawFirstMessageId = match[1];
  const rawLastMessageId = match[2];
  const rawMessageCount = match[3];
  const rawSha256 = match[4];
  if (
    rawFirstMessageId === undefined
    || rawLastMessageId === undefined
    || rawMessageCount === undefined
    || rawSha256 === undefined
  ) {
    return null;
  }

  const firstMessageId = Number.parseInt(rawFirstMessageId, 10);
  const lastMessageId = Number.parseInt(rawLastMessageId, 10);
  const messageCount = Number.parseInt(rawMessageCount, 10);
  const sha256 = rawSha256.toLowerCase();

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

export function stripCompactionSourceHashTags(summary: string): string {
  return summary.replace(SOURCE_BLOCK_SHA256_TAG_PATTERN, '').trim();
}
