import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GitOperations, GitStatusResult, GitDiffResult, GitCommitResult } from './ops.js';
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

  it('has unified repo metadata', () => {
    const tool = createRepoTool(mockOps);
    expect(tool.name).toBe('repo');
    expect(tool.description).toContain('action=inspect|patch|branch|commit|publish');
  });

  it('defaults empty calls to inspect status', async () => {
    mockOps.status.mockReturnValue({
      branch: 'feature/test',
      ahead: 1,
      behind: 0,
      staged: ['src/foo.ts'],
      modified: ['src/bar.ts'],
      untracked: ['src/new.ts'],
    } satisfies GitStatusResult);

    const tool = createRepoTool(mockOps);
    const result = await tool.execute('call-1', {});
    const text = resultText(result);

    expect(mockOps.status).toHaveBeenCalledTimes(1);
    expect(mockOps.diff).not.toHaveBeenCalled();
    expect(text).toContain('Branch: feature/test');
    expect(text).toContain('Staged (1): src/foo.ts');
    expect(text).toContain('Modified (1): src/bar.ts');
    expect(text).toContain('Untracked (1): src/new.ts');
  });

  it('returns diff output for inspect target=diff', async () => {
    mockOps.diff.mockReturnValue({
      staged: 'staged diff',
      unstaged: 'unstaged diff',
    } satisfies GitDiffResult);

    const tool = createRepoTool(mockOps);
    const result = await tool.execute('call-2', { action: 'inspect', target: 'diff' });
    const text = resultText(result);

    expect(mockOps.status).not.toHaveBeenCalled();
    expect(mockOps.diff).toHaveBeenCalledWith({ staged: undefined });
    expect(text).toContain('=== Staged ===');
    expect(text).toContain('=== Unstaged ===');
  });

  it('returns status and diff for inspect target=both', async () => {
    mockOps.status.mockReturnValue({
      branch: 'feature/test',
      ahead: 0,
      behind: 0,
      staged: [],
      modified: [],
      untracked: [],
    } satisfies GitStatusResult);
    mockOps.diff.mockReturnValue({
      staged: 'cached',
      unstaged: '',
    } satisfies GitDiffResult);

    const tool = createRepoTool(mockOps);
    const result = await tool.execute('call-3', { action: 'inspect', target: 'both', staged: false });
    const text = resultText(result);

    expect(mockOps.status).toHaveBeenCalledTimes(1);
    expect(mockOps.diff).toHaveBeenCalledWith({ staged: false });
    expect(text).toContain('=== Status ===');
    expect(text).toContain('=== Diff ===');
  });

  it('truncates long diff output', async () => {
    const longDiff = 'x'.repeat(9000);
    mockOps.diff.mockReturnValue({
      staged: longDiff,
      unstaged: '',
    } satisfies GitDiffResult);

    const tool = createRepoTool(mockOps);
    const result = await tool.execute('call-4', { action: 'inspect', target: 'diff' });
    const text = resultText(result);

    expect(text).toContain('... (truncated)');
    expect(text.length).toBeLessThan(longDiff.length);
  });

  it('patches content through gitOps.applyPatch', async () => {
    const tool = createRepoTool(mockOps);
    const result = await tool.execute('call-5', {
      action: 'patch',
      file_path: 'src/foo.ts',
      content: 'new content',
    });

    expect(mockOps.applyPatch).toHaveBeenCalledWith('src/foo.ts', 'new content');
    expect(resultText(result)).toContain('Applied and staged: src/foo.ts');
  });

  it('creates branches through gitOps.createBranch', async () => {
    mockOps.createBranch.mockReturnValue('feature/new');

    const tool = createRepoTool(mockOps);
    const result = await tool.execute('call-6', {
      action: 'branch',
      name: 'feature/new',
      start_point: 'develop',
    });

    expect(mockOps.createBranch).toHaveBeenCalledWith('feature/new', 'develop');
    expect(resultText(result)).toContain('Created and checked out branch: feature/new');
  });

  it('commits through gitOps.commit', async () => {
    mockOps.commit.mockReturnValue({
      hash: 'abc1234',
      message: 'Fix bug',
      filesChanged: 2,
    } satisfies GitCommitResult);

    const tool = createRepoTool(mockOps);
    const result = await tool.execute('call-7', {
      action: 'commit',
      message: 'Fix bug',
      intent: 'fix bug',
      scope: 'core',
    });

    expect(mockOps.commit).toHaveBeenCalledWith('Fix bug', 'fix bug', 'core');
    expect(resultText(result)).toContain('Committed abc1234: Fix bug (2 files changed)');
  });

  it('publishes through gitOps.openPR', async () => {
    mockOps.openPR.mockReturnValue('https://github.com/owner/repo/pull/42');

    const tool = createRepoTool(mockOps);
    const result = await tool.execute('call-8', {
      action: 'publish',
      title: 'Title',
      body: 'Body',
      base: 'main',
    });

    expect(mockOps.openPR).toHaveBeenCalledWith('Title', 'Body', 'main');
    expect(resultText(result)).toContain('PR created: https://github.com/owner/repo/pull/42');
  });

  it('fails closed on unsupported action', async () => {
    const tool = createRepoTool(mockOps);
    const result = await tool.execute('call-9', { action: 'unknown' });

    expect(resultText(result)).toContain('repo failed');
    expect(resultText(result)).toContain('Supported actions');
    expect(result.details?.isError).toBe(true);
  });

  it('returns canonical errors from delegated operations', async () => {
    mockOps.commit.mockRejectedValueOnce(new Error('commit failed'));

    const tool = createRepoTool(mockOps);
    const result = await tool.execute('call-10', {
      action: 'commit',
      message: 'Fix bug',
      intent: 'fix bug',
    });

    expect(resultText(result)).toContain('repo failed');
    expect(resultText(result)).toContain('commit failed');
    expect(result.details?.isError).toBe(true);
  });
});
