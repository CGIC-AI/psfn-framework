import { Type } from '@sinclair/typebox';
import type { SubstrateAgentTool } from '../../boundary/pi-agent/index.js';
import { textResult, textResultWithError } from '../../core/tools/results.js';
import {
  NO_CAPABILITY_REQUIREMENT,
  withCapabilityRequirement,
} from '../../system/capabilities/requirements.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import type { ShardParentIcpPort } from './types.js';

export const SHARD_PARENT_ICP_TOOL_NAME = 'shard_parent_icp';

interface ShardParentIcpToolParams {
  content: string;
}

/**
 * A shard-only surface for ordinary status/questions to its bound parent.
 * The port retains all live-shard, lineage, and governed-ingress checks.
 */
export function createShardParentIcpTool(
  shardId: string,
  port: ShardParentIcpPort,
): SubstrateAgentTool {
  return withCapabilityRequirement({
    name: SHARD_PARENT_ICP_TOOL_NAME,
    label: SHARD_PARENT_ICP_TOOL_NAME,
    description: [
      'Send an ordinary status update or question to this shard’s parent companion.',
      'The message is queued through governed cognition intake with shard lineage.',
      'Use only when the parent should receive information before this shard finishes.',
    ].join(' '),
    parameters: Type.Object({
      content: Type.String({
        minLength: 1,
        description: 'The status update or question for the parent companion.',
      }),
    }, { additionalProperties: false }),
    execute: async (_toolCallId: string, params: ShardParentIcpToolParams) => {
      const content = params.content.trim();
      if (!content) {
        return textResultWithError(
          'shard_parent_icp failed: content must be non-empty.',
          true,
        );
      }
      try {
        await port.sendShardParentIcp(shardId, content);
        return textResult('Shard-parent ordinary ICP message queued.');
      } catch (error) {
        return textResultWithError(
          `shard_parent_icp failed: ${toErrorMessage(error)}`,
          true,
        );
      }
    },
  }, NO_CAPABILITY_REQUIREMENT);
}
