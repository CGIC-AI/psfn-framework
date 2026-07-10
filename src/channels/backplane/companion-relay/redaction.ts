import type {
  ConfirmationQueueEntry,
  ConfirmationResolutionStatus,
} from '../../../system/capabilities/confirmation-queue.js';
import type {
  CompanionApprovalRequestedPayload,
  CompanionApprovalResolvedPayload,
  CompanionApprovalResolutionStatus,
  CompanionArtifactCreatedPayload,
  CompanionToolActivityPayload,
  CompanionToolActivityPhase,
} from '../../../shared/contracts/companion-relay.js';

/**
 * Redaction at emission (epic w9hj acceptance criterion 5).
 *
 * Every companion event payload is CONSTRUCTED here from an explicit
 * whitelist of fields. Nothing is spread or copied wholesale from source
 * objects, so raw tool params, file paths, file contents, transcript text,
 * and chain-of-thought can never survive into a payload — the tests in
 * redaction.test.ts prove the exact output key sets.
 */

const MAX_TITLE_LENGTH = 160;
const MAX_CONTEXT_LENGTH = 280;
const MAX_LABEL_LENGTH = 120;
const MAX_TOOL_NAME_LENGTH = 120;
const MAX_ID_LENGTH = 160;
const MAX_PROVENANCE_LENGTH = 120;
const MAX_MEDIA_TYPE_LENGTH = 100;

function clampText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function toIsoTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs)) {
    throw new Error('Cannot redact event: non-finite timestamp');
  }
  return new Date(epochMs).toISOString();
}

function requireId(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`Cannot redact event: missing ${fieldName}`);
  }
  return clampText(normalized, MAX_ID_LENGTH);
}

/**
 * Approval request → redacted payload. Only the action verb, scope, and the
 * companion-authored reason survive; `entry.params` (raw tool params) and
 * `entry.method` internals never do.
 */
export function redactApprovalRequested(
  entry: Pick<ConfirmationQueueEntry, 'id' | 'action' | 'scope' | 'companionReason' | 'requestedAt' | 'expiresAt'>,
): CompanionApprovalRequestedPayload {
  return {
    id: requireId(entry.id, 'approval id'),
    title: clampText(`${entry.action}: ${entry.scope}`, MAX_TITLE_LENGTH),
    requestedAt: toIsoTimestamp(entry.requestedAt),
    ...(Number.isFinite(entry.expiresAt) && entry.expiresAt > 0
      ? { expiresAt: toIsoTimestamp(entry.expiresAt) }
      : {}),
    redactedContext: clampText(entry.companionReason, MAX_CONTEXT_LENGTH),
    status: 'pending',
  };
}

/**
 * Maps internal confirmation-queue resolution statuses onto the hub protocol
 * statuses. `modified` executed with operator-adjusted params, so it reads as
 * approved; `failed` means the approved action was blocked from executing.
 * `not_found` never resolves a real entry and must not be emitted.
 */
export function toCompanionApprovalStatus(
  status: ConfirmationResolutionStatus,
): CompanionApprovalResolutionStatus {
  switch (status) {
    case 'approved':
    case 'modified':
      return 'approved';
    case 'denied':
      return 'denied';
    case 'expired':
      return 'expired';
    case 'failed':
      return 'blocked';
    case 'not_found':
      throw new Error('Cannot redact approval resolution: not_found is not an emittable status');
    default: {
      const exhausted: never = status;
      throw new Error(`Cannot redact approval resolution: unknown status ${String(exhausted)}`);
    }
  }
}

export function redactApprovalResolved(input: {
  id: string;
  status: ConfirmationResolutionStatus;
  resolvedAt: number;
}): CompanionApprovalResolvedPayload {
  return {
    id: requireId(input.id, 'approval id'),
    status: toCompanionApprovalStatus(input.status),
    resolvedAt: toIsoTimestamp(input.resolvedAt),
  };
}

/**
 * Tool lifecycle → redacted activity. Only the tool name and phase survive.
 * Error messages, arguments, results, and shard identifiers are dropped:
 * `detail` is intentionally never populated from runtime data.
 */
export function redactToolActivity(input: {
  toolCallId: string;
  toolName: string;
  phase: CompanionToolActivityPhase;
  timestampMs: number;
}): CompanionToolActivityPayload {
  return {
    id: requireId(input.toolCallId, 'tool call id'),
    tool: clampText(input.toolName, MAX_TOOL_NAME_LENGTH) || 'unknown_tool',
    phase: input.phase,
    timestamp: toIsoTimestamp(input.timestampMs),
  };
}

/**
 * Generated media → redacted artifact announcement. The artifact label is a
 * display name only; local filesystem paths, URLs, and bytes never enter the
 * payload (preview access flows through the gated preview endpoint instead).
 */
export function redactArtifactCreated(input: {
  artifactId: string;
  label: string;
  mediaType: string;
  provenance: string;
  createdAtMs: number;
  previewable: boolean;
}): CompanionArtifactCreatedPayload {
  return {
    id: requireId(input.artifactId, 'artifact id'),
    label: clampText(input.label, MAX_LABEL_LENGTH) || 'artifact',
    mediaType: clampText(input.mediaType, MAX_MEDIA_TYPE_LENGTH) || 'application/octet-stream',
    provenance: clampText(input.provenance, MAX_PROVENANCE_LENGTH) || 'unknown',
    createdAt: toIsoTimestamp(input.createdAtMs),
    previewable: input.previewable === true,
  };
}
