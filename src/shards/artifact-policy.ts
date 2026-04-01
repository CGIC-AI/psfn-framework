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
        + `state=${result.lifecycleState}, health=${result.health}]\n`
        + `[State reason: ${result.stateReason}]\n`
        + `${result.failureReason
          ? `[Failure reason: ${result.failureReason}]\n`
          : ''}`
        + `${result.capabilities.length > 0
          ? `[Capabilities: ${result.capabilities.join(', ')}]\n`
          : ''}`
        + `${result.requiredCapabilities.length > 0
          ? `[Required capabilities: ${result.requiredCapabilities.join(', ')}]\n`
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
