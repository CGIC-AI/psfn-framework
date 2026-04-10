import { describe, expect, it, vi } from 'vitest';
import type { VaultOperations } from './ops.js';
import {
  createVaultDailyTool,
  createVaultReadTool,
  createVaultSearchTool,
  createVaultWriteTool,
} from './tools.js';

function createMockOps(): VaultOperations & {
  write: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  daily: ReturnType<typeof vi.fn>;
} {
  return {
    write: vi.fn(),
    read: vi.fn(),
    search: vi.fn(),
    daily: vi.fn(),
  };
}

function extractText(result: { content: Array<{ text: string }> }): string {
  return result.content[0]?.text ?? '';
}

describe('vault tools', () => {
  it('reads a note through vault_read and truncates long content', async () => {
    const ops = createMockOps();
    ops.read
      .mockResolvedValueOnce({ name: 'My Note', content: '# Hello\nWorld' })
      .mockResolvedValueOnce({ name: 'Long', content: 'x'.repeat(15_000) });
    const tool = createVaultReadTool(ops);

    const result = await tool.execute('call-read', { name: 'My Note' });
    const truncated = await tool.execute('call-read-long', { name: 'Long' });

    expect(extractText(result)).toContain('=== My Note ===');
    expect(extractText(result)).toContain('# Hello\nWorld');
    expect(extractText(truncated)).toContain('... (truncated)');
  });

  it('writes notes through vault_write', async () => {
    const ops = createMockOps();
    ops.write.mockResolvedValue({ name: 'Entry', folder: 'Journal/', mode: 'create' });
    const tool = createVaultWriteTool(ops);

    const result = await tool.execute('call-write', {
      name: 'Entry',
      content: 'Content',
      folder: 'Journal/',
    });

    expect(extractText(result)).toContain('created');
    expect(extractText(result)).toContain('Journal/Entry');
    expect(ops.write).toHaveBeenCalledWith('Entry', 'Content', {
      folder: 'Journal/',
      mode: undefined,
    });
  });

  it('formats search results through vault_search', async () => {
    const ops = createMockOps();
    ops.search.mockResolvedValue({
      query: 'test',
      results: [
        { path: 'a.md', snippet: 'some text' },
        { path: 'b.md' },
      ],
    });
    const tool = createVaultSearchTool(ops);

    const result = await tool.execute('call-search', { query: 'test', limit: 5 });

    expect(ops.search).toHaveBeenCalledWith('test', 5);
    expect(extractText(result)).toContain('2 results');
    expect(extractText(result)).toContain('1. a.md');
    expect(extractText(result)).toContain('some text');
    expect(extractText(result)).toContain('2. b.md');
  });

  it('reads and appends daily notes through vault_daily', async () => {
    const ops = createMockOps();
    ops.daily
      .mockResolvedValueOnce({ date: '2026-03-02', content: 'Today stuff', mode: 'read' })
      .mockResolvedValueOnce({ date: '2026-03-02', mode: 'append' });
    const tool = createVaultDailyTool(ops);

    const readResult = await tool.execute('call-daily-read', {});
    const appendResult = await tool.execute('call-daily-append', { content: 'New thought' });

    expect(extractText(readResult)).toContain('Daily Note (2026-03-02)');
    expect(extractText(readResult)).toContain('Today stuff');
    expect(extractText(appendResult)).toContain('Appended to daily note');
    expect(ops.daily).toHaveBeenLastCalledWith({ content: 'New thought' });
  });

  it('returns action-specific failures from the split tools', async () => {
    const ops = createMockOps();
    ops.write.mockRejectedValue(new Error('Obsidian desktop app is not running'));
    const result = await createVaultWriteTool(ops).execute('call-write-error', {
      name: 'Note',
      content: 'x',
    });

    expect(extractText(result)).toContain('vault_write failed: Obsidian desktop app is not running');
    expect(result.details.isError).toBe(true);
  });
});
