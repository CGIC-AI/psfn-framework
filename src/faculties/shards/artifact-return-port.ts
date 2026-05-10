import { buildShardReturnedArtifacts, type ShardArtifactMergePolicy, type ShardReturnedArtifact } from './artifact-policy.js';
import type { ShardResultLineageEnvelope } from './result-lineage.js';

export interface ArtifactReturnRequest {
  lineage: ShardResultLineageEnvelope;
  turnIndex: number;
  turnMessageId: string;
  attachments: readonly unknown[] | undefined;
}

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
