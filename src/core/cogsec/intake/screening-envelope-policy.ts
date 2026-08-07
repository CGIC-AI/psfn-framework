/**
 * Code-owned bounds for the normalized CogSec screening envelope.
 * These limits protect durable evidence and protocol surfaces; they are shared
 * so every screening layer produces mutually compatible records.
 */
export const COGSEC_DECISION_REASON_MAX_CHARS = 1_024;
export const COGSEC_EVIDENCE_FIELD_MAX_CHARS = 4_096;
export const COGSEC_ORIGIN_DETAIL_MAX_CHARS = 512;
export const COGSEC_TRANSPORT_ERROR_MAX_CHARS = 500;
export const COGSEC_MARKING_SOURCE_REF_MAX_CHARS = 300;
export const COGSEC_EVENT_SAFE_TEXT_MAX_CHARS = 600;
