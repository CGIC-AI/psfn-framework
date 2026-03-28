// ── Git Self-Modification Tools ──
// 6 agent-accessible tools for repository operations.
// Read-only: repo_status, repo_diff
// Write: repo_apply_patch, repo_commit, repo_create_branch, repo_open_pr

import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { GitOperations } from './ops.js';
import { textResult, textResultWithError } from '../tools/results.js';
import { toErrorMessage } from '../shared/utils/errors.js';

const MAX_DIFF_CHARS = 8000;

function errorMessage(error: unknown): string {
  return toErrorMessage(error);
}

export function createRepoStatusTool(gitOps: GitOperations): AgentTool<any> {
  return {
    name: 'repo_status',
    label: 'repo_status',
    description:
      'Show the current git repository status: branch, ahead/behind, staged, modified, and untracked files.',
    parameters: Type.Object({}),
    execute: async (): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const status = await gitOps.status();
        const lines = [
          `Branch: ${status.branch}`,
          status.ahead > 0 || status.behind > 0
            ? `Ahead: ${status.ahead}, Behind: ${status.behind}`
            : null,
          status.staged.length > 0
            ? `Staged (${status.staged.length}): ${status.staged.join(', ')}`
            : 'No staged changes',
          status.modified.length > 0
            ? `Modified (${status.modified.length}): ${status.modified.join(', ')}`
            : 'No unstaged modifications',
          status.untracked.length > 0
            ? `Untracked (${status.untracked.length}): ${status.untracked.join(', ')}`
            : null,
        ].filter(Boolean);
        return textResult(lines.join('\n'));
      } catch (error) {
        return textResultWithError(`repo_status failed: ${errorMessage(error)}`, true);
      }
    },
  };
}

export function createRepoDiffTool(gitOps: GitOperations): AgentTool<any> {
  return {
    name: 'repo_diff',
    label: 'repo_diff',
    description:
      'Show git diff of current changes. Returns both staged and unstaged diffs (truncated at 8000 chars each).',
    parameters: Type.Object({
      staged: Type.Optional(
        Type.Boolean({ description: 'If true, include staged diff. Default: true.' }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: { staged?: boolean },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const diff = await gitOps.diff({ staged: params.staged });
        const parts: string[] = [];
        if (diff.staged) {
          const truncated =
            diff.staged.length > MAX_DIFF_CHARS
              ? diff.staged.slice(0, MAX_DIFF_CHARS) + '\n... (truncated)'
              : diff.staged;
          parts.push(`=== Staged ===\n${truncated}`);
        }
        if (diff.unstaged) {
          const truncated =
            diff.unstaged.length > MAX_DIFF_CHARS
              ? diff.unstaged.slice(0, MAX_DIFF_CHARS) + '\n... (truncated)'
              : diff.unstaged;
          parts.push(`=== Unstaged ===\n${truncated}`);
        }
        return textResult(parts.length > 0 ? parts.join('\n\n') : 'No changes detected.');
      } catch (error) {
        return textResultWithError(`repo_diff failed: ${errorMessage(error)}`, true);
      }
    },
  };
}

export function createRepoApplyPatchTool(gitOps: GitOperations): AgentTool<any> {
  return {
    name: 'repo_apply_patch',
    label: 'repo_apply_patch',
    description:
      'Write content to a file and stage it for commit. Path must be in allowed directories ' +
      '(src/, docs/, companion/; legacy psfn/ is still allowed). Blocked on protected branches.',
    parameters: Type.Object({
      file_path: Type.String({
        description: 'Path relative to repo root (must be in allowed directories).',
      }),
      content: Type.String({ description: 'Full file content to write.' }),
    }),
    execute: async (
      _toolCallId: string,
      params: { file_path: string; content: string },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        await gitOps.applyPatch(params.file_path, params.content);
        return textResult(`Applied and staged: ${params.file_path}`);
      } catch (error) {
        return textResultWithError(`repo_apply_patch failed: ${errorMessage(error)}`, true);
      }
    },
  };
}

export function createRepoCommitTool(gitOps: GitOperations): AgentTool<any> {
  return {
    name: 'repo_commit',
    label: 'repo_commit',
    description:
      'Commit all staged changes with a message. Blocked on protected branches (main, master).',
    parameters: Type.Object({
      message: Type.String({ description: 'Commit message describing the change.' }),
      intent: Type.String({
        description: 'Purpose of the change (e.g., "add feature", "fix bug", "refactor").',
      }),
      scope: Type.Optional(
        Type.String({ description: 'Optional scope/area of the change.' }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: { message: string; intent: string; scope?: string },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const result = await gitOps.commit(params.message, params.intent, params.scope);
        return textResult(
          `Committed ${result.hash}: ${result.message} (${result.filesChanged} files changed)`,
        );
      } catch (error) {
        return textResultWithError(`repo_commit failed: ${errorMessage(error)}`, true);
      }
    },
  };
}

export function createRepoCreateBranchTool(gitOps: GitOperations): AgentTool<any> {
  return {
    name: 'repo_create_branch',
    label: 'repo_create_branch',
    description:
      'Create and checkout a new git branch. Branch name must use safe characters. Cannot create protected branch names.',
    parameters: Type.Object({
      name: Type.String({
        description: 'Branch name (alphanumeric, dots, slashes, hyphens).',
      }),
      start_point: Type.Optional(
        Type.String({ description: 'Optional starting commit/branch. Defaults to HEAD.' }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: { name: string; start_point?: string },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const name = await gitOps.createBranch(params.name, params.start_point);
        return textResult(`Created and checked out branch: ${name}`);
      } catch (error) {
        return textResultWithError(`repo_create_branch failed: ${errorMessage(error)}`, true);
      }
    },
  };
}

export function createRepoOpenPRTool(gitOps: GitOperations): AgentTool<any> {
  return {
    name: 'repo_open_pr',
    label: 'repo_open_pr',
    description:
      'Open a GitHub pull request from the current branch. Blocked on protected branches (main, master). ' +
      'Requires the gh CLI to be installed.',
    parameters: Type.Object({
      title: Type.String({ description: 'PR title.' }),
      body: Type.String({ description: 'PR description body (markdown).' }),
      base: Type.Optional(
        Type.String({ description: 'Base branch. Defaults to repo default.' }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: { title: string; body: string; base?: string },
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const url = await gitOps.openPR(params.title, params.body, params.base);
        return textResult(`PR created: ${url}`);
      } catch (error) {
        return textResultWithError(`repo_open_pr failed: ${errorMessage(error)}`, true);
      }
    },
  };
}
