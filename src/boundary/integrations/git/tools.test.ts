import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitCommitResult, GitDiffResult, GitOperations, GitStatusResult } from './ops.js';
import { createRepoTool } from './tools.js';

function resultText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map(c => c.text).join('');
}

function createMockGitOps(): Record<string, ReturnType<typeof vi.fn>> & GitOperations {
  return {
    status: vi.fn(),
    diff: vi.fn(),
    createBranch: vi.fn(),
    applyPatch: vi.fn(),
    commit: vi.fn(),
    openPR: vi.fn(),
  } as any;
}

describe('repo tool', () => {
  let mockOps: ReturnType<typeof createMockGitOps>;

  beforeEach(() => {
    mockOps = createMockGitOps();
  });

  it('describes inspect-first workflow and required mutation arguments', () => {
    const tool = createRepoTool(mockOps);

    expect(tool.description).toContain('Use action=inspect before mutating');
    expect(tool.description).toContain('action=patch requires file_path and full replacement content');
    expect(tool.description).toContain('action=branch requires name');
    expect(tool.description).toContain('action=commit requires message');
    expect(tool.description).toContain('action=publish/open_pr requires title/body');
  });

  it('reports repository status and diff through the unified repo surface', async () => {
    mockOps.status.mockReturnValue({
      branch: 'feature/test',
      ahead: 1,
      behind: 0,
      staged: ['src/foo.ts'],
      modified: ['src/bar.ts'],
      untracked: ['src/new.ts'],
    } satisfies GitStatusResult);
    mockOps.diff.mockReturnValue({
      staged: 'staged diff',
      unstaged: 'unstaged diff',
    } satisfies GitDiffResult);

    const tool = createRepoTool(mockOps);
    const statusResult = await tool.execute('call-status', {});
    const diffResult = await tool.execute('call-diff', {
      action: 'inspect',
      target: 'diff',
      staged: false,
    });

    expect(tool.name).toBe('repo');
    expect(mockOps.status).toHaveBeenCalledTimes(1);
    expect(mockOps.diff).toHaveBeenCalledWith({ staged: false });
    expect(resultText(statusResult)).toContain('Branch: feature/test');
    expect(resultText(statusResult)).toContain('Staged (1): src/foo.ts');
    expect(resultText(diffResult)).toContain('=== Staged ===');
    expect(resultText(diffResult)).toContain('=== Unstaged ===');
  });

  it('truncates long diff output', async () => {
    const longDiff = 'x'.repeat(9000);
    mockOps.diff.mockReturnValue({
      staged: longDiff,
      unstaged: '',
    } satisfies GitDiffResult);

    const result = await createRepoTool(mockOps).execute('call-diff-truncate', {
      action: 'diff',
    });
    const text = resultText(result);

    expect(text).toContain('... (truncated)');
    expect(text.length).toBeLessThan(longDiff.length);
  });

  it('applies patches, creates branches, commits, and opens PRs through unified repo actions', async () => {
    mockOps.createBranch.mockReturnValue('feature/new');
    mockOps.commit.mockReturnValue({
      hash: 'abc1234',
      message: 'Fix bug',
      filesChanged: 2,
    } satisfies GitCommitResult);
    mockOps.openPR.mockReturnValue('https://github.com/owner/repo/pull/42');

    const tool = createRepoTool(mockOps);
    const patchResult = await tool.execute('call-patch', {
      action: 'patch',
      file_path: 'src/foo.ts',
      content: 'new content',
    });
    const branchResult = await tool.execute('call-branch', {
      action: 'branch',
      name: 'feature/new',
      start_point: 'develop',
    });
    const commitResult = await tool.execute('call-commit', {
      action: 'commit',
      message: 'Fix bug',
      intent: 'fix bug',
      scope: 'core',
    });
    const prResult = await tool.execute('call-pr', {
      action: 'publish',
      title: 'Title',
      body: 'Body',
      base: 'main',
    });

    expect(mockOps.applyPatch).toHaveBeenCalledWith('src/foo.ts', 'new content');
    expect(resultText(patchResult)).toContain('Applied and staged: src/foo.ts');
    expect(mockOps.createBranch).toHaveBeenCalledWith('feature/new', 'develop');
    expect(resultText(branchResult)).toContain('Created and checked out branch: feature/new');
    expect(mockOps.commit).toHaveBeenCalledWith('Fix bug', 'fix bug', 'core');
    expect(resultText(commitResult)).toContain('Committed abc1234: Fix bug (2 files changed)');
    expect(mockOps.openPR).toHaveBeenCalledWith('Title', 'Body', 'main');
    expect(resultText(prResult)).toContain('PR created: https://github.com/owner/repo/pull/42');
  });

  it('denies mutation actions in read_only mode', async () => {
    const tool = createRepoTool(mockOps, { access: 'read_only' });
    const result = await tool.execute('call-patch', {
      action: 'patch',
      file_path: 'src/foo.ts',
      content: 'new content',
    });

    expect(mockOps.applyPatch).not.toHaveBeenCalled();
    expect(resultText(result)).toContain('repo failed: repo action is unavailable in read_only mode');
    expect(result.details?.isError).toBe(true);
  });

  it('returns canonical errors from delegated operations', async () => {
    mockOps.commit.mockRejectedValueOnce(new Error('commit failed'));

    const result = await createRepoTool(mockOps).execute('call-commit-error', {
      action: 'commit',
      message: 'Fix bug',
      intent: 'fix bug',
    });

    expect(resultText(result)).toContain('repo failed: commit failed');
    expect(result.details?.isError).toBe(true);
  });

  it('returns minimal valid JSON examples for missing mutation arguments', async () => {
    const missingPatchPath = await createRepoTool(mockOps).execute('call-patch-missing-path', {
      action: 'patch',
      content: 'new content',
    });
    const missingCommitIntent = await createRepoTool(mockOps).execute('call-commit-missing-intent', {
      action: 'commit',
      message: 'Fix bug',
    });
    const missingPublishBody = await createRepoTool(mockOps).execute('call-publish-missing-body', {
      action: 'publish',
      title: 'Title',
    });

    expect(resultText(missingPatchPath)).toContain('Missing required field "file_path"');
    expect(resultText(missingPatchPath)).toContain('"action":"patch"');
    expect(resultText(missingCommitIntent)).toContain('Missing required field "intent"');
    expect(resultText(missingCommitIntent)).toContain('"action":"commit"');
    expect(resultText(missingPublishBody)).toContain('Missing required field "body"');
    expect(resultText(missingPublishBody)).toContain('"action":"publish"');
  });
});
