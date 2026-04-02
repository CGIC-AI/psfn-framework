import { describe, it, expect, vi } from 'vitest';
import type { VaultOperations } from './ops.js';
import { createVaultTool } from './tools.js';

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

describe('vault tool', () => {
  it('reads a note with action=read', async () => {
    const ops = createMockOps();
    ops.read.mockResolvedValue({ name: 'My Note', content: '# Hello\nWorld' });
    const tool = createVaultTool(ops);

    const result = await tool.execute('call-1', { action: 'read', name: 'My Note' });
    expect(extractText(result)).toContain('=== My Note ===');
    expect(extractText(result)).toContain('# Hello\nWorld');
  });

  it('accepts legacy vault_read action aliases', async () => {
    const ops = createMockOps();
    ops.read.mockResolvedValue({ name: 'Legacy', content: 'hello' });
    const emitLegacyAliasTelemetry = vi.fn();
    const tool = createVaultTool(ops, { emitLegacyAliasTelemetry });

    await tool.execute('call-1', { action: 'vault_read', name: 'Legacy' });
    expect(ops.read).toHaveBeenCalledWith('Legacy');
    expect(emitLegacyAliasTelemetry).toHaveBeenCalledWith({
      toolName: 'vault',
      alias: 'vault_read',
      canonicalAction: 'read',
      migrationSurface: 'vault',
    });
  });

  it('truncates long read content', async () => {
    const ops = createMockOps();
    ops.read.mockResolvedValue({ name: 'Long', content: 'x'.repeat(15_000) });
    const tool = createVaultTool(ops);

    const result = await tool.execute('call-1', { action: 'read', name: 'Long' });
    expect(extractText(result)).toContain('... (truncated)');
    expect(extractText(result).length).toBeLessThan(13_000);
  });

  it('writes a note with action=write', async () => {
    const ops = createMockOps();
    ops.write.mockResolvedValue({ name: 'Entry', folder: 'Journal/', mode: 'create' });
    const tool = createVaultTool(ops);

    const result = await tool.execute('call-1', {
      action: 'write',
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

  it('infers write when name and content are provided without action', async () => {
    const ops = createMockOps();
    ops.write.mockResolvedValue({ name: 'Note', mode: 'append' });
    const tool = createVaultTool(ops);

    const result = await tool.execute('call-1', {
      name: 'Note',
      content: 'More text',
      mode: 'append',
    });

    expect(extractText(result)).toContain('appended');
    expect(ops.write).toHaveBeenCalledWith('Note', 'More text', {
      folder: undefined,
      mode: 'append',
    });
  });

  it('formats search results', async () => {
    const ops = createMockOps();
    ops.search.mockResolvedValue({
      query: 'test',
      results: [
        { path: 'a.md', snippet: 'some text' },
        { path: 'b.md' },
      ],
    });
    const tool = createVaultTool(ops);

    const result = await tool.execute('call-1', { action: 'search', query: 'test' });
    expect(extractText(result)).toContain('2 results');
    expect(extractText(result)).toContain('1. a.md');
    expect(extractText(result)).toContain('some text');
    expect(extractText(result)).toContain('2. b.md');
  });

  it('handles empty search results', async () => {
    const ops = createMockOps();
    ops.search.mockResolvedValue({ query: 'nothing', results: [] });
    const tool = createVaultTool(ops);

    const result = await tool.execute('call-1', { action: 'search', query: 'nothing' });
    expect(extractText(result)).toContain('No results');
  });

  it('passes limit parameter to search', async () => {
    const ops = createMockOps();
    ops.search.mockResolvedValue({ query: 'q', results: [] });
    const tool = createVaultTool(ops);

    await tool.execute('call-1', { action: 'vault_search', query: 'q', limit: 5 });
    expect(ops.search).toHaveBeenCalledWith('q', 5);
  });

  it('reads daily note when content is omitted', async () => {
    const ops = createMockOps();
    ops.daily.mockResolvedValue({ date: '2026-03-02', content: 'Today stuff', mode: 'read' });
    const tool = createVaultTool(ops);

    const result = await tool.execute('call-1', { action: 'daily' });
    expect(extractText(result)).toContain('Daily Note (2026-03-02)');
    expect(extractText(result)).toContain('Today stuff');
  });

  it('shows (empty) for empty daily note', async () => {
    const ops = createMockOps();
    ops.daily.mockResolvedValue({ date: '2026-03-02', content: '', mode: 'read' });
    const tool = createVaultTool(ops);

    const result = await tool.execute('call-1', { action: 'daily' });
    expect(extractText(result)).toContain('(empty)');
  });

  it('appends to daily note with content', async () => {
    const ops = createMockOps();
    ops.daily.mockResolvedValue({ date: '2026-03-02', mode: 'append' });
    const tool = createVaultTool(ops);

    const result = await tool.execute('call-1', { content: 'New thought' });
    expect(extractText(result)).toContain('Appended to daily note');
    expect(ops.daily).toHaveBeenCalledWith({ content: 'New thought' });
  });

  it('returns action-specific failures', async () => {
    const ops = createMockOps();
    ops.write.mockRejectedValue(new Error('Obsidian desktop app is not running'));
    const tool = createVaultTool(ops);

    const result = await tool.execute('call-1', { action: 'write', name: 'Note', content: 'x' });
    expect(extractText(result)).toContain('vault failed for action=write');
    expect(extractText(result)).toContain('not running');
    expect(result.details.isError).toBe(true);
  });

  it('fails closed on ambiguous params without action', async () => {
    const ops = createMockOps();
    const tool = createVaultTool(ops);

    const result = await tool.execute('call-1', { name: 'Inbox', query: 'focus' });
    expect(extractText(result)).toContain('action is required');
    expect(result.details.isError).toBe(true);
    expect(ops.read).not.toHaveBeenCalled();
    expect(ops.search).not.toHaveBeenCalled();
  });
});
