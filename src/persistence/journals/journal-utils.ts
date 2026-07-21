export {
  parseLegacyChatSource,
} from './journal/legacy-source.js';

export {
  appendJournalEntry,
  fingerprintJournalArchive,
  parseJournalText,
  persistQuarantinedEntries,
  quarantineSidecarPath,
  readJournalFile,
  readJournalEntriesBefore,
  readJournalFirstEntry,
  readJournalMatchingEntriesBackward,
  readJournalTailEntries,
  scanJournalLinesBackward,
  scanJournalFileMetadata,
  writeJournalFileAtomic,
} from './journal/file-io.js';

export {
  buildSessionHmacKeyring,
  computeJournalEntryHmac,
  resolveJournalIntegrityChainCandidates,
  signJournalEntry,
  verifyJournalEntryIntegrity,
  wrapUnverifiedHistory,
} from './journal/integrity.js';

export {
  buildCompactionJournalEntry,
  buildExtractionMarkerJournalEntry,
  buildGracefulShutdownMarkerJournalEntry,
  buildMessageJournalEntry,
  buildTurnTombstoneJournalEntry,
  journalToCompactionSummary,
  journalToMarkerEntry,
  journalToSessionEntry,
  journalToTurnTombstoneEntry,
} from './journal/entries.js';

export type {
  JournalFileMetadata,
  JournalBoundedReadStats,
  JournalIntegrityVerificationResult,
  JournalMarkerEntry,
  JournalTurnTombstoneEntry,
  LegacyChatSourceFormat,
  LegacyChatSourceRecord,
  ParsedLegacyChatSource,
  QuarantinedJournalEntry,
  ReadJournalFileOptions,
  ReadJournalBeforeOptions,
  ReadJournalBeforeResult,
  ReadJournalResult,
  ReadJournalTailOptions,
  ReadJournalTailResult,
  ScanJournalMetadataOptions,
  SessionHmacKeyring,
  SessionHmacKeyringInput,
} from './journal/types.js';
