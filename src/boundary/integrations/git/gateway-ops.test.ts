import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GatewayGitOps } from './gateway-ops.js';

describe('GatewayGitOps', () => {
  let gateway: any;
  let ops: GatewayGitOps;

  beforeEach(() => {
    gateway = {
      gitStatus: vi.fn(),
      gitDiff: vi.fn(),
      gitCreateBranch: vi.fn(),
      gitApplyPatch: vi.fn(),
      gitCommit: vi.fn(),
      gitOpenPR: vi.fn(),
    };
    ops = new GatewayGitOps(gateway);
  });

  it('delegates status and diff', async () => {
    gateway.gitStatus.mockResolvedValue({ branch: 'main', ahead: 0, behind: 0, staged: [], modified: [], untracked: [] });
    gateway.gitDiff.mockResolvedValue({ staged: '', unstaged: '' });

    await expect(ops.status()).resolves.toMatchObject({ branch: 'main' });
    await expect(ops.diff({ staged: false })).resolves.toEqual({ staged: '', unstaged: '' });
    expect(gateway.gitDiff).toHaveBeenCalledWith({ staged: false });
  });

  it('delegates write operations', async () => {
    gateway.gitCreateBranch.mockResolvedValue('feature/x');
    gateway.gitCommit.mockResolvedValue({ hash: 'abc', message: 'm', filesChanged: 1 });
    gateway.gitOpenPR.mockResolvedValue('https://example/pr/1');

    await expect(ops.createBranch('feature/x')).resolves.toBe('feature/x');
    await expect(ops.applyPatch('src/a.ts', 'a')).resolves.toBeUndefined();
    await expect(ops.commit('m', 'intent')).resolves.toMatchObject({ hash: 'abc' });
    await expect(ops.openPR('t', 'b')).resolves.toBe('https://example/pr/1');
  });
});
