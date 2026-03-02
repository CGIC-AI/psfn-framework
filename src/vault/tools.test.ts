import { describe, it, expect, vi } from 'vitest';
import type { VaultOperations } from './ops.js';
import {
  createVaultWriteTool,
  createVaultReadTool,
  createVaultSearchTool,
  createVaultDailyTool,
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractText(result: any): string {
  return result.content[0]?.text ?? '';
}

describe('vault_write tool', () => {
  it('creates a note and returns success', async () => {
    const ops = createMockOps();
    ops.write.mockResolvedValue({ name: 'Entry', folder: 'Journal/', mode: 'create' });
    const tool = createVaultWriteTool(ops);

    const result = await tool.execute('call-1', {
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

  it('handles append mode', async () => {
    const ops = createMockOps();
    ops.write.mockResolvedValue({ name: 'Note', mode: 'append' });
    const tool = createVaultWriteTool(ops);

    const result = await tool.execute('call-1', {
      name: 'Note',
      content: 'More text',
      mode: 'append',
    });

    expect(extractText(result)).toContain('appended');
  });

  it('returns error on failure', async () => {
    const ops = createMockOps();
    ops.write.mockRejectedValue(new Error('Obsidian desktop app is not running'));
    const tool = createVaultWriteTool(ops);

    const result = await tool.execute('call-1', { name: 'Note', content: 'x' });
    expect(extractText(result)).toContain('vault_write failed');
    expect(extractText(result)).toContain('not running');
    expect(result.details.isError).toBe(true);
  });
});

describe('vault_read tool', () => {
  it('reads and returns note content', async () => {
    const ops = createMockOps();
    ops.read.mockResolvedValue({ name: 'My Note', content: '# Hello\nWorld' });
    const tool = createVaultReadTool(ops);

    const result = await tool.execute('call-1', { name: 'My Note' });
    expect(extractText(result)).toContain('=== My Note ===');
    expect(extractText(result)).toContain('# Hello\nWorld');
  });

  it('truncates long content', async () => {
    const ops = createMockOps();
    ops.read.mockResolvedValue({ name: 'Long', content: 'x'.repeat(15000) });
    const tool = createVaultReadTool(ops);

    const result = await tool.execute('call-1', { name: 'Long' });
    expect(extractText(result)).toContain('... (truncated)');
    expect(extractText(result).length).toBeLessThan(13000);
  });

  it('returns error on failure', async () => {
    const ops = createMockOps();
    ops.read.mockRejectedValue(new Error('not found'));
    const tool = createVaultReadTool(ops);

    const result = await tool.execute('call-1', { name: 'Missing' });
    expect(extractText(result)).toContain('vault_read failed');
    expect(result.details.isError).toBe(true);
  });
});

describe('vault_search tool', () => {
  it('formats search results', async () => {
    const ops = createMockOps();
    ops.search.mockResolvedValue({
      query: 'test',
      results: [
        { path: 'a.md', snippet: 'some text' },
        { path: 'b.md' },
      ],
    });
    const tool = createVaultSearchTool(ops);

    const result = await tool.execute('call-1', { query: 'test' });
    expect(extractText(result)).toContain('2 results');
    expect(extractText(result)).toContain('1. a.md');
    expect(extractText(result)).toContain('some text');
    expect(extractText(result)).toContain('2. b.md');
  });

  it('handles no results', async () => {
    const ops = createMockOps();
    ops.search.mockResolvedValue({ query: 'nothing', results: [] });
    const tool = createVaultSearchTool(ops);

    const result = await tool.execute('call-1', { query: 'nothing' });
    expect(extractText(result)).toContain('No results');
  });

  it('passes limit parameter', async () => {
    const ops = createMockOps();
    ops.search.mockResolvedValue({ query: 'q', results: [] });
    const tool = createVaultSearchTool(ops);

    await tool.execute('call-1', { query: 'q', limit: 5 });
    expect(ops.search).toHaveBeenCalledWith('q', 5);
  });
});

describe('vault_daily tool', () => {
  it('reads daily note when no content', async () => {
    const ops = createMockOps();
    ops.daily.mockResolvedValue({ date: '2026-03-02', content: 'Today stuff', mode: 'read' });
    const tool = createVaultDailyTool(ops);

    const result = await tool.execute('call-1', {});
    expect(extractText(result)).toContain('Daily Note (2026-03-02)');
    expect(extractText(result)).toContain('Today stuff');
  });

  it('shows (empty) for empty daily note', async () => {
    const ops = createMockOps();
    ops.daily.mockResolvedValue({ date: '2026-03-02', content: '', mode: 'read' });
    const tool = createVaultDailyTool(ops);

    const result = await tool.execute('call-1', {});
    expect(extractText(result)).toContain('(empty)');
  });

  it('appends to daily note with content', async () => {
    const ops = createMockOps();
    ops.daily.mockResolvedValue({ date: '2026-03-02', mode: 'append' });
    const tool = createVaultDailyTool(ops);

    const result = await tool.execute('call-1', { content: 'New thought' });
    expect(extractText(result)).toContain('Appended to daily note');
    expect(ops.daily).toHaveBeenCalledWith({ content: 'New thought' });
  });
});
