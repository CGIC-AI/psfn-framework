// ── Companion-owned publication edit-loop tool (bible §10.10–10.11, jp36.7.3) ──
//
// The final leaf of the publication review lifecycle. This tool is the
// companion's own surface for the expressive-publication edit loop:
//
//   1. `submit`  — the companion authors an exact release candidate and proposes
//      it for Operator approval. The runtime derives ALL disclosure metadata
//      (effective sensitivity, provenance, subject contacts) from the live
//      per-turn disclosure lineage (bible §9.2); the model supplies ONLY the
//      content it authored (body + media refs) and its stated reason. Any
//      model-supplied sensitivity/provenance/audience/destination is rejected
//      fail-closed — that metadata is runtime authority, never self-asserted
//      (bible §6.2, adjudication S2.4).
//   2. `status`  — the companion reads the approval state of her publication
//      candidates. The Operator raises specific concerns about WHAT is shared in
//      conversation (never editing the prose); a denied candidate is the signal
//      to revise.
//   3. `revise`  — the companion edits herself and resubmits. A revision is a
//      BRAND-NEW `ShareCandidate` (fresh id, fresh content hash), never a
//      mutation of an approved capsule: approval binds to EXACT content, so the
//      edited content produces a fresh approval binding and any prior approval
//      is thereby invalidated for it (a prior capsule authorizes only its own
//      frozen content — the differing hash means it can never replay the edit).
//
// The tool NEVER mints, approves, or revokes capsules (operator authority via
// the approval queue), never supplies disclosure metadata, and never triggers
// the outward send (exact-replay authorization is the egress path's job). It
// fails closed when the custody service or the approval queue is unwired
// (single-companion / partial runtimes) and when no attestable disclosure
// lineage is available for the current context.

import { randomUUID } from 'node:crypto';
import { Type } from '@sinclair/typebox';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../../agent/tool-surface/descriptions.js';
import type { AgentToolResult, SubstrateAgentTool } from '../../../boundary/pi-agent/index.js';
import { textResult, textResultWithError } from '../../tools/results.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { isRecord } from '../../../shared/utils/types.js';
import {
  withCapabilityRequirement,
  type CapabilityRequirement,
} from '../../../system/capabilities/requirements.js';
import type {
  ApprovalQueuePort,
  ConfirmationQueueEntry,
  ConfirmationQueueHistoryEntry,
} from '../../../system/capabilities/approval-queue-port.js';
import { buildShareCandidate, type CapsuleExpiry } from './capsule.js';
import {
  SHARE_CAPSULE_APPROVAL_METHOD,
  type CapsuleCustodyService,
} from './capsule-custody.js';
import type { DisclosureLineage } from './contracts.js';

const PUBLICATION_ACTIONS = ['submit', 'revise', 'status'] as const;
type PublicationAction = (typeof PUBLICATION_ACTIONS)[number];

/**
 * Parameter names the model must NEVER supply on a publication candidate: they
 * are either runtime-authority disclosure metadata (bible §6.2) or server-minted
 * identity/authority fields. Reject them fail-closed rather than silently
 * ignoring them, so a model that tries to self-assert provenance gets a loud
 * error instead of a smuggled classification.
 */
const FORBIDDEN_METADATA_PARAMS = [
  'sensitivity',
  'effective_sensitivity',
  'effectiveSensitivity',
  'provenance',
  'provenance_refs',
  'provenanceRefs',
  'subject_contact_ids',
  'subjectContactIds',
  'subjects',
  'audience',
  'destination',
  'destinations',
  'proposed_destinations',
  'proposedDestinations',
  'content_hash',
  'contentHash',
  'capsule_id',
  'capsuleId',
  'candidate_id',
  'candidateId',
  'approve',
  'approval',
  'revoke',
] as const;

export interface PublicationToolDeps {
  /** Live custody handle; null in single-companion / unwired runtimes. */
  readonly getCustody: () => CapsuleCustodyService | null;
  /** Same approval queue the custody service enqueues onto; null when unwired. */
  readonly getApprovalQueue: () => ApprovalQueuePort | null;
  /** Live per-turn disclosure lineage (runtime authority for metadata). */
  readonly getDisclosureLineage: () => DisclosureLineage | undefined;
  /** Wall clock for candidate timestamps. Defaults to Date.now. */
  readonly now?: () => number;
  /** Candidate-id factory (server-side; never model supplied). */
  readonly candidateIdFactory?: () => string;
}

