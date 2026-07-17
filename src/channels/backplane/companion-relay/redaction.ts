import type {
  ConfirmationQueueEntry,
  ConfirmationResolutionStatus,
} from '../../../system/capabilities/confirmation-queue.js';
import type {
  CompanionApprovalRequestedPayload,
  CompanionApprovalRequestedV2Payload,
  CompanionApprovalResolvedPayload,
  CompanionApprovalResolutionStatus,
  CompanionArtifactCreatedPayload,
  CompanionToolActivityPayload,
  CompanionToolActivityPhase,
} from '../../../shared/contracts/companion-relay.js';
import type {
  ApprovalAttribution,
  ApprovalGrantMode,
  ApprovalSourceSystem,
} from '../../../shared/contracts/approval-envelope.js';

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
// v2 approval-envelope field caps (bead psfn-framework-13sk).
const MAX_ACTION_LENGTH = 120;
const MAX_SCOPE_LENGTH = 200;
const MAX_ATTR_LABEL_LENGTH = 120;
const MAX_SOURCE_SYSTEM_LENGTH = 64;

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
 * Server-resolved v2 context for an approval request (bead psfn-framework-13sk).
 * Everything here is resolved from authenticated lineage at enqueue; NONE of it
 * is client-supplied. Passing it in adds the additive v2 fields to the payload.
 */
export interface ApprovalRequestedV2Context {
  sourceSystem: ApprovalSourceSystem;
  attribution: ApprovalAttribution;
  grantMode: ApprovalGrantMode;
}

/**
 * Build the redacted, server-resolved attribution. Identifiers are opaque and
 * clamped; labels are presentation only. `parentId`/`parentLabel` are required
 * (fail closed on a missing parent — an ownerless request must never emit).
 */
function redactAttribution(attribution: ApprovalAttribution): ApprovalAttribution {
  const parentLabel = clampText(attribution.parentLabel, MAX_ATTR_LABEL_LENGTH);
  if (!parentLabel) {
    throw new Error('Cannot redact event: missing attribution parentLabel');
  }
  return {
    parentLabel,
    parentId: requireId(attribution.parentId, 'attribution parentId'),
    ...(attribution.shardId !== undefined
      ? { shardId: requireId(attribution.shardId, 'attribution shardId') }
      : {}),
    ...(attribution.shardLabel !== undefined
      ? { shardLabel: clampText(attribution.shardLabel, MAX_ATTR_LABEL_LENGTH) || 'shard' }
      : {}),
  };
}

/**
 * Approval request → redacted payload. Only the action verb, scope, and the
 * companion-authored reason survive; `entry.params` (raw tool params) and
 * `entry.method` internals never do.
 *
 * When `v2` is supplied, the additive unified-envelope fields (sourceSystem,
 * attribution, action, scope, reason, grantMode) are CONSTRUCTED here from the
 * whitelist — never spread. Without `v2`, the exact v1 payload is returned.
 * TTL grant modes are rejected: the server must never offer TTL until the
 * JSON-owned policy exists (see approval-envelope.ts / SHARD_APPROVALS.md).
 */
export function redactApprovalRequested(
  entry: Pick<ConfirmationQueueEntry, 'id' | 'action' | 'scope' | 'companionReason' | 'requestedAt' | 'expiresAt'>,
  v2: ApprovalRequestedV2Context,
): CompanionApprovalRequestedV2Payload;
export function redactApprovalRequested(
  entry: Pick<ConfirmationQueueEntry, 'id' | 'action' | 'scope' | 'companionReason' | 'requestedAt' | 'expiresAt'>,
): CompanionApprovalRequestedPayload;
export function redactApprovalRequested(
  entry: Pick<ConfirmationQueueEntry, 'id' | 'action' | 'scope' | 'companionReason' | 'requestedAt' | 'expiresAt'>,
  v2?: ApprovalRequestedV2Context,
): CompanionApprovalRequestedPayload {
  const base: CompanionApprovalRequestedPayload = {
    id: requireId(entry.id, 'approval id'),
    title: clampText(`${entry.action}: ${entry.scope}`, MAX_TITLE_LENGTH),
    requestedAt: toIsoTimestamp(entry.requestedAt),
    ...(Number.isFinite(entry.expiresAt) && entry.expiresAt > 0
      ? { expiresAt: toIsoTimestamp(entry.expiresAt) }
      : {}),
    redactedContext: clampText(entry.companionReason, MAX_CONTEXT_LENGTH),
    status: 'pending',
  };
  if (!v2) return base;

  if (v2.grantMode.kind !== 'once') {
    throw new Error(
      'Cannot redact approval request: TTL grant mode is not permitted until the JSON-owned TTL policy exists',
    );
  }
  return {
    ...base,
    sourceSystem: clampText(v2.sourceSystem, MAX_SOURCE_SYSTEM_LENGTH) || 'tool-access',
    attribution: redactAttribution(v2.attribution),
    action: clampText(entry.action, MAX_ACTION_LENGTH),
    scope: clampText(entry.scope, MAX_SCOPE_LENGTH),
    reason: clampText(entry.companionReason, MAX_CONTEXT_LENGTH),
    grantMode: { kind: 'once' },
  };
}

/**
 * Capability-gated down-projection at the emission boundary. A client that has
 * NOT advertised `approvals.v2` must receive the exact v1 payload; the v2 fields
 * are reconstructed OUT explicitly (never `delete`-d) so nothing can leak.
 */
export function projectApprovalRequestedPayload(
  payload: CompanionApprovalRequestedPayload,
  options: { includeV2: boolean },
): CompanionApprovalRequestedPayload {
  if (options.includeV2) return payload;
  return {
    id: payload.id,
    title: payload.title,
    requestedAt: payload.requestedAt,
    ...(payload.expiresAt !== undefined ? { expiresAt: payload.expiresAt } : {}),
    redactedContext: payload.redactedContext,
    status: payload.status,
  };
}

/**
 * Maps internal confirmation-queue resolution statuses onto the hub protocol
 * statuses. `modified` executed with operator-adjusted params, so it reads as
 * approved. A `failed` action is blocked only when it did not execute. If a
 * post-execution durability step failed, the companion must see `approved`
 * so it cannot infer that retrying the already-committed effect is safe.
 * `not_found` never resolves a real entry and must not be emitted.
 */
export function toCompanionApprovalStatus(
  status: ConfirmationResolutionStatus,
  executed = false,
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
      return executed ? 'approved' : 'blocked';
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
  executed: boolean;
}): CompanionApprovalResolvedPayload {
  return {
    id: requireId(input.id, 'approval id'),
    status: toCompanionApprovalStatus(input.status, input.executed),
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
