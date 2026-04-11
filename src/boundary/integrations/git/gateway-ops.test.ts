import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GatewayGitOps } from './gateway-ops.js';

describe('GatewayGitOps', () => {
  let gitOps: any;
  let ops: GatewayGitOps;

  beforeEach(() => {
    gitOps = {
      status: vi.fn(),
      diff: vi.fn(),
      createBranch: vi.fn(),
      applyPatch: vi.fn(),
      commit: vi.fn(),
      openPR: vi.fn(),
    };
    ops = new GatewayGitOps(gitOps);
  });

  it('delegates status and diff', async () => {
    gitOps.status.mockResolvedValue({ branch: 'main', ahead: 0, behind: 0, staged: [], modified: [], untracked: [] });
    gitOps.diff.mockResolvedValue({ staged: '', unstaged: '' });

    await expect(ops.status()).resolves.toMatchObject({ branch: 'main' });
    await expect(ops.diff({ staged: false })).resolves.toEqual({ staged: '', unstaged: '' });
    expect(gitOps.diff).toHaveBeenCalledWith({ staged: false });
  });

  it('delegates write operations', async () => {
    gitOps.createBranch.mockResolvedValue('feature/x');
    gitOps.commit.mockResolvedValue({ hash: 'abc', message: 'm', filesChanged: 1 });
    gitOps.openPR.mockResolvedValue('https://example/pr/1');

    await expect(ops.createBranch('feature/x')).resolves.toBe('feature/x');
    await expect(ops.applyPatch('src/a.ts', 'a')).resolves.toBeUndefined();
    await expect(ops.commit('m', 'intent')).resolves.toMatchObject({ hash: 'abc' });
    await expect(ops.openPR('t', 'b')).resolves.toBe('https://example/pr/1');
  });
});