interface PublicationToolParams {
  action?: PublicationAction;
  body?: string;
  media_refs?: string[];
  reason?: string;
  revises_candidate_id?: string;
  max_use_count?: number;
}

interface CandidateStatusView {
  readonly candidateId: string;
  readonly contentHash: string;
  readonly approvalEntryId: string;
  readonly effectiveSensitivity: unknown;
  readonly status: 'pending_approval' | ConfirmationQueueHistoryEntry['status'];
  readonly requestedAt?: number;
  readonly resolvedAt?: number;
}

function normalizeAction(params: PublicationToolParams): PublicationAction {
  const raw = params.action;
  if (raw === undefined) return 'status';
  if (!PUBLICATION_ACTIONS.includes(raw)) {
    throw new Error(`action must be one of: ${PUBLICATION_ACTIONS.join(', ')}`);
  }
  return raw;
}

function rejectForbiddenMetadata(rawParams: unknown): void {
  if (!isRecord(rawParams)) return;
  for (const key of FORBIDDEN_METADATA_PARAMS) {
    if (rawParams[key] !== undefined) {
      throw new Error(
        `${key} is runtime-derived disclosure metadata (or server-minted) and must not be supplied by the model; `
          + 'the publication tool derives sensitivity, provenance, subject contacts, destination, and identity from runtime authority only',
      );
    }
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value;
}

function normalizeMediaRefs(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('media_refs must be an array of strings');
  const refs: string[] = [];
  for (const ref of value) {
    if (typeof ref !== 'string' || ref.trim().length === 0) {
      throw new Error('media_refs entries must be non-empty strings');
    }
    refs.push(ref.trim());
  }
  return refs;
}

function resolveExpiry(value: unknown): CapsuleExpiry {
  // The companion may propose a bounded use budget (part of her intent, not
  // disclosure metadata). Default to a single exact-replay use — an expressive
  // publication is a one-shot release. The operator sees and approves the bound.
  if (value === undefined) return { maxUseCount: 1 };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error('max_use_count must be a positive integer');
  }
  return { maxUseCount: value };
}

/**
 * Runtime-authority guard: derive the disclosure lineage the candidate binds to,
 * failing closed when it is absent, empty, or carries an unclassified source.
 * A publication whose provenance the runtime cannot attest must never be
 * proposed — the human review depends on the runtime presenting real provenance
 * (bible §9.5).
 */
function requireAttestableLineage(deps: PublicationToolDeps): DisclosureLineage {
  const lineage = deps.getDisclosureLineage();
  if (!lineage || lineage.sourceCount === 0) {
    throw new Error(
      'no attestable disclosure lineage for the current context; a publication candidate requires an active '
        + 'generation context whose provenance the runtime can present for human review (fail closed, bible §9.5)',
    );
  }
  if (lineage.hasUnclassifiedSource) {
    throw new Error(
      'the current context includes an unclassified or untrusted-derived source; its provenance cannot be '
        + 'attested for publication review (fail closed, bible §9.5)',
    );
  }
  return lineage;
}

function requireCustody(deps: PublicationToolDeps): CapsuleCustodyService {
  const custody = deps.getCustody();
  if (!custody) {
    throw new Error(
      'publication custody is unavailable in this runtime; the companion-owned publication edit loop is '
        + 'fail-closed here (no share-capsule custody service is wired)',
    );
  }
  return custody;
}

function requireApprovalQueue(deps: PublicationToolDeps): ApprovalQueuePort {
  const queue = deps.getApprovalQueue();
  if (!queue) {
    throw new Error(
      'publication approval queue is unavailable in this runtime; candidate status cannot be read (fail closed)',
    );
  }
  return queue;
}

function isShareCapsuleEntry(entry: { method?: string }): boolean {
  return entry.method === SHARE_CAPSULE_APPROVAL_METHOD;
}

function candidateIdOf(entry: { params?: Record<string, unknown> }): string | undefined {
  const value = entry.params?.candidateId;
  return typeof value === 'string' ? value : undefined;
}

