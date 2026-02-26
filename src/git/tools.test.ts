import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GitOperations, GitStatusResult, GitDiffResult, GitCommitResult } from './ops.js';
import {
  createRepoStatusTool,
  createRepoDiffTool,
  createRepoApplyPatchTool,
  createRepoCommitTool,
  createRepoCreateBranchTool,
  createRepoOpenPRTool,
} from './tools.js';

/** Extract text from AgentToolResult content array */
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

describe('git tools', () => {
  let mockOps: ReturnType<typeof createMockGitOps>;

  beforeEach(() => {
    mockOps = createMockGitOps();
  });

  // ── repo_status ──

  describe('repo_status', () => {
    it('has correct tool metadata', () => {
      const tool = createRepoStatusTool(mockOps);
      expect(tool.name).toBe('repo_status');
      expect(tool.description).toBeTruthy();
    });

    it('formats status output correctly', async () => {
      const status: GitStatusResult = {
        branch: 'feature/test',
        ahead: 1,
        behind: 0,
        staged: ['src/foo.ts'],
        modified: ['src/bar.ts'],
        untracked: ['src/new.ts'],
      };
      mockOps.status.mockReturnValue(status);

      const tool = createRepoStatusTool(mockOps);
      const result = await tool.execute('call-1', {});
      const text = resultText(result);

      expect(text).toContain('Branch: feature/test');
      expect(text).toContain('Ahead: 1');
      expect(text).toContain('Staged (1): src/foo.ts');
      expect(text).toContain('Modified (1): src/bar.ts');
      expect(text).toContain('Untracked (1): src/new.ts');
    });

    it('shows "No staged changes" when nothing staged', async () => {
      mockOps.status.mockReturnValue({
        branch: 'main',
        ahead: 0,
        behind: 0,
        staged: [],
        modified: [],
        untracked: [],
      });

      const tool = createRepoStatusTool(mockOps);
      const result = await tool.execute('call-1', {});
      const text = resultText(result);

      expect(text).toContain('No staged changes');
      expect(text).toContain('No unstaged modifications');
    });

    it('returns canonical error when status throws', async () => {
      mockOps.status.mockRejectedValueOnce(new Error('status failed'));

      const tool = createRepoStatusTool(mockOps);
      const result = await tool.execute('call-status-error', {});

      expect(resultText(result)).toContain('repo_status failed');
      expect(resultText(result)).toContain('status failed');
      expect(result.details?.isError).toBe(true);
    });
  });

  // ── repo_diff ──

  describe('repo_diff', () => {
    it('returns both staged and unstaged diffs', async () => {
      mockOps.diff.mockReturnValue({
        staged: 'staged diff',
        unstaged: 'unstaged diff',
      } satisfies GitDiffResult);

      const tool = createRepoDiffTool(mockOps);
      const result = await tool.execute('call-1', {});
      const text = resultText(result);

      expect(text).toContain('=== Staged ===');
      expect(text).toContain('staged diff');
      expect(text).toContain('=== Unstaged ===');
      expect(text).toContain('unstaged diff');
    });

    it('truncates at 8000 chars', async () => {
      const longDiff = 'x'.repeat(9000);
      mockOps.diff.mockReturnValue({
        staged: longDiff,
        unstaged: '',
      } satisfies GitDiffResult);

      const tool = createRepoDiffTool(mockOps);
      const result = await tool.execute('call-1', {});
      const text = resultText(result);

      expect(text).toContain('... (truncated)');
      expect(text.length).toBeLessThan(longDiff.length);
    });

    it('shows "No changes detected" when empty', async () => {
      mockOps.diff.mockReturnValue({ staged: '', unstaged: '' });

      const tool = createRepoDiffTool(mockOps);
      const result = await tool.execute('call-1', {});
      const text = resultText(result);

      expect(text).toBe('No changes detected.');
    });

    it('returns canonical error when diff throws', async () => {
      mockOps.diff.mockRejectedValueOnce(new Error('diff failed'));

      const tool = createRepoDiffTool(mockOps);
      const result = await tool.execute('call-diff-error', {});

      expect(resultText(result)).toContain('repo_diff failed');
      expect(resultText(result)).toContain('diff failed');
      expect(result.details?.isError).toBe(true);
    });
  });

  // ── repo_apply_patch ──

  describe('repo_apply_patch', () => {
    it('calls gitOps.applyPatch', async () => {
      const tool = createRepoApplyPatchTool(mockOps);
      const result = await tool.execute('call-1', {
        file_path: 'src/foo.ts',
        content: 'new content',
      });

      expect(mockOps.applyPatch).toHaveBeenCalledWith('src/foo.ts', 'new content');
      expect(resultText(result)).toContain('Applied and staged: src/foo.ts');
    });

    it('returns canonical error when applyPatch throws', async () => {
      mockOps.applyPatch.mockRejectedValueOnce(new Error('patch failed'));

      const tool = createRepoApplyPatchTool(mockOps);
      const result = await tool.execute('call-apply-error', {
        file_path: 'src/foo.ts',
        content: 'new content',
      });

      expect(resultText(result)).toContain('repo_apply_patch failed');
      expect(resultText(result)).toContain('patch failed');
      expect(result.details?.isError).toBe(true);
    });
  });

  // ── repo_commit ──

  describe('repo_commit', () => {
    it('calls gitOps.commit and formats result', async () => {
      const commitResult: GitCommitResult = {
        hash: 'abc1234',
        message: 'Fix bug',
        filesChanged: 2,
      };
      mockOps.commit.mockReturnValue(commitResult);

      const tool = createRepoCommitTool(mockOps);
      const result = await tool.execute('call-1', {
        message: 'Fix bug',
        intent: 'fix bug',
        scope: 'core',
      });

      expect(mockOps.commit).toHaveBeenCalledWith('Fix bug', 'fix bug', 'core');
      const text = resultText(result);
      expect(text).toContain('abc1234');
      expect(text).toContain('2 files changed');
    });

    it('returns canonical error when commit throws', async () => {
      mockOps.commit.mockRejectedValueOnce(new Error('commit failed'));

      const tool = createRepoCommitTool(mockOps);
      const result = await tool.execute('call-commit-error', {
        message: 'Fix bug',
        intent: 'fix bug',
      });

      expect(resultText(result)).toContain('repo_commit failed');
      expect(resultText(result)).toContain('commit failed');
      expect(result.details?.isError).toBe(true);
    });
  });

  // ── repo_create_branch ──

  describe('repo_create_branch', () => {
    it('calls gitOps.createBranch', async () => {
      mockOps.createBranch.mockReturnValue('feature/new');

      const tool = createRepoCreateBranchTool(mockOps);
      const result = await tool.execute('call-1', { name: 'feature/new' });

      expect(mockOps.createBranch).toHaveBeenCalledWith('feature/new', undefined);
      expect(resultText(result)).toContain('Created and checked out branch: feature/new');
    });

    it('passes start_point when provided', async () => {
      mockOps.createBranch.mockReturnValue('feature/new');

      const tool = createRepoCreateBranchTool(mockOps);
      await tool.execute('call-1', { name: 'feature/new', start_point: 'develop' });

      expect(mockOps.createBranch).toHaveBeenCalledWith('feature/new', 'develop');
    });

    it('returns canonical error when createBranch throws', async () => {
      mockOps.createBranch.mockRejectedValueOnce(new Error('branch failed'));

      const tool = createRepoCreateBranchTool(mockOps);
      const result = await tool.execute('call-branch-error', { name: 'feature/new' });

      expect(resultText(result)).toContain('repo_create_branch failed');
      expect(resultText(result)).toContain('branch failed');
      expect(result.details?.isError).toBe(true);
    });
  });

  // ── repo_open_pr ──

  describe('repo_open_pr', () => {
    it('calls gitOps.openPR and returns URL', async () => {
      mockOps.openPR.mockReturnValue('https://github.com/owner/repo/pull/42');

      const tool = createRepoOpenPRTool(mockOps);
      const result = await tool.execute('call-1', {
        title: 'Fix bug',
        body: 'Bug fix description',
      });

      expect(mockOps.openPR).toHaveBeenCalledWith('Fix bug', 'Bug fix description', undefined);
      expect(resultText(result)).toContain('PR created: https://github.com/owner/repo/pull/42');
    });

    it('passes base branch when provided', async () => {
      mockOps.openPR.mockReturnValue('https://github.com/owner/repo/pull/43');

      const tool = createRepoOpenPRTool(mockOps);
      await tool.execute('call-1', {
        title: 'Title',
        body: 'Body',
        base: 'develop',
      });

      expect(mockOps.openPR).toHaveBeenCalledWith('Title', 'Body', 'develop');
    });

    it('returns canonical error when openPR throws', async () => {
      mockOps.openPR.mockRejectedValueOnce(new Error('pr failed'));

      const tool = createRepoOpenPRTool(mockOps);
      const result = await tool.execute('call-pr-error', {
        title: 'Title',
        body: 'Body',
      });

      expect(resultText(result)).toContain('repo_open_pr failed');
      expect(resultText(result)).toContain('pr failed');
      expect(result.details?.isError).toBe(true);
    });
  });
});
