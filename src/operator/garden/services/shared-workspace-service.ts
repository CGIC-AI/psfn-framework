import {
  SharedCompanionWorkspaceStore,
  type SharedWorkspaceActor,
  type SharedWorkspaceCogSecInput,
  type SharedWorkspaceProposalInput,
  type SharedWorkspaceReviewInput,
} from '../../../persistence/workspaces/shared-workspace-store.js';
import {
  assertSharedWorkspaceListingCursor,
  type SharedWorkspaceListBounds,
} from '../../../persistence/workspaces/shared-workspace-bounds.js';
import type { GardenRequestContext } from '../garden-request-context.js';

type SharedWorkspacePrincipalRole = SharedWorkspaceActor['role'];

export class SharedWorkspaceAuthenticationError extends Error {}

function authenticateRequest(
  context: GardenRequestContext | undefined,
  role: SharedWorkspacePrincipalRole,
): SharedWorkspaceActor {
  const expectedRouteId: Record<SharedWorkspacePrincipalRole, string> = {
    proposer: 'POST /api/admin/shared-workspace/proposals',
    cogsec: 'POST /api/admin/shared-workspace/reviews/:reviewId/cogsec',
    reviewer: 'POST /api/admin/shared-workspace/reviews/:reviewId/decision',
  };
  if (!context || context.kind !== 'fleet_principal'
    || context.resource.scope !== 'governed_shared_workspace'
    || context.action !== 'shared_workspace.manage'
    || context.resource.routeId !== expectedRouteId[role]) {
    throw new SharedWorkspaceAuthenticationError(
      'A trusted Fleet shared-workspace authorization is required',
    );
  }
  const requirements = context.authorization.requirements;
  if (role === 'cogsec'
    && (!requirements.approvals.includes('cogsec')
      || requirements.assurance !== 'escalated'
      || requirements.confirmation !== 'explicit')) {
    throw new SharedWorkspaceAuthenticationError('CogSec workflow authorization is incomplete');
  }
  if (role === 'reviewer'
    && (!requirements.approvals.includes('cogsec')
      || !requirements.approvals.includes('independent_reviewer')
      || requirements.assurance !== 'escalated'
      || requirements.confirmation !== 'explicit')) {
    throw new SharedWorkspaceAuthenticationError('Independent review authorization is incomplete');
  }
  return Object.freeze({
    id: `shared-workspace:fleet:${context.actor.principalId}`,
    role,
  });
}

export class AdminSharedWorkspaceService {
  private readonly store: SharedCompanionWorkspaceStore;

  constructor(
    sharedWorkspacePath: string,
    private readonly listBounds: SharedWorkspaceListBounds,
  ) {
    this.store = new SharedCompanionWorkspaceStore(sharedWorkspacePath);
  }

  /**
   * Governed workspace snapshot. Artifacts are served one operator-bounded page
   * at a time and carry `nextArtifactCursor` when more remain, so a large
   * reviewed corpus can no longer hold the Garden request loop while every
   * artifact is re-hashed (psfn-framework-9jld5).
   *
   * The REVIEW list rides the first page only (psfn-framework-2xt9c). It is a
   * full read of every review record, and repeating it on every artifact page
   * meant paging multiplied the one unbounded cost in this response instead of
   * dividing it: an operator walking ten pages paid for the whole review corpus
   * ten times over for a list that had not changed.
   *
   * A resumed page therefore carries `reviews: null` — an explicit absence, not
   * an empty list that reads like "no reviews" — beside the
   * `reviewsIncluded` flag. The key is always present, so a caller reads one
   * shape rather than narrowing a union.
   */
  getSnapshot(request: { artifactCursor?: string } = {}) {
    // Shape-checked before it reaches the corpus, so a cursor nobody could have
    // been handed is refused as malformed rather than resolved and reported as
    // stale — the two answers mean different things to a caller.
    const cursor = request.artifactCursor === undefined
      ? undefined
      : assertSharedWorkspaceListingCursor(request.artifactCursor);
    const artifacts = this.store.listArtifacts({
      bounds: this.listBounds,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    return {
      policy: this.store.getPolicy(),
      artifacts: artifacts.artifacts,
      nextArtifactCursor: artifacts.nextCursor,
      reviews: cursor === undefined ? this.store.listReviews() : null,
      reviewsIncluded: cursor === undefined,
    };
  }

  readArtifact(artifactPath: string) {
    return this.store.readArtifact(artifactPath);
  }

  propose(
    context: GardenRequestContext | undefined,
    input: Omit<SharedWorkspaceProposalInput, 'actor'>,
  ) {
    return this.store.propose({ ...input, actor: authenticateRequest(context, 'proposer') });
  }

  recordCogSecDecision(
    context: GardenRequestContext | undefined,
    input: Omit<SharedWorkspaceCogSecInput, 'reviewer'>,
  ) {
    return this.store.recordCogSecDecision({
      ...input,
      reviewer: authenticateRequest(context, 'cogsec'),
    });
  }

  review(
    context: GardenRequestContext | undefined,
    input: Omit<SharedWorkspaceReviewInput, 'reviewer'>,
  ) {
    return this.store.review({ ...input, reviewer: authenticateRequest(context, 'reviewer') });
  }
}
