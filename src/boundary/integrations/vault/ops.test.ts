import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VaultOps } from './ops.js';

// Mock child_process
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
const mockExecSync = vi.mocked(execSync);

describe('VaultOps', () => {
  let ops: VaultOps;

  beforeEach(() => {
    ops = new VaultOps({ vaultName: 'TestVault' });
    mockExecSync.mockReset();
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
  });

  describe('write', () => {
    it('creates a note with correct CLI args', async () => {
      mockExecSync.mockReturnValue('');
      const result = await ops.write('My Note', 'Hello world');
      expect(result).toEqual({ name: 'My Note', folder: undefined, mode: 'create' });

      const call = mockExecSync.mock.calls[0][0] as string;
      expect(call).toContain("vault='TestVault'");
      expect(call).toContain('create');
      expect(call).toContain("name='My Note'");
      expect(call).toContain("content='Hello world'");
    });

    it('includes folder when specified', async () => {
      mockExecSync.mockReturnValue('');
      const result = await ops.write('Entry', 'Content', { folder: 'Journal/' });
      expect(result.folder).toBe('Journal/');

      const call = mockExecSync.mock.calls[0][0] as string;
      expect(call).toContain("path='Journal/'");
    });

    it('uses append mode correctly', async () => {
      mockExecSync.mockReturnValue('');
      const result = await ops.write('Existing', 'More text', { mode: 'append' });
      expect(result.mode).toBe('append');

      const call = mockExecSync.mock.calls[0][0] as string;
      expect(call).toContain('append');
      expect(call).toContain("file='Existing'");
    });

    it('uses prepend mode correctly', async () => {
      mockExecSync.mockReturnValue('');
      const result = await ops.write('Existing', 'Top text', { mode: 'prepend' });
      expect(result.mode).toBe('prepend');

      const call = mockExecSync.mock.calls[0][0] as string;
      expect(call).toContain('prepend');
    });
  });

  describe('read', () => {
    it('reads note content', async () => {
      mockExecSync.mockReturnValue('# My Note\nSome content\n');
      const result = await ops.read('My Note');
      expect(result.name).toBe('My Note');
      expect(result.content).toBe('# My Note\nSome content');

      const call = mockExecSync.mock.calls[0][0] as string;
      expect(call).toContain('read');
      expect(call).toContain("file='My Note'");
    });
  });

  describe('search', () => {
    it('parses JSON search results', async () => {
      mockExecSync.mockReturnValue(JSON.stringify([
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
      mockExecSync.mockReturnValue('Journal/entry.md\nNotes/other.md\n');
      const result = await ops.search('query');
      expect(result.results).toHaveLength(2);
      expect(result.results[0].path).toBe('Journal/entry.md');
    });

    it('includes limit in args', async () => {
      mockExecSync.mockReturnValue('[]');
      await ops.search('query', 5);
      const call = mockExecSync.mock.calls[0][0] as string;
      expect(call).toContain('limit=5');
    });
  });

  describe('daily', () => {
    it('reads daily note when no content provided', async () => {
      mockExecSync.mockReturnValue('Daily content\n');
      const result = await ops.daily();
      expect(result.mode).toBe('read');
      expect(result.content).toBe('Daily content');

      const call = mockExecSync.mock.calls[0][0] as string;
      expect(call).toContain('daily:read');
    });

    it('appends to daily note when content provided', async () => {
      mockExecSync.mockReturnValue('');
      const result = await ops.daily({ content: 'New thought' });
      expect(result.mode).toBe('append');
      expect(result.content).toBeUndefined();

      const call = mockExecSync.mock.calls[0][0] as string;
      expect(call).toContain('daily:append');
      expect(call).toContain("content='New thought'");
    });
  });

  describe('error handling', () => {
    it('maps ENOENT to "command not found" error', async () => {
      mockExecSync.mockImplementation(() => {
        const err = new Error('ENOENT') as Error & { stderr: string };
        err.stderr = 'ENOENT: obsidian not found';
        throw err;
      });
      await expect(ops.read('test')).rejects.toThrow('obsidian command not found');
    });

    it('maps IPC errors to "app not running" error', async () => {
      vi.useFakeTimers();
      mockExecSync.mockImplementation(() => {
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

    it('passes through timeout config', () => {
      const custom = new VaultOps({ vaultName: 'V', timeoutMs: 5000 });
      mockExecSync.mockReturnValue('');
      custom.read('test');
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ timeout: 5000 }),
      );
    });

    it('escapes shell-sensitive characters in content', async () => {
      mockExecSync.mockReturnValue('');
      await ops.write('Note', "Hello 'world' & \"stuff\"");
      const call = mockExecSync.mock.calls[0][0] as string;
      // Single quotes should be properly escaped
      expect(call).toContain("'Hello '\\''world'\\'' & \"stuff\"'");
    });
  });
});
