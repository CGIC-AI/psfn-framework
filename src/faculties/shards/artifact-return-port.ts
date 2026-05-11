import { buildShardReturnedArtifacts, type ArtifactReturnRequest, type ShardArtifactMergePolicy, type ShardReturnedArtifact } from './artifact-policy.js';

export interface ArtifactReturnBatch {
  mergePolicy: ShardArtifactMergePolicy;
  artifacts: ShardReturnedArtifact[];
}

export interface ArtifactReturnPort {
  collectArtifactReturn(input: ArtifactReturnRequest): ArtifactReturnBatch | null;
}

export function createArtifactReturnPort(): ArtifactReturnPort {
  return {
    collectArtifactReturn(input) {
      const artifacts = buildShardReturnedArtifacts(input);
      if (artifacts.length === 0) {
        return null;
      }
      return {
        mergePolicy: 'review_required',
        artifacts,
      };
    },
  };
}
