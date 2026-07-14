import { createHash, timingSafeEqual } from 'node:crypto';
import {
  SharedCompanionWorkspaceStore,
  type SharedWorkspaceActor,
  type SharedWorkspaceCogSecInput,
  type SharedWorkspaceProposalInput,
  type SharedWorkspaceReviewInput,
} from '../../../persistence/workspaces/shared-workspace-store.js';

export const SHARED_WORKSPACE_CREDENTIAL_HEADER = 'x-companion-shared-workspace-credential';
export const SHARED_WORKSPACE_PROPOSER_TOKEN_ENV = 'SHARED_WORKSPACE_PROPOSER_TOKEN';
export const SHARED_WORKSPACE_REVIEWER_TOKEN_ENV = 'SHARED_WORKSPACE_REVIEWER_TOKEN';
export const SHARED_WORKSPACE_COGSEC_TOKEN_ENV = 'SHARED_WORKSPACE_COGSEC_TOKEN';

export interface SharedWorkspaceCredentials {
  proposerToken: string;
  reviewerToken: string;
  cogSecToken: string;
}

type SharedWorkspacePrincipalRole = SharedWorkspaceActor['role'];

export class SharedWorkspaceAuthenticationError extends Error {}

function requireCredential(value: string | undefined, envName: string): string {
  const credential = value?.trim() ?? '';
  if (credential.length < 24) {
    throw new Error(`${envName} must be configured with at least 24 non-whitespace characters`);
  }
  return credential;
}

export function resolveSharedWorkspaceCredentials(env: NodeJS.ProcessEnv): SharedWorkspaceCredentials {
  return {
    proposerToken: requireCredential(env[SHARED_WORKSPACE_PROPOSER_TOKEN_ENV], SHARED_WORKSPACE_PROPOSER_TOKEN_ENV),
    reviewerToken: requireCredential(env[SHARED_WORKSPACE_REVIEWER_TOKEN_ENV], SHARED_WORKSPACE_REVIEWER_TOKEN_ENV),
    cogSecToken: requireCredential(env[SHARED_WORKSPACE_COGSEC_TOKEN_ENV], SHARED_WORKSPACE_COGSEC_TOKEN_ENV),
  };
}

function digestCredential(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function principalId(role: SharedWorkspacePrincipalRole): string {
  // Persist the authenticated role, not a reusable verifier for the bearer
  // credential. Credential digests remain process-local.
  return `shared-workspace:authenticated:${role}`;
}

export class AdminSharedWorkspaceService {
  private readonly store: SharedCompanionWorkspaceStore;
  private readonly credentialDigests: Record<SharedWorkspacePrincipalRole, Buffer>;

  constructor(sharedWorkspacePath: string, credentials: SharedWorkspaceCredentials) {
    this.store = new SharedCompanionWorkspaceStore(sharedWorkspacePath);
    this.credentialDigests = {
      proposer: digestCredential(requireCredential(credentials.proposerToken, SHARED_WORKSPACE_PROPOSER_TOKEN_ENV)),
      reviewer: digestCredential(requireCredential(credentials.reviewerToken, SHARED_WORKSPACE_REVIEWER_TOKEN_ENV)),
      cogsec: digestCredential(requireCredential(credentials.cogSecToken, SHARED_WORKSPACE_COGSEC_TOKEN_ENV)),
    };
    const distinct = new Set(Object.values(this.credentialDigests).map(digest => digest.toString('hex')));
    if (distinct.size !== 3) {
      throw new Error('Shared workspace proposer, reviewer, and CogSec credentials must be distinct');
    }
  }

  authenticate(credential: string | undefined, role: SharedWorkspacePrincipalRole): SharedWorkspaceActor {
    const provided = typeof credential === 'string' && credential.trim()
      ? digestCredential(credential.trim())
      : null;
    const expected = this.credentialDigests[role];
    if (!provided || !timingSafeEqual(provided, expected)) {
      throw new SharedWorkspaceAuthenticationError(
        `A valid distinct ${role} credential is required for this shared workspace action`,
      );
    }
    return { id: principalId(role), role };
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
    credential: string | undefined,
    input: Omit<SharedWorkspaceProposalInput, 'actor'>,
  ) {
    return this.store.propose({ ...input, actor: this.authenticate(credential, 'proposer') });
  }

  recordCogSecDecision(
    credential: string | undefined,
    input: Omit<SharedWorkspaceCogSecInput, 'reviewer'>,
  ) {
    return this.store.recordCogSecDecision({
      ...input,
      reviewer: this.authenticate(credential, 'cogsec'),
    });
  }

  review(
    credential: string | undefined,
    input: Omit<SharedWorkspaceReviewInput, 'reviewer'>,
  ) {
    return this.store.review({ ...input, reviewer: this.authenticate(credential, 'reviewer') });
  }
}
