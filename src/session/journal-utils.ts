export {
  parseLegacyChatSource,
} from './journal/legacy-source.js';

export {
  appendJournalEntry,
  parseJournalText,
  persistQuarantinedEntries,
  quarantineSidecarPath,
  readJournalFile,
  readJournalFirstEntry,
  readJournalTailEntries,
  scanJournalFileMetadata,
} from './journal/file-io.js';

export {
  buildSessionHmacKeyring,
  computeJournalEntryHmac,
  signJournalEntry,
  verifyJournalEntryIntegrity,
  wrapUnverifiedHistory,
} from './journal/integrity.js';

export {
  buildCompactionJournalEntry,
  buildExtractionMarkerJournalEntry,
  buildGracefulShutdownMarkerJournalEntry,
  buildMessageJournalEntry,
  journalToCompactionSummary,
  journalToMarkerEntry,
  journalToSessionEntry,
} from './journal/entries.js';

export type {
  JournalFileMetadata,
  JournalIntegrityVerificationResult,
  JournalMarkerEntry,
  LegacyChatSourceFormat,
  LegacyChatSourceRecord,
  ParsedLegacyChatSource,
  QuarantinedJournalEntry,
  ReadJournalFileOptions,
  ReadJournalResult,
  ReadJournalTailOptions,
  ReadJournalTailResult,
  ScanJournalMetadataOptions,
  SessionHmacKeyring,
  SessionHmacKeyringInput,
} from './journal/types.js';
