import type {
  GitStatusParams,
  GitDiffParams,
  GitCreateBranchParams,
  GitApplyPatchParams,
  GitCommitParams,
  GitOpenPRParams,
} from '../protocol.js';
import type { AuditedMethodDescriptor, GatewayMethodRuntime } from './types.js';
import { registerAuditedDescriptors } from './register.js';

const gitDescriptors: Array<AuditedMethodDescriptor<any, unknown>> = [
  {
    name: 'git.status',
    handler: async (_params: GitStatusParams, runtime) => {
      if (!runtime.gitOps) throw new Error('Git operations are not configured');
      return runtime.gitOps.status();
    },
  },
  {
    name: 'git.diff',
    handler: async (params: GitDiffParams, runtime) => {
      if (!runtime.gitOps) throw new Error('Git operations are not configured');
      return runtime.gitOps.diff({ staged: params.staged });
    },
    summary: (p: GitDiffParams) => ({ staged: p.staged ?? true }),
  },
  {
    name: 'git.create_branch',
    handler: async (params: GitCreateBranchParams, runtime) => {
      if (!runtime.gitOps) throw new Error('Git operations are not configured');
      const name = await runtime.gitOps.createBranch(params.name, params.startPoint);
      return { name };
    },
    summary: (p: GitCreateBranchParams) => ({ name: p.name, startPoint: p.startPoint }),
  },
  {
    name: 'git.apply_patch',
    handler: async (params: GitApplyPatchParams, runtime) => {
      if (!runtime.gitOps) throw new Error('Git operations are not configured');
      await runtime.gitOps.applyPatch(params.filePath, params.content);
      return { success: true };
    },
    summary: (p: GitApplyPatchParams) => ({ filePath: p.filePath, contentLength: p.content.length }),
  },
  {
    name: 'git.commit',
    handler: async (params: GitCommitParams, runtime) => {
      if (!runtime.gitOps) throw new Error('Git operations are not configured');
      return runtime.gitOps.commit(params.message, params.intent, params.scope);
    },
    summary: (p: GitCommitParams) => ({ intent: p.intent, scope: p.scope }),
  },
  {
    name: 'git.open_pr',
    handler: async (params: GitOpenPRParams, runtime) => {
      if (!runtime.gitOps) throw new Error('Git operations are not configured');
      const url = await runtime.gitOps.openPR(params.title, params.body, params.base);
      return { url };
    },
    summary: (p: GitOpenPRParams) => ({ title: p.title, base: p.base }),
  },
];

export function registerGitMethods(runtime: GatewayMethodRuntime): void {
  if (!runtime.gitOps) return;
  registerAuditedDescriptors(runtime, gitDescriptors);
}
