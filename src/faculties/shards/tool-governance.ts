import type { AgentTool, AgentToolResult } from '../../boundary/pi-agent/index.js';
import { textResultWithError } from '../../core/tools/results.js';
import {
  GOVERNED_SUBAGENT_TOOL_POLICIES,
  type SubagentToolCallClassification,
  type SubagentToolGovernancePolicy,
} from '../subagents/tool-governance.js';

/**
 * gjkh — canonical-tool governance parity for the shard seam (charter 6.13).
 *
 * The shard wrapper (ShardToolSyncHelper.wrapShardTool) only stages `memory`
 * mutations for fold review; every other parent-catalog tool reaches an
 * autonomous-tier ('*') shard loop verbatim and mutates live. Core stays
 * authoritative for identity, values, and trust truth, and a shard folds
 * proposed changes back through origin-side review rather than mutating live
 * (charter 6.13). `identity`, `north_star`, and `contact` therefore carry no
 * task-scoped read a bounded shard needs and are blocked at injection
 * (BLOCKED_SHARD_TOOL_NAMES in manager.ts), matching the subagent seam.
 *
 * `orient` multiplexes core-memory block edits, the values journal, the
 * concern ledger, and the introspection-consent policy — all core-authoritative
 * — but also exposes task-scoped reads (values_list, list_concerns,
 * introspection_consent_get). It keeps those reads under a read-pass /
 * mutation-deny wrapper here, reusing the exact p0le orient classification so
 * the shard and subagent seams never drift. There is no third governance
 * model: read passes through, every mutation is denied and audit-trailed.
 */

export interface ShardToolGovernanceContext {
  shardId: string;
  auditTrail: { append(event: string, details?: Record<string, unknown>): unknown } | null;
}

function requireOrientPolicy(): SubagentToolGovernancePolicy {
  const policy = GOVERNED_SUBAGENT_TOOL_POLICIES.get('orient');
  if (!policy) {
    throw new Error(
      'Shard tool governance requires the canonical orient read/mutation policy (p0le) to be '
      + 'present; the shard seam reuses it to stay in lockstep with the subagent seam. Its absence '
      + 'would let a shard mutate introspection consent, values, and concerns live (fail closed).',
    );
  }
  return policy;
}

/**
 * Canonical multiplexed tools that reach a shard loop only behind a read-only
 * governance wrapper. `orient` is the only such surface for shards; identity,
 * north_star, and contact are blocked at injection instead.
 */
export const GOVERNED_SHARD_TOOL_POLICIES: ReadonlyMap<string, SubagentToolGovernancePolicy> =
  new Map([['orient', requireOrientPolicy()]]);

/**
 * Wraps a core-authoritative multiplexed tool for injection into a shard loop:
 * read actions pass through unchanged, mutations are denied and audit-trailed.
 * There is no opt-in or elevation — a shard proposes changes in its fold
 * return for origin-side review (charter 6.13).
 */
export function createGovernedShardTool(
  tool: AgentTool<any>,
  policy: SubagentToolGovernancePolicy,
  context: ShardToolGovernanceContext,
): AgentTool<any> {
  return {
    ...tool,
    execute: async (toolCallId, params, signal) => {
      const classification = policy.classify(params);
      if (classification.kind === 'read') {
        return tool.execute(toolCallId, params as Parameters<typeof tool.execute>[1], signal);
      }
      return denyGovernedShardCall(tool, policy, context, toolCallId, classification);
    },
  };
}

function denyGovernedShardCall(
  tool: AgentTool<any>,
  policy: SubagentToolGovernancePolicy,
  context: ShardToolGovernanceContext,
  toolCallId: string,
  classification: SubagentToolCallClassification,
): AgentToolResult<{ isError?: boolean }> {
  const reason = classification.kind === 'mutation'
    ? 'mutation_not_permitted'
    : classification.kind === 'unknown'
      ? 'unknown_action'
      : 'action_unresolved';
  context.auditTrail?.append('shard.tool.mutation.denied', {
    shardId: context.shardId,
    toolName: tool.name,
    toolCallId,
    action: classification.action ?? 'unknown',
    reason,
  });
  const summary = classification.kind === 'mutation'
    ? `Error: ${tool.name} action "${classification.action}" mutates companion-canonical state and is `
      + 'not available from a shard context (fail closed).'
    : classification.kind === 'unknown'
      ? `Error: unrecognized ${tool.name} action "${classification.action}" from a shard context is `
        + 'denied (fail closed).'
      : `Error: ${tool.name} calls from a shard context must resolve to an explicit read action `
        + '(fail closed).';
  return textResultWithError(
    `${summary} Read actions available: ${policy.readActionsHelp}. `
    + 'Include any proposed change in your shard return for origin-side fold review (charter 6.13).',
    true,
    { errorClass: 'policy_blocked', retryHint: 'do_not_retry' },
  );
}
