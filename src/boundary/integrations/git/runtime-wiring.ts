import type { AgentTool } from '../../pi-agent/index.js';
import type { ToolRegistrar } from '../../../core/agent/tool-registrar.js';
import type { WirableTool, ToolWiringMeta } from '../../../core/agent/tool-wiring-validator.js';
import { GitOps, type GitOpsConfig, type GitOperations } from './ops.js';
import { createRepoTool } from './tools.js';

export interface GitRuntimeTarget {
  registerTool: ToolRegistrar;
}

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
  gatewayMode?: boolean;
  access?: 'full' | 'read_only';
}

export function registerGitTools(
  target: GitRuntimeTarget,
  gitOps: GitOperations,
  options?: RegisterGitToolsOptions,
): void {
  const tool = createRepoTool(gitOps, {
    access: options?.access,
  });

  if (options?.gatewayMode) {
    attachWiringMeta(tool, { requiredGatewayMethods: GIT_TOOL_GATEWAY_METHODS[tool.name] });
  }

  // Image-tools img2 audit: repo is a deliberate dev surface, not part of the
  // companion's default social/expressive stack. It remains cataloged as an
  // extended tool while capability and turn-policy gates decide callability.
  target.registerTool(tool, 'extended');
}

export function wireGitRuntime(
  target: GitRuntimeTarget,
  config?: Partial<GitOpsConfig>,
  options?: RegisterGitToolsOptions,
): GitOps {
  const gitOps = new GitOps(config);
  registerGitTools(target, gitOps, options);
  return gitOps;
}
