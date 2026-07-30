import {
  SharedCompanionWorkspaceStore,
  type SharedWorkspaceActor,
  type SharedWorkspaceCogSecInput,
  type SharedWorkspaceProposalInput,
  type SharedWorkspaceReviewInput,
} from '../../../persistence/workspaces/shared-workspace-store.js';
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

  constructor(sharedWorkspacePath: string) {
    this.store = new SharedCompanionWorkspaceStore(sharedWorkspacePath);
  }

  getSnapshot() {
    return {
      policy: this.store.getPolicy(),
      artifacts: this.store.listArtifacts(),
      reviews: this.store.listReviews(),
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
