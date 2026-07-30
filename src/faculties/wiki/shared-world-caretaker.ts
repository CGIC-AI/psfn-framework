import { createComponentLogger } from '../../shared/logger.js';
import { sanitizeDiagnosticText } from '../../shared/diagnostics/redaction.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import type { WikiProjectionSyncOutcome } from './pgvector-projection.js';
import type { WikiDocument, WikiDocumentUpsertInput } from './types.js';
import type { SharedWorldWikiProposalStorePort } from './shared-world-caretaker-store.js';
import {
  guardSharedWorldWikiProposal,
  type SharedWorldWikiCleanupResult,
  type SharedWorldWikiProposal,
  type SharedWorldWikiProposalApplyResult,
  type SharedWorldWikiProposalInput,
  type SharedWorldWikiProposalListQuery,
  type SharedWorldWikiProposalSubmissionResult,
} from './shared-world-caretaker-types.js';

const log = createComponentLogger('SharedWorldWikiCaretaker');
const REDACTED_PROPOSAL_CONTENT = '[REDACTED_PROPOSAL_CONTENT]';

type SharedWorldWikiApplyFailurePhase =
  | 'deterministic_guard'
  | 'canonical_write'
  | 'projection'
  | 'mark_applied';

function sanitizeCaretakerApplyError(
  error: unknown,
  proposal: Pick<SharedWorldWikiProposal, 'title' | 'body'>,
): string {
  let message = toErrorMessage(error);
  const contentFragments = [proposal.body, proposal.title]
    .map(fragment => fragment.trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const fragment of contentFragments) {
    message = message.replaceAll(fragment, REDACTED_PROPOSAL_CONTENT);
  }
  return sanitizeDiagnosticText(message) || 'unknown caretaker apply failure';
}

function resolveCaretakerErrorCode(error: unknown): string {
  if (error instanceof Error && error.name.trim()) {
    return sanitizeDiagnosticText(error.name);
  }
  return typeof error;
}

export interface SharedWorldWikiProposalSubmissionPort {
  submit(input: SharedWorldWikiProposalInput): Promise<SharedWorldWikiProposalSubmissionResult>;
}

export interface SharedWorldWikiProjectionPort {
  syncDocument(siteId: string, document: WikiDocument): Promise<WikiProjectionSyncOutcome>;
}

export interface SharedWorldWikiWriteStorePort {
  get(documentId: string): WikiDocument | null;
  upsert(input: WikiDocumentUpsertInput): WikiDocument;
}

export interface SharedWorldWikiProposalServiceOptions {
  proposalStore: SharedWorldWikiProposalStorePort;
  isKnownSite: (siteId: string) => boolean;
  now?: () => number;
}

/** Companion-facing surface: it can enqueue only; it has no shared wiki store. */
export class SharedWorldWikiProposalService implements SharedWorldWikiProposalSubmissionPort {
  private readonly proposalStore: SharedWorldWikiProposalStorePort;
  private readonly isKnownSite: (siteId: string) => boolean;
  private readonly now: () => number;

  constructor(options: SharedWorldWikiProposalServiceOptions) {
    this.proposalStore = options.proposalStore;
    this.isKnownSite = options.isKnownSite;
    this.now = options.now ?? Date.now;
  }

  async submit(input: SharedWorldWikiProposalInput): Promise<SharedWorldWikiProposalSubmissionResult> {
    const guarded = guardSharedWorldWikiProposal(input, this.isKnownSite);
    if (!guarded.accepted) {
      throw new Error(`shared world wiki proposal rejected: ${guarded.rejectionCode}`);
    }
    const result = await this.proposalStore.submit(guarded.proposal, this.now());
    log.info('Shared-world wiki proposal queued', {
      proposalId: result.proposal.proposalId,
      state: result.proposal.reviewState,
      siteId: result.proposal.siteId,
      digest: result.proposal.contentDigest,
      revision: result.proposal.revision,
    });
    return result;
  }
}

export interface SharedWorldWikiCaretakerOptions extends SharedWorldWikiProposalServiceOptions {
  openSharedStore: (siteId: string) => SharedWorldWikiWriteStorePort;
  /**
   * Optional remote canonical writer. Agent runtimes supply the gateway-backed
   * implementation; host-side maintenance and focused store tests may omit it.
   */
  writeSharedDocument?: (
    siteId: string,
    input: WikiDocumentUpsertInput,
  ) => Promise<WikiDocument>;
  projection: SharedWorldWikiProjectionPort;
}

