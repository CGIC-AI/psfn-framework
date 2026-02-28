// ── Git Runtime Wiring ──
// Instantiates GitOps and registers all 6 git tools on a target (SubstrateAgent).

import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ToolRegistrar } from '../agent/tool-registrar.js';
import type { WirableTool, ToolWiringMeta } from '../agent/tool-wiring-validator.js';
import { GitOps, type GitOpsConfig, type GitOperations } from './ops.js';
import {
  createRepoStatusTool,
  createRepoDiffTool,
  createRepoApplyPatchTool,
  createRepoCommitTool,
  createRepoCreateBranchTool,
  createRepoOpenPRTool,
} from './tools.js';

export interface GitRuntimeTarget {
  registerTool: ToolRegistrar;
}

/** Gateway RPC methods required by each git tool */
const GIT_TOOL_GATEWAY_METHODS: Record<string, string[]> = {
  repo_status: ['git.status'],
  repo_diff: ['git.diff'],
  repo_apply_patch: ['git.apply_patch'],
  repo_commit: ['git.commit'],
  repo_create_branch: ['git.create_branch'],
  repo_open_pr: ['git.open_pr'],
};

function attachWiringMeta(tool: AgentTool<any>, meta: ToolWiringMeta): WirableTool {
  const wirable = tool as WirableTool;
  wirable.wiringMeta = meta;
  return wirable;
}

export interface RegisterGitToolsOptions {
  /** When true, attaches gateway RPC method requirements as wiring metadata */
  gatewayMode?: boolean;
}

export function registerGitTools(
  target: GitRuntimeTarget,
  gitOps: GitOperations,
  options?: RegisterGitToolsOptions,
): void {
  const tools: AgentTool<any>[] = [
    createRepoStatusTool(gitOps),
    createRepoDiffTool(gitOps),
    createRepoApplyPatchTool(gitOps),
    createRepoCommitTool(gitOps),
    createRepoCreateBranchTool(gitOps),
    createRepoOpenPRTool(gitOps),
  ];

  for (const tool of tools) {
    if (options?.gatewayMode) {
      const methods = GIT_TOOL_GATEWAY_METHODS[tool.name];
      if (methods) {
        attachWiringMeta(tool, { requiredGatewayMethods: methods });
      }
    }
    target.registerTool(tool, 'extended');
  }
}

export function wireGitRuntime(
  target: GitRuntimeTarget,
  config?: Partial<GitOpsConfig>,
): GitOps {
  const gitOps = new GitOps(config);
  registerGitTools(target, gitOps);
  return gitOps;
}
