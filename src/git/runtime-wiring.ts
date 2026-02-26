// ── Git Runtime Wiring ──
// Instantiates GitOps and registers all 6 git tools on a target (SubstrateAgent).

import type { AgentTool } from '@mariozechner/pi-agent-core';
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
  registerTool(tool: AgentTool<any>, category?: 'core' | 'extended'): void;
}

export function registerGitTools(target: GitRuntimeTarget, gitOps: GitOperations): void {
  target.registerTool(createRepoStatusTool(gitOps), 'extended');
  target.registerTool(createRepoDiffTool(gitOps), 'extended');
  target.registerTool(createRepoApplyPatchTool(gitOps), 'extended');
  target.registerTool(createRepoCommitTool(gitOps), 'extended');
  target.registerTool(createRepoCreateBranchTool(gitOps), 'extended');
  target.registerTool(createRepoOpenPRTool(gitOps), 'extended');
}

export function wireGitRuntime(
  target: GitRuntimeTarget,
  config?: Partial<GitOpsConfig>,
): GitOps {
  const gitOps = new GitOps(config);
  registerGitTools(target, gitOps);
  return gitOps;
}