function collectCandidateStatus(queue: ApprovalQueuePort): CandidateStatusView[] {
  const views: CandidateStatusView[] = [];
  for (const entry of queue.listPending()) {
    if (!isShareCapsuleEntry(entry)) continue;
    views.push({
      candidateId: candidateIdOf(entry) ?? '(unknown)',
      contentHash: typeof entry.params.contentHash === 'string' ? entry.params.contentHash : '(unknown)',
      approvalEntryId: entry.id,
      effectiveSensitivity: entry.params.effectiveSensitivity,
      status: 'pending_approval',
      requestedAt: entry.requestedAt,
    });
  }
  for (const entry of queue.listHistory()) {
    if (!isShareCapsuleEntry(entry)) continue;
    views.push({
      candidateId: candidateIdOf(entry) ?? '(unknown)',
      contentHash: typeof entry.params?.contentHash === 'string' ? entry.params.contentHash : '(unknown)',
      approvalEntryId: entry.id,
      effectiveSensitivity: entry.params?.effectiveSensitivity,
      status: entry.status,
      resolvedAt: entry.resolvedAt,
    });
  }
  return views;
}

/**
 * Build and enqueue a fresh share candidate. Shared by `submit` and `revise` —
 * a revision is structurally identical to a first submission (a brand-new
 * candidate), differing only in the operator-facing reason/scope context.
 */
function proposeCandidate(
  custody: CapsuleCustodyService,
  lineage: DisclosureLineage,
  input: {
    readonly body: string;
    readonly mediaRefs: readonly string[];
    readonly reason: string;
    readonly expiry: CapsuleExpiry;
    readonly candidateId: string;
    readonly createdAt: string;
    readonly supersedes?: string;
  },
): ConfirmationQueueEntry {
  const candidate = buildShareCandidate({
    candidateId: input.candidateId,
    content: { body: input.body, mediaRefs: input.mediaRefs },
    // Expressive private publication (bible §10.10): the destination is the
    // autonomous publication surface, which is id-free — the companion supplies
    // no audience scoping. Operator approval is how strict auto-share filtering is
    // legitimately bypassed with provenance in view.
    proposedDestinations: [{ kind: 'publication' }],
    // Runtime authority — derived from the folded lineage, never model-asserted.
    effectiveSensitivity: lineage.effectiveSensitivity,
    provenanceRefs: lineage.provenanceRefs,
    subjectContactIds: lineage.subjectContactIds,
    createdAt: input.createdAt,
  });
  const companionReason = input.supersedes
    ? `[revision superseding candidate ${input.supersedes}] ${input.reason}`
    : input.reason;
  return custody.proposeShareCandidate({
    candidate,
    proposedExpiry: input.expiry,
    companionReason,
    approvalScope: `Autonomous expressive publication (exact-replay; provenance ${lineage.effectiveSensitivity})`,
  });
}

