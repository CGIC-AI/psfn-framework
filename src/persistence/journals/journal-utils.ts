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
  JournalIntegrityVerificationResult,
  JournalMarkerEntry,
  JournalTurnTombstoneEntry,
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
