// ── File-ingest faculty (htm9.9): channel-agnostic document ingestion ──
export {
  appendDocumentIngestToContent,
  DOCUMENT_MAX_BYTES,
  TEXT_DOCUMENT_MAX_BYTES,
  inferSupportedDocumentContentType,
  ingestDocumentAttachments,
  parseDocumentBytes,
  screenDocumentIngestSummary,
  toDocumentAttachmentCandidate,
  type DocumentAttachmentCandidate,
  type DocumentIngestChannel,
  type DocumentIngestContext,
  type DocumentIngestFailure,
  type DocumentIngestResult,
  type DocumentIngestSummary,
  type DocumentResourceFetch,
  type QuarantinedDocumentAttachment,
  type ScreenedDocumentIngest,
} from './document-ingest.js';
export {
  ATTACHMENT_QUARANTINE_STATUS,
  classifyAttachmentQuarantineRisk,
  hasAttachmentMetadataQuarantineRisk,
  normalizeAttachmentContentType,
  type AttachmentQuarantineDecision,
  type AttachmentQuarantineStatus,
} from './quarantine.js';
export {
  DOCM_CONTENT_TYPE,
  DOCX_CONTENT_TYPE,
  inferSupportedOfficeContentTypeFromName,
  isSupportedOfficeDocumentContentType,
  parseDocxDocument,
} from './office-document.js';
