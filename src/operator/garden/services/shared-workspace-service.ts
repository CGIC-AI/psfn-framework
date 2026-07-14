import {
  SharedCompanionWorkspaceStore,
  type SharedWorkspaceProposalInput,
  type SharedWorkspaceReviewInput,
} from '../../../persistence/workspaces/shared-workspace-store.js';

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

  propose(input: SharedWorkspaceProposalInput) {
    return this.store.propose(input);
  }

  review(input: SharedWorkspaceReviewInput) {
    return this.store.review(input);
  }
}
