import type { AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import type { ArtifactReturnPort } from './port.js';
import type { ShardResult } from './types.js';

export function buildShardArtifactReturn(result: ShardResult): AgentToolResult<{ isError?: boolean }> {
  return {
    content: [{
      type: 'text',
      text:
        `[Shard "${result.name}" completed in ${result.durationMs}ms, `
        + `${result.turns} turn(s), `
        + `${result.inputTokens + result.outputTokens} tokens, `
        + `state=${result.lifecycleState}, runtime=${result.runtimeState}, `
        + `artifact=${result.artifactLifecycleState}, health=${result.health}]\n`
        + `[State reason: ${result.stateReason}]\n`
        + `[Runtime reason: ${result.runtimeStateReason}]\n`
        + `${result.failureReason
          ? `[Failure reason: ${result.failureReason}]\n`
          : ''}`
        + `${result.capabilities.length > 0
          ? `[Capabilities: ${result.capabilities.join(', ')}]\n`
          : ''}`
        + `${result.requiredCapabilities.length > 0
          ? `[Required capabilities: ${result.requiredCapabilities.join(', ')}]\n`
          : ''}\n`
        + `[Lineage: core=${result.lineage.coreCompanionId}, `
        + `shard=${result.lineage.shardCompanionId}, `
        + `mode=${result.lineage.creationMode}`
        + `${result.lineage.parentShardId ? `, parent=${result.lineage.parentShardId}` : ''}]\n\n`
        + `[Merge review: status=${result.mergeReview.status}, `
        + `required=${result.mergeReview.required}, `
        + `pending_tagged_outputs=${result.mergeReview.pendingTaggedOutputCount}]\n`
        + `[Validation path: ${result.mergeReview.validationPath}]\n`
        + `${result.mergeReview.blockingReasons.length > 0
          ? `[Merge review reasons: ${result.mergeReview.blockingReasons.join('; ')}]\n`
          : ''}`
        + `[Work log entries: ${result.workLog.length}]\n`
        + `${result.taggedOutputs.length > 0
          ? `[Tagged outputs: ${result.taggedOutputs
            .map(output => `${output.kind}:${output.outputId}:${output.reviewState}:${output.provenance.source}`)
            .join(', ')}]\n`
          : ''}\n`
        + result.content,
    }] satisfies TextContent[],
    details: {},
  };
}

export const shardArtifactReturnPort: ArtifactReturnPort = {
  portFamily: 'artifact',
  returnArtifact: buildShardArtifactReturn,
};
