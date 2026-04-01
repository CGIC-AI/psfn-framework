// ── Git Runtime Wiring ──
// Instantiates GitOps and registers the unified repo tool on a target.

import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { ToolRegistrar } from '../agent/tool-registrar.js';
import type { WirableTool, ToolWiringMeta } from '../agent/tool-wiring-validator.js';
import { GitOps, type GitOpsConfig, type GitOperations } from './ops.js';
import { createRepoTool } from './tools.js';

export interface GitRuntimeTarget {
  registerTool: ToolRegistrar;
}

/** Gateway RPC methods required by the unified repo tool */
const GIT_TOOL_GATEWAY_METHODS: Record<string, string[]> = {
  repo: [
    'git.status',
    'git.diff',
    'git.apply_patch',
    'git.commit',
    'git.create_branch',
    'git.open_pr',
  ],
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
  const tools: AgentTool<any>[] = [createRepoTool(gitOps)];

  for (const tool of tools) {
    if (options?.gatewayMode) {
      const methods = GIT_TOOL_GATEWAY_METHODS[tool.name];
      attachWiringMeta(tool, { requiredGatewayMethods: methods });
    }
    target.registerTool(tool, 'core');
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
