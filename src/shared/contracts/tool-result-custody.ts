// ── Tool-result custody edge (psfn-framework-ccgdz.5) ──
//
// One tool result's durable answer to "which admitted bytes did the model
// actually see, and which intake envelope admitted them?".
//
// This lives in `shared/contracts` rather than beside the custody snapshot
// because both ends of the edge need it: `TurnRecordToolCall` stamps it on the
// turn record, and the CogSec custody snapshot folds the same value in as the
// tool-result contribution. One type, one producer, so the two can be compared
// for equality rather than reconciled.
//
// Content-free: an envelope id, a hash, or a closed-vocabulary reason. Never a
// result body, never a preview.

import { isRecord } from '../utils/types.js';

/**
 * Why a tool result carries no content hash.
 *
 * - `withheld`   — enforce-mode quarantine replaced the result before the model
 *                  saw it, so the bytes on the message are the fixed withheld
 *                  placeholder. Hashing them would record boilerplate as if it
 *                  were evidence of what the model consumed.
 * - `unscreened` — the intake firewall produced no envelope for this result at
 *                  all. There is no admission identity to bind a hash to, and a
 *                  bare hash could later be mistaken for custody, so the gap is
 *                  recorded explicitly instead.
 */
const TOOL_RESULT_CUSTODY_ABSENCE_REASONS = [
  'withheld',
  'unscreened',
] as const;

type ToolResultCustodyAbsenceReason =
  typeof TOOL_RESULT_CUSTODY_ABSENCE_REASONS[number];

function isToolResultCustodyAbsenceReason(
  value: unknown,
): value is ToolResultCustodyAbsenceReason {
  return typeof value === 'string'
    && (TOOL_RESULT_CUSTODY_ABSENCE_REASONS as readonly string[]).includes(value);
}

/**
 * The custody edge for one observed tool result. Exactly one of
 * `contentSha256` and `absenceReason` is present: either the bytes the model
 * consumed are identified, or the reason they are not is named. There is no
 * third state in which the edge says nothing.
 */
export interface ToolResultCustodyEdge {
  /** The intake envelope that admitted this result; absent when unscreened. */
  readonly envelopeId?: string;
  /** sha256 of the exact result text the model saw. */
  readonly contentSha256?: string;
  readonly absenceReason?: ToolResultCustodyAbsenceReason;
}

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const ENVELOPE_ID_PATTERN = /^[A-Za-z0-9_:.@+-]{1,128}$/u;

/**
 * Validate a stored or transported edge. Fails closed: a malformed edge is a
 * refusal, never a silently dropped field, because the edge is the only thing
 * standing between "this result was admitted" and an unproved claim.
 */
export function validateToolResultCustodyEdge(
  value: unknown,
  field = 'toolResultCustody',
): ToolResultCustodyEdge {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  const hasHash = value.contentSha256 !== undefined;
  const hasAbsence = value.absenceReason !== undefined;
  if (hasHash === hasAbsence) {
    throw new Error(`${field} must carry exactly one of contentSha256 or absenceReason`);
  }
  if (hasHash
    && (typeof value.contentSha256 !== 'string'
      || !SHA256_HEX_PATTERN.test(value.contentSha256))) {
    throw new Error(`${field}.contentSha256 must be 64 lowercase hex characters`);
  }
  if (hasAbsence && !isToolResultCustodyAbsenceReason(value.absenceReason)) {
    throw new Error(`${field}.absenceReason must be a known absence reason`);
  }
  if (value.envelopeId !== undefined
    && (typeof value.envelopeId !== 'string' || !ENVELOPE_ID_PATTERN.test(value.envelopeId))) {
    throw new Error(`${field}.envelopeId must be a bounded envelope identifier`);
  }
  return {
    ...(value.envelopeId !== undefined ? { envelopeId: value.envelopeId as string } : {}),
    ...(hasHash ? { contentSha256: value.contentSha256 as string } : {}),
    ...(hasAbsence
      ? { absenceReason: value.absenceReason as ToolResultCustodyAbsenceReason }
      : {}),
  };
}

/**
 * The content-free lineage reference for one tool result, shared by the
 * disclosure fold, the custody snapshot, and the TurnRecord tool call. Derived
 * in exactly one place so the join key cannot drift between them.
 */
export function toolResultLineageRef(toolName: string, toolCallId?: string): string {
  const name = toolName.trim();
  const callId = toolCallId?.trim();
  return callId ? `tool:${name}:${callId}` : `tool:${name}`;
}