export function createPublicationTool(deps: PublicationToolDeps): SubstrateAgentTool {
  const now = deps.now ?? Date.now;
  const candidateIdFactory = deps.candidateIdFactory ?? (() => `candidate-${randomUUID()}`);

  const tool: SubstrateAgentTool = {
    name: 'publication',
    label: 'publication',
    description: CANONICAL_TOOL_SURFACE_DESCRIPTIONS.publication,
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union(
          PUBLICATION_ACTIONS.map((a) => Type.Literal(a)),
          { description: 'submit a new publication candidate, revise (resubmit an edited candidate), or read status. Defaults to status.' },
        ),
      ),
      body: Type.Optional(
        Type.String({ description: 'The exact prose you authored for this publication. Verbatim; this exact content is what an approval binds to.' }),
      ),
      media_refs: Type.Optional(
        Type.Array(Type.String(), { description: 'Ordered references to already-existing media artifacts embedded in the publication. Reordering is an edit.' }),
      ),
      reason: Type.Optional(
        Type.String({ description: 'Why you want to propose sharing this (for the human reviewer). Never carries disclosure metadata.' }),
      ),
      revises_candidate_id: Type.Optional(
        Type.String({ description: 'For action=revise: the id of the prior candidate this edited version supersedes.' }),
      ),
      max_use_count: Type.Optional(
        Type.Integer({ minimum: 1, description: 'Optional proposed exact-replay use budget for the approval. Defaults to 1.' }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: PublicationToolParams = {},
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      let action: PublicationAction = 'status';
      try {
        action = normalizeAction(params);
        switch (action) {
          case 'submit': {
            rejectForbiddenMetadata(params);
            const custody = requireCustody(deps);
            const lineage = requireAttestableLineage(deps);
            const body = requireString(params.body, 'body');
            const reason = requireString(params.reason, 'reason');
            const mediaRefs = normalizeMediaRefs(params.media_refs);
            const expiry = resolveExpiry(params.max_use_count);
            const entry = proposeCandidate(custody, lineage, {
              body,
              mediaRefs,
              reason,
              expiry,
              candidateId: candidateIdFactory(),
              createdAt: new Date(now()).toISOString(),
            });
            return textResult(JSON.stringify({
              action,
              candidateId: candidateIdOf(entry),
              contentHash: entry.params.contentHash,
              approvalEntryId: entry.id,
              effectiveSensitivity: lineage.effectiveSensitivity,
              provenanceRefCount: lineage.provenanceRefs.length,
              status: 'pending_approval',
              boundary: 'A human reviews this exact content with its provenance and may raise concerns about what is shared. '
                + 'The human never edits your prose. If concerns are raised, edit and resubmit with action=revise. '
                + 'This tool does not send the publication; exact-replay egress is a separate, approval-gated path.',
            }, null, 2));
          }
          case 'revise': {
            rejectForbiddenMetadata(params);
            const custody = requireCustody(deps);
            const queue = requireApprovalQueue(deps);
            const supersedes = requireString(params.revises_candidate_id, 'revises_candidate_id');
            const known = collectCandidateStatus(queue).some((view) => view.candidateId === supersedes);
            if (!known) {
              throw new Error(
                `no prior publication candidate '${supersedes}' is known to the approval queue; revise must reference an existing candidate`,
              );
            }
            const lineage = requireAttestableLineage(deps);
            const body = requireString(params.body, 'body');
            const reason = requireString(params.reason, 'reason');
            const mediaRefs = normalizeMediaRefs(params.media_refs);
            const expiry = resolveExpiry(params.max_use_count);
            const entry = proposeCandidate(custody, lineage, {
              body,
              mediaRefs,
              reason,
              expiry,
              candidateId: candidateIdFactory(),
              createdAt: new Date(now()).toISOString(),
              supersedes,
            });
            return textResult(JSON.stringify({
              action,
              candidateId: candidateIdOf(entry),
              contentHash: entry.params.contentHash,
              approvalEntryId: entry.id,
              supersedes,
              effectiveSensitivity: lineage.effectiveSensitivity,
              status: 'pending_approval',
              boundary: 'This is a fresh approval binding for the edited content. Because approval binds to the exact content hash, '
                + 'any prior approval is invalidated for this edit — a prior capsule authorizes only its own superseded content and can never replay this revision.',
            }, null, 2));
          }
          case 'status': {
            const queue = requireApprovalQueue(deps);
            const candidates = collectCandidateStatus(queue);
            return textResult(JSON.stringify({
              action,
              candidates,
              note: 'Concerns about what is shared are raised in conversation, not as queue text. A denied candidate is the signal to edit and resubmit (action=revise).',
            }, null, 2));
          }
          default: {
            // Exhaustiveness guard: PublicationAction is a closed union.
            throw new Error(`unsupported publication action: ${String(action)}`);
          }
        }
      } catch (error) {
        return textResultWithError(
          `publication failed for action=${action}: ${toErrorMessage(error)}`,
          true,
        );
      }
    },
  };

  return withCapabilityRequirement(tool, resolvePublicationCapabilityRequirement);
}

export function resolvePublicationCapabilityRequirement(
  params: Record<string, unknown>,
): CapabilityRequirement {
  const action = typeof params.action === 'string' ? params.action.trim() : '';
  switch (action) {
    case '':
    case 'status':
      return 'identity.read';
    case 'submit':
    case 'revise':
      return 'identity.write.runtime';
    default:
      return ['identity.read', 'identity.write.runtime'];
  }
}
