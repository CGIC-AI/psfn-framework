import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitOps, type GitOpsConfig } from './ops.js';
import { REPO_ALLOWED_PATHS } from '../security/policy-constants.js';

// Mock child_process and fs
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { writeFileSync, appendFileSync, mkdirSync, readFileSync } from 'node:fs';

const mockedExecSync = vi.mocked(execSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedAppendFileSync = vi.mocked(appendFileSync);
const mockedReadFileSync = vi.mocked(readFileSync);

function createGitOps(overrides?: Partial<GitOpsConfig>): GitOps {
  return new GitOps({
    repoRoot: '/repo',
    allowedPaths: [...REPO_ALLOWED_PATHS],
    protectedBranches: ['main', 'master'],
    auditLogPath: 'data/repo-audit.jsonl',
    auditRotation: {
      maxSizeBytes: 10 * 1024 * 1024,
      maxAgeMs: 30 * 24 * 60 * 60 * 1000,
      maxCount: 50_000,
    },
    execTimeoutMs: 30_000,
    ...overrides,
  });
}

function auditLine(timestamp: string, operation: string): string {
  return JSON.stringify({ timestamp, operation, args: {} });
}

describe('GitOps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedReadFileSync.mockReturnValue('');
  });

  // ── status() ──

  describe('status', () => {
    it('parses branch name from porcelain v2 output', () => {
      mockedExecSync.mockReturnValue(
        '# branch.oid abc123\n# branch.head feature/test\n# branch.ab +2 -1\n',
      );
      const ops = createGitOps();
      const result = ops.status();

      expect(result.branch).toBe('feature/test');
      expect(result.ahead).toBe(2);
      expect(result.behind).toBe(1);
    });

    it('parses staged files', () => {
      mockedExecSync.mockReturnValue(
        '# branch.head main\n1 M. N... 100644 100644 100644 abc def\tsrc/foo.ts\n',
      );
      const ops = createGitOps();
      const result = ops.status();

      expect(result.staged).toContain('src/foo.ts');
      expect(result.modified).toEqual([]);
    });

    it('parses modified (unstaged) files', () => {
      mockedExecSync.mockReturnValue(
        '# branch.head main\n1 .M N... 100644 100644 100644 abc def\tsrc/bar.ts\n',
      );
      const ops = createGitOps();
      const result = ops.status();

      expect(result.staged).toEqual([]);
      expect(result.modified).toContain('src/bar.ts');
    });

    it('parses untracked files', () => {
      mockedExecSync.mockReturnValue(
        '# branch.head main\n? src/new-file.ts\n',
      );
      const ops = createGitOps();
      const result = ops.status();

      expect(result.untracked).toEqual(['src/new-file.ts']);
    });

    it('handles empty output', () => {
      mockedExecSync.mockReturnValue('# branch.head main\n');
      const ops = createGitOps();
      const result = ops.status();

      expect(result.branch).toBe('main');
      expect(result.ahead).toBe(0);
      expect(result.behind).toBe(0);
      expect(result.staged).toEqual([]);
      expect(result.modified).toEqual([]);
      expect(result.untracked).toEqual([]);
    });
  });

  // ── diff() ──

  describe('diff', () => {
    it('returns staged and unstaged diffs', () => {
      mockedExecSync
        .mockReturnValueOnce('staged diff content')
        .mockReturnValueOnce('unstaged diff content');
      const ops = createGitOps();
      const result = ops.diff();

      expect(result.staged).toBe('staged diff content');
      expect(result.unstaged).toBe('unstaged diff content');
    });

    it('skips staged diff when staged is false', () => {
      mockedExecSync.mockReturnValueOnce('unstaged only');
      const ops = createGitOps();
      const result = ops.diff({ staged: false });

      expect(result.staged).toBe('');
      expect(result.unstaged).toBe('unstaged only');
      expect(mockedExecSync).toHaveBeenCalledTimes(1);
    });
  });

  // ── currentBranch() ──

  describe('currentBranch', () => {
    it('returns trimmed branch name', () => {
      mockedExecSync.mockReturnValue('feature/xyz\n');
      const ops = createGitOps();
      expect(ops.currentBranch()).toBe('feature/xyz');
    });
  });

  // ── isProtectedBranch() ──

  describe('isProtectedBranch', () => {
    it('returns true for main', () => {
      mockedExecSync.mockReturnValue('main\n');
      const ops = createGitOps();
      expect(ops.isProtectedBranch('main')).toBe(true);
    });

    it('returns true for master', () => {
      const ops = createGitOps();
      expect(ops.isProtectedBranch('master')).toBe(true);
    });

    it('returns false for feature branches', () => {
      const ops = createGitOps();
      expect(ops.isProtectedBranch('feature/test')).toBe(false);
    });

    it('uses currentBranch when no arg provided', () => {
      mockedExecSync.mockReturnValue('main\n');
      const ops = createGitOps();
      expect(ops.isProtectedBranch()).toBe(true);
    });
  });

  // ── validatePath() ──

  describe('validatePath', () => {
    it('allows paths in src/', () => {
      const ops = createGitOps();
      expect(() => ops.validatePath('src/foo.ts')).not.toThrow();
    });

    it('allows paths in docs/', () => {
      const ops = createGitOps();
      expect(() => ops.validatePath('docs/README.md')).not.toThrow();
    });

    it('allows paths in purrsephone/', () => {
      const ops = createGitOps();
      expect(() => ops.validatePath('purrsephone/x.ts')).not.toThrow();
    });

    it('blocks path traversal with ../', () => {
      const ops = createGitOps();
      expect(() => ops.validatePath('../etc/passwd')).toThrow('Path traversal blocked');
    });

    it('blocks paths outside allowed directories', () => {
      const ops = createGitOps();
      expect(() => ops.validatePath('config/secrets.json')).toThrow('not in allowed directories');
    });

    it('blocks paths outside repo root', () => {
      const ops = createGitOps();
      expect(() => ops.validatePath('/etc/passwd')).toThrow();
    });
  });

  // ── assertNotProtected() ──

  describe('assertNotProtected', () => {
    it('throws on protected branch main', () => {
      mockedExecSync.mockReturnValue('main\n');
      const ops = createGitOps();
      expect(() => ops.assertNotProtected()).toThrow('protected branch');
    });

    it('does not throw on feature branch', () => {
      mockedExecSync.mockReturnValue('feature/test\n');
      const ops = createGitOps();
      expect(() => ops.assertNotProtected()).not.toThrow();
    });
  });

  // ── createBranch() ──

  describe('createBranch', () => {
    it('creates branch with valid name', () => {
      mockedExecSync.mockReturnValue('');
      const ops = createGitOps();
      const name = ops.createBranch('feature/new-thing');
      expect(name).toBe('feature/new-thing');
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('git checkout -b'),
        expect.any(Object),
      );
    });

    it('validates branch name characters', () => {
      const ops = createGitOps();
      expect(() => ops.createBranch('bad name with spaces')).toThrow('Invalid branch name');
    });

    it('blocks protected branch names', () => {
      const ops = createGitOps();
      expect(() => ops.createBranch('main')).toThrow('protected name');
    });

    it('creates branch from start point', () => {
      mockedExecSync.mockReturnValue('');
      const ops = createGitOps();
      ops.createBranch('feature/x', 'develop');
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('develop'),
        expect.any(Object),
      );
    });

    it('writes audit log', () => {
      mockedExecSync.mockReturnValue('');
      const ops = createGitOps();
      ops.createBranch('feature/audit-test');
      expect(mockedAppendFileSync).toHaveBeenCalled();
      const auditData = mockedAppendFileSync.mock.calls[0][1] as string;
      expect(auditData).toContain('createBranch');
    });
  });

  // ── applyPatch() ──

  describe('applyPatch', () => {
    it('writes file and stages it', () => {
      // First call: currentBranch (for assertNotProtected)
      // Second call: git add
      mockedExecSync
        .mockReturnValueOnce('feature/x\n')
        .mockReturnValueOnce('');
      const ops = createGitOps();
      ops.applyPatch('src/new.ts', 'console.log("hello");');

      expect(mockedWriteFileSync).toHaveBeenCalledWith(
        '/repo/src/new.ts',
        'console.log("hello");',
        'utf-8',
      );
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('git add'),
        expect.any(Object),
      );
    });

    it('validates path before writing', () => {
      const ops = createGitOps();
      expect(() => ops.applyPatch('../etc/passwd', 'hack')).toThrow('Path traversal blocked');
      expect(mockedWriteFileSync).not.toHaveBeenCalled();
    });

    it('blocks on protected branch', () => {
      mockedExecSync.mockReturnValue('main\n');
      const ops = createGitOps();
      expect(() => ops.applyPatch('src/foo.ts', 'content')).toThrow('protected branch');
    });
  });

  // ── commit() ──

  describe('commit', () => {
    it('formats message with intent and agent metadata', () => {
      mockedExecSync
        .mockReturnValueOnce('feature/x\n')  // currentBranch for assertNotProtected
        .mockReturnValueOnce('')              // git commit
        .mockReturnValueOnce('abc1234\n')     // git rev-parse
        .mockReturnValueOnce(' 3 files changed, 45 insertions(+)\n');  // git diff --stat

      const ops = createGitOps();
      const result = ops.commit('Add feature', 'add feature', 'module');

      expect(result.hash).toBe('abc1234');
      expect(result.filesChanged).toBe(3);
      expect(result.message).toBe('Add feature');

      const commitCall = mockedExecSync.mock.calls[1][0] as string;
      expect(commitCall).toContain('[Intent] add feature');
      expect(commitCall).toContain('[Scope] module');
      expect(commitCall).toContain('[Agent] Purrsephone');
    });

    it('blocks on protected branch', () => {
      mockedExecSync.mockReturnValue('main\n');
      const ops = createGitOps();
      expect(() => ops.commit('msg', 'intent')).toThrow('protected branch');
    });
  });

  // ── openPR() ──

  describe('openPR', () => {
    it('calls gh pr create and returns URL', () => {
      mockedExecSync.mockReturnValue('https://github.com/owner/repo/pull/42\n');
      const ops = createGitOps();
      const url = ops.openPR('Fix bug', 'Bug fix description');

      expect(url).toBe('https://github.com/owner/repo/pull/42');
      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('gh pr create'),
        expect.any(Object),
      );
    });

    it('includes base branch when specified', () => {
      mockedExecSync.mockReturnValue('https://github.com/owner/repo/pull/43\n');
      const ops = createGitOps();
      ops.openPR('Title', 'Body', 'develop');

      expect(mockedExecSync).toHaveBeenCalledWith(
        expect.stringContaining('--base'),
        expect.any(Object),
      );
    });

    it('throws and audits on failure', () => {
      mockedExecSync.mockImplementation(() => {
        throw new Error('gh: not authenticated');
      });
      const ops = createGitOps();
      expect(() => ops.openPR('Title', 'Body')).toThrow('Failed to create PR');
      expect(mockedAppendFileSync).toHaveBeenCalled();
      const auditData = mockedAppendFileSync.mock.calls[0][1] as string;
      expect(auditData).toContain('"error"');
    });
  });

  // ── Audit logging ──

  describe('audit logging', () => {
    it('appends JSONL entries for write operations', () => {
      mockedExecSync.mockReturnValue('');
      const ops = createGitOps();
      ops.createBranch('feature/audit');

      expect(mockedAppendFileSync).toHaveBeenCalledTimes(1);
      const [path, data] = mockedAppendFileSync.mock.calls[0] as [string, string];
      expect(path).toContain('repo-audit.jsonl');
      const entry = JSON.parse(data.trim());
      expect(entry.operation).toBe('createBranch');
      expect(entry.timestamp).toBeTruthy();
    });

    it('prunes oldest entries when maxCount is exceeded', () => {
      mockedExecSync.mockReturnValue('');
      mockedReadFileSync.mockReturnValue([
        auditLine('2026-01-01T00:00:00.000Z', 'one'),
        auditLine('2026-01-01T00:01:00.000Z', 'two'),
        auditLine('2026-01-01T00:02:00.000Z', 'three'),
      ].join('\n') + '\n');

      const ops = createGitOps({
        auditRotation: {
          maxCount: 2,
          maxAgeMs: 365 * 24 * 60 * 60 * 1000,
          maxSizeBytes: 10_000,
        },
      });
      ops.createBranch('feature/rotation-count');

      expect(mockedWriteFileSync).toHaveBeenCalledWith(
        '/repo/data/repo-audit.jsonl',
        [
          auditLine('2026-01-01T00:01:00.000Z', 'two'),
          auditLine('2026-01-01T00:02:00.000Z', 'three'),
        ].join('\n') + '\n',
        'utf-8',
      );
    });

    it('prunes entries older than maxAgeMs', () => {
      mockedExecSync.mockReturnValue('');
      mockedReadFileSync.mockReturnValue([
        auditLine('2026-01-01T00:00:00.000Z', 'old'),
        auditLine('2026-01-01T00:10:00.000Z', 'fresh'),
      ].join('\n') + '\n');
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-01T00:10:30.000Z'));

      try {
        const ops = createGitOps({
          auditRotation: {
            maxCount: 100,
            maxAgeMs: 45_000,
            maxSizeBytes: 10_000,
          },
        });
        ops.createBranch('feature/rotation-age');
      } finally {
        nowSpy.mockRestore();
      }

      expect(mockedWriteFileSync).toHaveBeenCalledWith(
        '/repo/data/repo-audit.jsonl',
        auditLine('2026-01-01T00:10:00.000Z', 'fresh') + '\n',
        'utf-8',
      );
    });

    it('prunes oldest entries when maxSizeBytes is exceeded', () => {
      mockedExecSync.mockReturnValue('');
      mockedReadFileSync.mockReturnValue([
        JSON.stringify({
          timestamp: '2026-01-01T00:00:00.000Z',
          operation: 'small',
          args: { note: 'a'.repeat(150) },
        }),
        JSON.stringify({
          timestamp: '2026-01-01T00:01:00.000Z',
          operation: 'large',
          args: { note: 'b'.repeat(150) },
        }),
      ].join('\n') + '\n');

      const ops = createGitOps({
        auditRotation: {
          maxCount: 100,
          maxAgeMs: 365 * 24 * 60 * 60 * 1000,
          maxSizeBytes: 260,
        },
      });
      ops.createBranch('feature/rotation-size');

      expect(mockedWriteFileSync).toHaveBeenCalledTimes(1);
      const rewritten = mockedWriteFileSync.mock.calls[0][1] as string;
      expect(rewritten).toContain('"operation":"large"');
      expect(rewritten).not.toContain('"operation":"small"');
    });

    it('rejects invalid auditRotation values', () => {
      expect(() => createGitOps({
        auditRotation: { maxCount: 0, maxAgeMs: 1, maxSizeBytes: 1 },
      })).toThrow('auditRotation.maxCount');
      expect(() => createGitOps({
        auditRotation: { maxCount: 1, maxAgeMs: 0, maxSizeBytes: 1 },
      })).toThrow('auditRotation.maxAgeMs');
      expect(() => createGitOps({
        auditRotation: { maxCount: 1, maxAgeMs: 1, maxSizeBytes: 0 },
      })).toThrow('auditRotation.maxSizeBytes');
    });
  });

  // ── exec error handling ──

  describe('exec error handling', () => {
    it('wraps exec errors with context', () => {
      mockedExecSync.mockImplementation(() => {
        const err = new Error('command failed') as any;
        err.stderr = 'fatal: not a git repository';
        throw err;
      });
      const ops = createGitOps();
      expect(() => ops.currentBranch()).toThrow('Git command failed: fatal: not a git repository');
    });
  });
});
