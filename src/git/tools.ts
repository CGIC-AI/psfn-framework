import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import type { GitOperations, GitStatusResult, GitDiffResult } from './ops.js';
import { textResult, textResultWithError } from '../tools/results.js';
import { toErrorMessage } from '../utils/errors.js';

const MAX_DIFF_CHARS = 8000;

type RepoAction = 'inspect' | 'patch' | 'branch' | 'commit' | 'publish';
type RepoInspectTarget = 'status' | 'diff' | 'both';

function normalizeAction(params: Record<string, unknown>): RepoAction {
  const action = typeof params.action === 'string' ? params.action.trim() : '';
  if (action.length === 0 && Object.keys(params).length === 0) {
    return 'inspect';
  }

  switch (action) {
    case 'inspect':
    case 'patch':
    case 'branch':
    case 'commit':
    case 'publish':
      return action;
    default:
      throw new Error(
        'action is required. Supported actions: inspect, patch, branch, commit, publish.',
      );
  }
}

function normalizeInspectTarget(params: Record<string, unknown>): RepoInspectTarget {
  const target = typeof params.target === 'string' ? params.target.trim() : '';
  if (!target) {
    return 'status';
  }

  switch (target) {
    case 'status':
    case 'diff':
    case 'both':
      return target;
    default:
      throw new Error('target is invalid. Supported inspect targets: status, diff, both.');
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required.`);
  }
  return value;
}

function requireStringField(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} is required.`);
  }
  return value;
}

function formatStatus(status: GitStatusResult): string {
  return [
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
  ].filter(Boolean).join('\n');
}

function truncateDiffSection(diffText: string): string {
  return diffText.length > MAX_DIFF_CHARS
    ? diffText.slice(0, MAX_DIFF_CHARS) + '\n... (truncated)'
    : diffText;
}

function formatDiff(diff: GitDiffResult): string {
  const parts: string[] = [];
  if (diff.staged) {
    parts.push(`=== Staged ===\n${truncateDiffSection(diff.staged)}`);
  }
  if (diff.unstaged) {
    parts.push(`=== Unstaged ===\n${truncateDiffSection(diff.unstaged)}`);
  }
  return parts.length > 0 ? parts.join('\n\n') : 'No changes detected.';
}

async function executeInspect(
  gitOps: GitOperations,
  params: Record<string, unknown>,
): Promise<AgentToolResult<{ isError?: boolean }>> {
  const target = normalizeInspectTarget(params);

  if (target === 'status') {
    return textResult(formatStatus(await gitOps.status()));
  }

  if (target === 'diff') {
    return textResult(formatDiff(await gitOps.diff({
      staged: typeof params.staged === 'boolean' ? params.staged : undefined,
    })));
  }

  const [status, diff] = await Promise.all([
    gitOps.status(),
    gitOps.diff({
      staged: typeof params.staged === 'boolean' ? params.staged : undefined,
    }),
  ]);

  return textResult(`=== Status ===\n${formatStatus(status)}\n\n=== Diff ===\n${formatDiff(diff)}`);
}

export function createRepoTool(gitOps: GitOperations): AgentTool<any> {
  return {
    name: 'repo',
    label: 'repo',
    description:
      'Unified repository primitive for git-backed inspection and mutation. '
      + 'Use action=inspect|patch|branch|commit|publish. '
      + 'Inspect is read-only; patch, branch, commit, and publish remain explicitly gated.',
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal('inspect'),
        Type.Literal('patch'),
        Type.Literal('branch'),
        Type.Literal('commit'),
        Type.Literal('publish'),
      ], {
        description: 'Repository action. Defaults to inspect for empty-argument calls.',
      })),
      target: Type.Optional(Type.Union([
        Type.Literal('status'),
        Type.Literal('diff'),
        Type.Literal('both'),
      ], {
        description: 'Used with action=inspect. Defaults to status.',
      })),
      staged: Type.Optional(Type.Boolean({
        description: 'Used with action=inspect target=diff|both. Set false to omit staged diff output.',
      })),
      file_path: Type.Optional(Type.String({
        description: 'Used with action=patch. Repo-relative path in the allowlisted mutation surface.',
      })),
      content: Type.Optional(Type.String({
        description: 'Used with action=patch. Full file content to write and stage.',
      })),
      name: Type.Optional(Type.String({
        description: 'Used with action=branch. Branch name (safe characters only).',
      })),
      start_point: Type.Optional(Type.String({
        description: 'Used with action=branch. Optional starting commit or branch. Defaults to HEAD.',
      })),
      message: Type.Optional(Type.String({
        description: 'Used with action=commit. Commit message describing the change.',
      })),
      intent: Type.Optional(Type.String({
        description: 'Used with action=commit. Purpose of the change.',
      })),
      scope: Type.Optional(Type.String({
        description: 'Used with action=commit. Optional change scope.',
      })),
      title: Type.Optional(Type.String({
        description: 'Used with action=publish. Pull request title.',
      })),
      body: Type.Optional(Type.String({
        description: 'Used with action=publish. Pull request body.',
      })),
      base: Type.Optional(Type.String({
        description: 'Used with action=publish. Optional base branch.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      try {
        const action = normalizeAction(params);

        switch (action) {
          case 'inspect':
            return await executeInspect(gitOps, params);

          case 'patch': {
            const filePath = requireString(params.file_path, 'file_path');
            const content = requireStringField(params.content, 'content');
            await gitOps.applyPatch(filePath, content);
            return textResult(`Applied and staged: ${filePath}`);
          }

          case 'branch': {
            const name = await gitOps.createBranch(
              requireString(params.name, 'name'),
              typeof params.start_point === 'string' ? params.start_point : undefined,
            );
            return textResult(`Created and checked out branch: ${name}`);
          }

          case 'commit': {
            const result = await gitOps.commit(
              requireString(params.message, 'message'),
              requireString(params.intent, 'intent'),
              typeof params.scope === 'string' ? params.scope : undefined,
            );
            return textResult(
              `Committed ${result.hash}: ${result.message} (${result.filesChanged} files changed)`,
            );
          }

          case 'publish': {
            const url = await gitOps.openPR(
              requireString(params.title, 'title'),
              requireStringField(params.body, 'body'),
              typeof params.base === 'string' ? params.base : undefined,
            );
            return textResult(`PR created: ${url}`);
          }
        }
      } catch (error) {
        return textResultWithError(`repo failed: ${toErrorMessage(error)}`, true);
      }
    },
  };
}
