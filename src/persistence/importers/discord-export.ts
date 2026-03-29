import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  createFilesystemSessionArchivePort,
  type RawL0MessageInput,
  type SessionArchivePort,
} from '../journals/journal/port.js';

interface DiscordExportAuthor {
  id: string;
  name: string;
  nickname?: string | null;
  isBot?: boolean;
}

interface DiscordExportAttachment {
  id?: string;
  fileName?: string;
  fileSizeBytes?: number;
  url?: string;
}

interface DiscordExportMessage {
  id: string;
  type: string;
  timestamp: string;
  content: string;
  author: DiscordExportAuthor;
  attachments?: DiscordExportAttachment[];
}

interface DiscordExportRoot {
  channel: {
    id: string;
    name?: string | null;
  };
  messages: DiscordExportMessage[];
}

export interface DiscordExportSessionSummary {
  channelId: string;
  filePath?: string;
  messageCount: number;
  firstTimestamp: number;
  lastTimestamp: number;
}

export interface ImportDiscordExportToL0Options {
  sourcePath: string;
  sessionsDir: string;
  channelId?: string;
  defaultChannelVisibility?: string;
  dryRun?: boolean;
  archivePort?: SessionArchivePort;
}

export interface DiscordExportImportResult {
  sourcePath: string;
  sessionsDir: string;
  dryRun: boolean;
  summary: DiscordExportSessionSummary;
}

function parseDiscordTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    throw new Error(`Invalid Discord export timestamp: ${value}`);
  }
  return timestamp;
}

function summarizeAttachments(attachments: readonly DiscordExportAttachment[] | undefined): string | null {
  if (!attachments || attachments.length === 0) return null;
  return attachments
    .map((attachment) => attachment.fileName?.trim() || attachment.url?.trim() || attachment.id?.trim() || 'attachment')
    .join(', ');
}

function buildMessageContent(message: DiscordExportMessage): string {
  const content = message.content.trim();
  if (content) return content;
  const attachmentSummary = summarizeAttachments(message.attachments);
  if (attachmentSummary) {
    return `[Discord attachment-only message: ${attachmentSummary}]`;
  }
  return '[Discord empty message; see metadata]';
}

function buildMetadata(message: DiscordExportMessage): string {
  return JSON.stringify({
    source: 'discord-export',
    discordExportType: message.type,
    attachments: message.attachments ?? [],
  });
}

function parseDiscordExport(sourcePath: string): DiscordExportRoot {
  const raw = readFileSync(sourcePath, 'utf8');
  return JSON.parse(raw) as DiscordExportRoot;
}

function toL0Message(message: DiscordExportMessage, channelId: string, visibility: string): RawL0MessageInput {
  return {
    role: message.author.isBot ? 'assistant' : 'user',
    content: buildMessageContent(message),
    authorId: message.author.id,
    authorName: message.author.nickname?.trim() || message.author.name.trim(),
    timestamp: parseDiscordTimestamp(message.timestamp),
    discordMessageId: message.id,
    metadata: buildMetadata(message),
    originChannelId: channelId,
    channelVisibility: visibility,
  };
}

export function importDiscordExportToL0(
  options: ImportDiscordExportToL0Options,
): DiscordExportImportResult {
  const sourcePath = resolve(options.sourcePath);
  if (!existsSync(sourcePath)) {
    throw new Error(`Discord export not found: ${sourcePath}`);
  }

  const sessionsDir = resolve(options.sessionsDir);
  const exportRoot = parseDiscordExport(sourcePath);
  const channelId = options.channelId?.trim() || exportRoot.channel.id.trim();
  const visibility = options.defaultChannelVisibility?.trim() || 'private';
  const messages = exportRoot.messages.map(message => toL0Message(message, channelId, visibility));
  if (messages.length === 0) {
    throw new Error(`Discord export contained no messages: ${sourcePath}`);
  }

  const firstTimestamp = messages[0]!.timestamp;
  const lastTimestamp = messages[messages.length - 1]!.timestamp;
  const written = options.dryRun
    ? null
    : (options.archivePort ?? createFilesystemSessionArchivePort()).writeImportedSession({
      sessionsDir,
      channelId,
      seedTimestamp: firstTimestamp,
      seedAuthorId: messages[0]!.authorId,
      seedAuthorName: messages[0]!.authorName,
      messages,
    });

  return {
    sourcePath,
    sessionsDir,
    dryRun: options.dryRun ?? false,
    summary: {
      channelId,
      filePath: written?.filePath,
      messageCount: messages.length,
      firstTimestamp,
      lastTimestamp,
    },
  };
}

export function describeDiscordExportSource(sourcePath: string): string {
  return basename(resolve(sourcePath));
}
