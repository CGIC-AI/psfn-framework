// ── Git Runtime Wiring ──
// Instantiates GitOps and registers all 6 git tools on a target (AgentLoop).

import type { AgentTool } from '@mariozechner/pi-agent-core';
import { GitOps, type GitOpsConfig } from './ops.js';
import {
  createRepoStatusTool,
  createRepoDiffTool,
  createRepoApplyPatchTool,
  createRepoCommitTool,
  createRepoCreateBranchTool,
  createRepoOpenPRTool,
} from './tools.js';

export interface GitRuntimeTarget {
  registerTool(tool: AgentTool<any>): void;
}

export function wireGitRuntime(
  target: GitRuntimeTarget,
  config?: Partial<GitOpsConfig>,
): GitOps {
  const gitOps = new GitOps(config);

  target.registerTool(createRepoStatusTool(gitOps));
  target.registerTool(createRepoDiffTool(gitOps));
  target.registerTool(createRepoApplyPatchTool(gitOps));
  target.registerTool(createRepoCommitTool(gitOps));
  target.registerTool(createRepoCreateBranchTool(gitOps));
  target.registerTool(createRepoOpenPRTool(gitOps));

  return gitOps;
}
