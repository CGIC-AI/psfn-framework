import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitCommitResult, GitDiffResult, GitOperations, GitStatusResult } from './ops.js';
import {
  createRepoApplyPatchTool,
  createRepoCommitTool,
  createRepoCreateBranchTool,
  createRepoDiffTool,
  createRepoOpenPRTool,
  createRepoStatusTool,
} from './tools.js';

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

describe('repo tools', () => {
  let mockOps: ReturnType<typeof createMockGitOps>;

  beforeEach(() => {
    mockOps = createMockGitOps();
  });

  it('reports repository status through repo_status', async () => {
    mockOps.status.mockReturnValue({
      branch: 'feature/test',
      ahead: 1,
      behind: 0,
      staged: ['src/foo.ts'],
      modified: ['src/bar.ts'],
      untracked: ['src/new.ts'],
    } satisfies GitStatusResult);

    const tool = createRepoStatusTool(mockOps);
    const result = await tool.execute('call-status', {});
    const text = resultText(result);

    expect(tool.name).toBe('repo_status');
    expect(mockOps.status).toHaveBeenCalledTimes(1);
    expect(text).toContain('Branch: feature/test');
    expect(text).toContain('Staged (1): src/foo.ts');
    expect(text).toContain('Modified (1): src/bar.ts');
    expect(text).toContain('Untracked (1): src/new.ts');
  });

  it('returns staged and unstaged diffs through repo_diff', async () => {
    mockOps.diff.mockReturnValue({
      staged: 'staged diff',
      unstaged: 'unstaged diff',
    } satisfies GitDiffResult);

    const tool = createRepoDiffTool(mockOps);
    const result = await tool.execute('call-diff', { staged: false });
    const text = resultText(result);

    expect(mockOps.diff).toHaveBeenCalledWith({ staged: false });
    expect(text).toContain('=== Staged ===');
    expect(text).toContain('=== Unstaged ===');
  });

  it('truncates long diff output', async () => {
    const longDiff = 'x'.repeat(9000);
    mockOps.diff.mockReturnValue({
      staged: longDiff,
      unstaged: '',
    } satisfies GitDiffResult);

    const result = await createRepoDiffTool(mockOps).execute('call-diff-truncate', {});
    const text = resultText(result);

    expect(text).toContain('... (truncated)');
    expect(text.length).toBeLessThan(longDiff.length);
  });

  it('applies patches and creates branches through the split repo tools', async () => {
    mockOps.createBranch.mockReturnValue('feature/new');

    const patchResult = await createRepoApplyPatchTool(mockOps).execute('call-patch', {
      file_path: 'src/foo.ts',
      content: 'new content',
    });
    const branchResult = await createRepoCreateBranchTool(mockOps).execute('call-branch', {
      name: 'feature/new',
      start_point: 'develop',
    });

    expect(mockOps.applyPatch).toHaveBeenCalledWith('src/foo.ts', 'new content');
    expect(resultText(patchResult)).toContain('Applied and staged: src/foo.ts');
    expect(mockOps.createBranch).toHaveBeenCalledWith('feature/new', 'develop');
    expect(resultText(branchResult)).toContain('Created and checked out branch: feature/new');
  });

  it('commits and opens PRs through the split repo tools', async () => {
    mockOps.commit.mockReturnValue({
      hash: 'abc1234',
      message: 'Fix bug',
      filesChanged: 2,
    } satisfies GitCommitResult);
    mockOps.openPR.mockReturnValue('https://github.com/owner/repo/pull/42');

    const commitResult = await createRepoCommitTool(mockOps).execute('call-commit', {
      message: 'Fix bug',
      intent: 'fix bug',
      scope: 'core',
    });
    const prResult = await createRepoOpenPRTool(mockOps).execute('call-pr', {
      title: 'Title',
      body: 'Body',
      base: 'main',
    });

    expect(mockOps.commit).toHaveBeenCalledWith('Fix bug', 'fix bug', 'core');
    expect(resultText(commitResult)).toContain('Committed abc1234: Fix bug (2 files changed)');
    expect(mockOps.openPR).toHaveBeenCalledWith('Title', 'Body', 'main');
    expect(resultText(prResult)).toContain('PR created: https://github.com/owner/repo/pull/42');
  });

  it('returns canonical errors from delegated operations', async () => {
    mockOps.commit.mockRejectedValueOnce(new Error('commit failed'));

    const result = await createRepoCommitTool(mockOps).execute('call-commit-error', {
      message: 'Fix bug',
      intent: 'fix bug',
    });

    expect(resultText(result)).toContain('repo_commit failed: commit failed');
    expect(result.details?.isError).toBe(true);
  });
});
