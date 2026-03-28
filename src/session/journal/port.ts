import type { JournalEntry } from '../types.js';
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

export interface SessionJournalPort {
  appendJournalEntry(filePath: string, entry: JournalEntry): void;
  quarantineSidecarPath(filePath: string): string;
  readJournalFile(filePath: string, options?: ReadJournalFileOptions): ReadJournalResult;
  readJournalFirstEntry(filePath: string): JournalEntry | null;
  readJournalTailEntries(filePath: string, options: ReadJournalTailOptions): ReadJournalTailResult;
  scanJournalFileMetadata(filePath: string, options?: ScanJournalMetadataOptions): JournalFileMetadata;
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
