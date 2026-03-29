import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { JournalEntry } from '../../../core/session/types.js';
import { buildMessageJournalEntry } from './entries.js';
import type {
  JournalFileMetadata,
  ReadJournalFileOptions,
  ReadJournalResult,
  ReadJournalTailOptions,
  ReadJournalTailResult,
  ScanJournalMetadataOptions,
} from './types.js';
import {
  appendJournalEntry,
  quarantineSidecarPath,
  readJournalFile,
  readJournalFirstEntry,
  readJournalTailEntries,
  scanJournalFileMetadata,
} from './file-io.js';
import { makeReadableFilePath } from '../../sessions/store/channel-filenames.js';
import type { SessionEntryRole } from '../../../core/session/types.js';
import type { SessionFileSeed } from '../../sessions/store-primitives.js';

export interface SessionJournalPort {
  appendJournalEntry(filePath: string, entry: JournalEntry): void;
  quarantineSidecarPath(filePath: string): string;
  readJournalFile(filePath: string, options?: ReadJournalFileOptions): ReadJournalResult;
  readJournalFirstEntry(filePath: string): JournalEntry | null;
  readJournalTailEntries(filePath: string, options: ReadJournalTailOptions): ReadJournalTailResult;
  scanJournalFileMetadata(filePath: string, options?: ScanJournalMetadataOptions): JournalFileMetadata;
}

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

export interface SessionArchiveHandle {
  channelId: string;
}

interface FilesystemSessionArchiveHandle extends SessionArchiveHandle {
  filePath: string;
}

export interface SessionArchivePort {
  openArchive(channelId: string, filePath: string): SessionArchiveHandle;
  createArchive(
    sessionsDir: string,
    channelId: string,
    seed: SessionFileSeed,
  ): SessionArchiveHandle;
  resolveArchivePath(handle: SessionArchiveHandle): string;
  appendJournalEntry(handle: SessionArchiveHandle, entry: JournalEntry): void;
  quarantineSidecarPath(handle: SessionArchiveHandle): string;
  readJournalFile(handle: SessionArchiveHandle, options?: ReadJournalFileOptions): ReadJournalResult;
  readJournalFirstEntry(handle: SessionArchiveHandle): JournalEntry | null;
  readJournalTailEntries(handle: SessionArchiveHandle, options: ReadJournalTailOptions): ReadJournalTailResult;
  scanJournalFileMetadata(
    handle: SessionArchiveHandle,
    options?: ScanJournalMetadataOptions,
  ): JournalFileMetadata;
  writeImportedSession(options: WriteL0SessionFileOptions): WrittenL0SessionFile;
}

export function createFilesystemSessionJournalPort(): SessionJournalPort {
  return {
    appendJournalEntry,
    quarantineSidecarPath,
    readJournalFile,
    readJournalFirstEntry,
    readJournalTailEntries,
    scanJournalFileMetadata,
  };
}

function requireFilesystemHandle(handle: SessionArchiveHandle): FilesystemSessionArchiveHandle {
  const candidate = handle as FilesystemSessionArchiveHandle;
  if (typeof candidate.filePath !== 'string' || candidate.filePath.length === 0) {
    throw new Error(`Session archive handle for ${handle.channelId} is not a filesystem-backed archive`);
  }
  return candidate;
}

export function createFilesystemSessionArchivePort(
  journalPort: SessionJournalPort = createFilesystemSessionJournalPort(),
): SessionArchivePort {
  return {
    openArchive: (channelId, filePath) => ({
      channelId,
      filePath: resolve(filePath),
    }),
    createArchive: (sessionsDir, channelId, seed) => {
      const resolvedSessionsDir = resolve(sessionsDir);
      mkdirSync(resolvedSessionsDir, { recursive: true });
      return {
        channelId,
        filePath: makeReadableFilePath(resolvedSessionsDir, channelId, seed),
      };
    },
    resolveArchivePath: (handle) => requireFilesystemHandle(handle).filePath,
    appendJournalEntry: (handle, entry) => (
      journalPort.appendJournalEntry(requireFilesystemHandle(handle).filePath, entry)
    ),
    quarantineSidecarPath: (handle) => (
      journalPort.quarantineSidecarPath(requireFilesystemHandle(handle).filePath)
    ),
    readJournalFile: (handle, options) => (
      journalPort.readJournalFile(requireFilesystemHandle(handle).filePath, options)
    ),
    readJournalFirstEntry: (handle) => (
      journalPort.readJournalFirstEntry(requireFilesystemHandle(handle).filePath)
    ),
    readJournalTailEntries: (handle, options) => (
      journalPort.readJournalTailEntries(requireFilesystemHandle(handle).filePath, options)
    ),
    scanJournalFileMetadata: (handle, options) => (
      journalPort.scanJournalFileMetadata(requireFilesystemHandle(handle).filePath, options)
    ),
    writeImportedSession: (options) => {
      if (options.messages.length === 0) {
        throw new Error(`Cannot write empty L0 session file for ${options.channelId}`);
      }

      const resolvedSessionsDir = resolve(options.sessionsDir);
      mkdirSync(resolvedSessionsDir, { recursive: true });
      const filePath = makeReadableFilePath(resolvedSessionsDir, options.channelId, {
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
    },
  };
}