export class SharedWorldWikiCaretakerService {
  private readonly proposalStore: SharedWorldWikiProposalStorePort;
  private readonly isKnownSite: (siteId: string) => boolean;
  private readonly openSharedStore: (siteId: string) => SharedWorldWikiWriteStorePort;
  private readonly writeSharedDocument?: SharedWorldWikiCaretakerOptions['writeSharedDocument'];
  private readonly projection: SharedWorldWikiProjectionPort;
  private readonly now: () => number;

  constructor(options: SharedWorldWikiCaretakerOptions) {
    this.proposalStore = options.proposalStore;
    this.isKnownSite = options.isKnownSite;
    this.openSharedStore = options.openSharedStore;
    this.writeSharedDocument = options.writeSharedDocument;
    this.projection = options.projection;
    this.now = options.now ?? Date.now;
  }

  list(query: SharedWorldWikiProposalListQuery = {}): Promise<SharedWorldWikiProposal[]> {
    return this.proposalStore.list(query);
  }

  get(proposalId: string): Promise<SharedWorldWikiProposal | null> {
    return this.proposalStore.get(proposalId);
  }

  async reject(proposalId: string, operatorActorId: string): Promise<SharedWorldWikiProposal> {
    const proposal = await this.proposalStore.review({
      proposalId,
      decision: 'reject',
      operatorActorId,
      rejectionCode: 'operator_rejected',
      nowMs: this.now(),
    });
    log.info('Shared-world wiki proposal reviewed', {
      proposalId: proposal.proposalId,
      state: proposal.reviewState,
      siteId: proposal.siteId,
      digest: proposal.contentDigest,
      revision: proposal.revision,
      rejectionCode: proposal.rejectionCode,
    });
    return proposal;
  }

  async approve(proposalId: string, operatorActorId: string): Promise<SharedWorldWikiProposalApplyResult> {
    const reviewed = await this.proposalStore.review({
      proposalId,
      decision: 'approve',
      operatorActorId,
      nowMs: this.now(),
    });
    log.info('Shared-world wiki proposal reviewed', {
      proposalId: reviewed.proposalId,
      state: reviewed.reviewState,
      siteId: reviewed.siteId,
      digest: reviewed.contentDigest,
      revision: reviewed.revision,
    });
    return this.applyApproved(proposalId);
  }

