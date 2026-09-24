import { createHash } from 'node:crypto';

/**
 * Content-free audit of every foreign captured-session read escape
 * (psfn-framework-ls15s). A turn owns exactly one captured session; reading a
 * different session is an explicit, audited escape hatch.
 *
 * The reason is a stable code, never free text: each code names one reviewed
 * call site. Adding a new escape requires adding its code here.
 */
const FOREIGN_SESSION_READ_REASONS = [
  /** Group reflection resolves the reflected room's ConversationScope. */
  'reflection_group_conversation_scope',
] as const;

export type ForeignSessionReadReason = typeof FOREIGN_SESSION_READ_REASONS[number];

const FOREIGN_SESSION_READ_REASON_SET: ReadonlySet<string> = new Set(FOREIGN_SESSION_READ_REASONS);

/**
 * One bounded event per admitted foreign read. Session identities are opaque
 * digests; no message, transcript, or raw session identifier is carried.
 */
export interface ForeignSessionReadAuditEvent {
  reason: ForeignSessionReadReason;
  sourceSessionRef: string;
  targetSessionRef: string;
  timestamp: number;
}

/**
 * Synchronous audit sink. Fail-closed policy: a sink that throws refuses the
 * foreign read before any foreign session data is touched.
 */
export type ForeignSessionReadAuditSink = (event: ForeignSessionReadAuditEvent) => void;

const SESSION_REF_PREFIX = 'session-ref:';
const SESSION_REF_HEX_LENGTH = 24;

export function parseForeignSessionReadReason(value: string): ForeignSessionReadReason {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error('Foreign captured-session read requires a non-empty audit reason code');
  }
  if (!FOREIGN_SESSION_READ_REASON_SET.has(normalized)) {
    throw new Error(`Foreign captured-session read reason "${normalized}" is not a registered audit reason code`);
  }
  return normalized as ForeignSessionReadReason;
}

export function opaqueSessionRef(logicalSessionId: string): string {
  const digest = createHash('sha256').update(logicalSessionId).digest('hex');
  return `${SESSION_REF_PREFIX}${digest.slice(0, SESSION_REF_HEX_LENGTH)}`;
}

export function buildForeignSessionReadAuditEvent(input: {
  reason: ForeignSessionReadReason;
  sourceLogicalSessionId: string;
  targetLogicalSessionId: string;
  timestamp: number;
}): ForeignSessionReadAuditEvent {
  return {
    reason: input.reason,
    sourceSessionRef: opaqueSessionRef(input.sourceLogicalSessionId),
    targetSessionRef: opaqueSessionRef(input.targetLogicalSessionId),
    timestamp: input.timestamp,
  };
}
