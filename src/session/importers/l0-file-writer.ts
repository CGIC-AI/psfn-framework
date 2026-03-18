import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildMessageJournalEntry } from '../journal-utils.js';
import { makeReadableFilePath } from '../store/channel-filenames.js';
import type { SessionEntryRole } from '../types.js';

export interface RawL0MessageInput {
  role: SessionEntryRole;
  content: string;
  authorId?: string;
  authorName?: string;
  timestamp: number;
  discordMessageId?: string;
  metadata?: string;
  originChannelId?: string;
  channelVisibility?: string;
}

export interface WriteL0SessionFileOptions {
  sessionsDir: string;
  channelId: string;
  seedTimestamp: number;
  seedAuthorId?: string;
  seedAuthorName?: string;
  messages: readonly RawL0MessageInput[];
}

export interface WrittenL0SessionFile {
  filePath: string;
  entryCount: number;
}

export function writeL0SessionFile(
  options: WriteL0SessionFileOptions,
): WrittenL0SessionFile {
  if (options.messages.length === 0) {
    throw new Error(`Cannot write empty L0 session file for ${options.channelId}`);
  }

  const sessionsDir = resolve(options.sessionsDir);
  mkdirSync(sessionsDir, { recursive: true });

  const filePath = makeReadableFilePath(sessionsDir, options.channelId, {
    timestamp: options.seedTimestamp,
    authorId: options.seedAuthorId,
    authorName: options.seedAuthorName,
  });

  const journalText = options.messages
    .map((message, index) => JSON.stringify(buildMessageJournalEntry(index + 1, {
      channelId: options.channelId,
      role: message.role,
      content: message.content,
      authorId: message.authorId,
      authorName: message.authorName,
      timestamp: message.timestamp,
      discordMessageId: message.discordMessageId,
      metadata: message.metadata,
      originChannelId: message.originChannelId,
      channelVisibility: message.channelVisibility,
    })))
    .join('\n');

  writeFileSync(filePath, `${journalText}\n`, 'utf8');
  return {
    filePath,
    entryCount: options.messages.length,
  };
}