  async applyApproved(proposalId: string): Promise<SharedWorldWikiProposalApplyResult> {
    const claim = await this.proposalStore.claimApproved(proposalId, this.now());
    if (!claim) {
      const current = await this.proposalStore.get(proposalId);
      if (!current) throw new Error('shared wiki proposal not found');
      if (current.reviewState !== 'approved') {
        throw new Error(`shared wiki proposal is ${current.reviewState}, not approved`);
      }
      if (current.applyState === 'applied') {
        return {
          proposal: current,
          status: 'already_applied',
          documentVersion: current.appliedDocumentVersion,
          bodySha256: current.appliedBodySha256,
        };
      }
      throw new Error('shared wiki proposal application is already leased');
    }
    const leaseToken = claim.applyLeaseToken;
    if (!leaseToken) throw new Error('shared wiki proposal apply claim has no lease token');

    let failurePhase: SharedWorldWikiApplyFailurePhase = 'deterministic_guard';
    try {
      // Mandatory second guard: approval cannot turn a stale/now-private input
      // into a write, and a site removed after queueing fails closed here.
      const guarded = guardSharedWorldWikiProposal({
        siteId: claim.siteId,
        documentId: claim.documentId,
        actorId: claim.actorId,
        sourceRef: claim.sourceRef,
        title: claim.title,
        body: claim.body,
        tags: claim.tags,
        provenanceRefs: claim.provenanceRefs,
        sensitivity: claim.sensitivity,
      }, this.isKnownSite);
      if (!guarded.accepted || guarded.proposal.contentDigest !== claim.contentDigest) {
        throw new Error('shared wiki proposal failed deterministic apply guard');
      }

      failurePhase = 'canonical_write';
      const store = this.openSharedStore(claim.siteId);
      const proposalMarker = `caretaker-proposal:${claim.proposalId}`;
      const digestMarker = `caretaker-digest:${claim.contentDigest}`;
      const existing = store.get(claim.documentId);
      let document: WikiDocument;
      if (existing?.provenanceRefs.includes(proposalMarker)
        && existing.provenanceRefs.includes(digestMarker)) {
        // Resume after canonical write / before projection or marker commit.
        // The proposal markers prove this exact immutable input wrote the file,
        // so retrying must not increment the document version.
        document = existing;
      } else {
        const input: WikiDocumentUpsertInput = {
          id: guarded.proposal.documentId,
          title: guarded.proposal.title,
          body: guarded.proposal.body,
          tags: guarded.proposal.tags,
          sourceClass: 'companion_authored_note',
          provenanceRefs: [
            ...guarded.proposal.provenanceRefs,
            guarded.proposal.sourceRef,
            `actor-companion:${guarded.proposal.actorId}`,
            proposalMarker,
            digestMarker,
          ],
          sensitivity: 'public',
          summary: undefined,
          updatedBy: `wiki-caretaker:${claim.reviewedBy ?? 'operator'}`,
        };
        document = this.writeSharedDocument
          ? await this.writeSharedDocument(claim.siteId, input)
          : store.upsert(input);
      }

      failurePhase = 'projection';
      const projection = await this.projection.syncDocument(claim.siteId, document);
      if (projection.status !== 'ran') {
        throw new Error('shared wiki proposal projection failed');
      }
      failurePhase = 'mark_applied';
      const applied = await this.proposalStore.markApplied({
        proposalId: claim.proposalId,
        leaseToken,
        documentVersion: document.version,
        bodySha256: document.bodySha256,
        nowMs: this.now(),
      });
      log.info('Shared-world wiki proposal applied', {
        proposalId: applied.proposalId,
        state: applied.applyState,
        siteId: applied.siteId,
        digest: applied.contentDigest,
        revision: applied.revision,
      });
      return {
        proposal: applied,
        status: 'applied',
        documentVersion: document.version,
        bodySha256: document.bodySha256,
      };
    } catch (error) {
      const applyError = sanitizeCaretakerApplyError(error, claim);
      const applyErrorCode = resolveCaretakerErrorCode(error);
      try {
        await this.proposalStore.markRetryable(claim.proposalId, leaseToken, this.now());
      } catch (retryStateError) {
        const retryError = sanitizeCaretakerApplyError(retryStateError, claim);
        log.error('Shared-world wiki proposal apply failed and retry state could not be persisted', {
          proposalId: claim.proposalId,
          state: claim.applyState,
          siteId: claim.siteId,
          digest: claim.contentDigest,
          revision: claim.revision,
          phase: 'retry_state_persistence',
          code: `${applyErrorCode}:${resolveCaretakerErrorCode(retryStateError)}`,
          error: `apply[${failurePhase}]: ${applyError}; retry_state: ${retryError}`,
        });
        throw new AggregateError(
          [error, retryStateError],
          `Shared-world wiki proposal apply failed during ${failurePhase} and retry state persistence also failed`,
        );
      }
      log.warn('Shared-world wiki proposal apply is retryable', {
        proposalId: claim.proposalId,
        state: 'retryable',
        siteId: claim.siteId,
        digest: claim.contentDigest,
        revision: claim.revision,
        phase: failurePhase,
        code: applyErrorCode,
        error: applyError,
      });
      const proposal = await this.proposalStore.get(claim.proposalId);
      if (!proposal) throw new Error('shared wiki proposal disappeared after apply failure');
      return { proposal, status: 'retryable_failure' };
    }
  }

  /**
   * Bounded, independent drift repair. Only approved+applied proposals are
   * scanned, and only a changed/missing projection invokes the embedder.
   */
  async cleanupChangedContent(limit: number): Promise<SharedWorldWikiCleanupResult> {
    const candidates = await this.proposalStore.listCleanupCandidates(limit);
    let reprojected = 0;
    let failed = 0;
    for (const proposal of candidates) {
      const nowMs = this.now();
      const document = this.openSharedStore(proposal.siteId).get(proposal.documentId);
      if (!document || document.bodySha256 === proposal.projectionBodySha256) {
        await this.proposalStore.markCleanupChecked({ proposalId: proposal.proposalId, nowMs });
        continue;
      }
      const outcome = await this.projection.syncDocument(proposal.siteId, document);
      if (outcome.status === 'ran') {
        reprojected += 1;
        await this.proposalStore.markCleanupChecked({
          proposalId: proposal.proposalId,
          projectionBodySha256: document.bodySha256,
          nowMs,
        });
      } else {
        failed += 1;
        await this.proposalStore.markCleanupChecked({ proposalId: proposal.proposalId, nowMs });
      }
    }
    log.info('Shared-world wiki cleanup batch completed', {
      count: candidates.length,
    });
    return { checked: candidates.length, reprojected, failed };
  }
}
