import type {
  IdentityIntakeItemStatus,
  IdentityIntakeReviewState,
} from '../../templates/identity.js';
import { truncateDebugText } from '../../utils.js';
import type { StagedIdentityIntake } from './intake-stage.js';

export function buildIdentityIntakeReviewState(
  stagedIntake: StagedIdentityIntake | null,
): IdentityIntakeReviewState | null {
  if (!stagedIntake) return null;
  return {
    stageId: stagedIntake.id,
    createdAt: stagedIntake.createdAt,
    updatedAt: stagedIntake.updatedAt,
    status: stagedIntake.status,
    sources: stagedIntake.sources,
    cardMutation: stagedIntake.cardMutation
      ? {
        sourcePath: stagedIntake.cardMutation.sourcePath,
        containerFormat: stagedIntake.cardMutation.containerFormat,
        spec: stagedIntake.cardMutation.spec,
        warnings: stagedIntake.cardMutation.warnings,
        status: stagedIntake.cardMutation.status,
        rows: stagedIntake.cardMutation.rows,
      }
      : undefined,
    chatProposal: stagedIntake.chatMutation
      ? {
        channelId: stagedIntake.chatMutation.channelId,
        totalMessages: stagedIntake.chatMutation.messages.length,
        chunkTargetTokens: stagedIntake.chatMutation.chunkTargetTokens,
        chunks: stagedIntake.chatMutation.chunks,
      }
      : undefined,
    memoryItems: stagedIntake.memoryMutations.map(item => ({
      id: item.id,
      source: item.source,
      textPreview: truncateDebugText(item.text, 220),
      type: item.type,
      importance: item.importance,
      salience: item.salience,
      criticality: item.criticality,
      mergeDecision: item.mergeDecision,
      mergeTargetId: item.mergeTargetId,
      existingSalience: item.existingSalience,
      proposedSalience: item.proposedSalience,
      provenanceRefs: item.provenanceRefs,
      relationshipTypeHint: item.relationshipTypeHint,
      relationshipUpdatePlanned: item.relationshipUpdatePlanned,
      relationshipUpdateApplied: item.relationshipUpdateApplied,
      status: item.status,
      error: item.error,
    })),
  };
}

export function recomputeStagedIntakeStatus(stage: StagedIdentityIntake): void {
  const statuses: IdentityIntakeItemStatus[] = [];
  if (stage.cardMutation) statuses.push(stage.cardMutation.status);
  if (stage.chatMutation) statuses.push(...stage.chatMutation.chunks.map(chunk => chunk.status));
  statuses.push(...stage.memoryMutations.map(item => item.status));

  const pending = statuses.filter(status => status === 'pending').length;
  const committed = statuses.filter(status => status === 'committed').length;
  const rejected = statuses.filter(status => status === 'rejected').length;
  const failed = statuses.filter(status => status === 'failed').length;

  if (pending === 0 && committed > 0 && rejected === 0 && failed === 0) {
    stage.status = 'committed';
  } else if (pending === 0 && committed === 0 && (rejected > 0 || failed > 0)) {
    stage.status = 'rejected';
  } else if (committed > 0 || rejected > 0 || failed > 0) {
    stage.status = 'partially_committed';
  } else {
    stage.status = 'pending';
  }
  stage.updatedAt = Date.now();
}
