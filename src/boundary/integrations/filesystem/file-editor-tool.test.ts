import { fromAny } from '@total-typescript/shoehorn';
import { describe, expect, it, vi } from 'vitest';
import { createFileEditorTool } from './file-editor-tool.js';
import type { FilesystemOperations } from './ops.js';

function createMockOps(): FilesystemOperations {
  return {
    list: vi.fn(async () => ({
      paths: [],
      scannedEntries: 0,
      maxEntries: 200,
      maxScannedEntries: 5000,
      truncated: false,
      scanLimitReached: false,
      entryLimitReached: false,
    })),
    read: vi.fn(async () => ({
      content: 'hello world\n',
      offsetBytes: 0,
      nextOffsetBytes: null,
      eof: true,
      truncated: false,
    })),
    search: vi.fn(async () => ({
      query: '',
      glob: '**/*',
      mode: 'literal' as const,
      scannedFiles: 0,
      hitLimit: false,
      truncatedFiles: [],
      matches: [],
    })),
    write: vi.fn(async ({ path, content }) => ({
      path,
      status: 'created' as const,
      bytesWritten: Buffer.byteLength(content),
    })),
    edit: vi.fn(async ({ path }) => ({
      path,
      replacements: 1,
    })),
  };
}

describe('createFileEditorTool', () => {
  it('reads bounded pages, marks truncated reads as partial results, and enforces the byte cap', async () => {
    const ops = createMockOps();
    vi.mocked(ops.read).mockResolvedValueOnce({
      content: 'chunk-0',
      offsetBytes: 0,
      nextOffsetBytes: 7,
      eof: false,
      truncated: true,
    });

    const tool = createFileEditorTool(ops, { defaultMaxBytes: 20_000 });
    const result = await tool.execute('call-read', {
      action: 'read',
      path: 'notes/plan.md',
      offset_bytes: 0,
    });

    expect(ops.read).toHaveBeenCalledWith('notes/plan.md', {
      maxBytes: 20_000,
      offsetBytes: 0,
    });
    expect(fromAny(result.details).partialResult).toBe(true);
    expect(fromAny(result.content[0]).text).toContain('"next_offset_bytes": 7');
    expect(fromAny(result.content[0]).text).toContain('"next_action"');

    const overCap = await tool.execute('call-read-over', {
      action: 'read',
      path: 'notes/plan.md',
      max_bytes: 250_000,
    });
    expect(fromAny(overCap.details).isError).toBe(true);
    expect(fromAny(overCap.content[0]).text).toContain('max_bytes must be a safe integer');
    expect(() => createFileEditorTool(ops, { defaultMaxBytes: 250_000 })).toThrow('fsReadMaxBytes');
  });

  it('writes and edits workspace files with explicit overwrite and replace_all flags', async () => {
    const ops = createMockOps();
    const tool = createFileEditorTool(ops);

    const writeResult = await tool.execute('call-write', {
      action: 'write',
      path: 'notes/todo.md',
      content: 'alpha\nbeta\n',
      overwrite: true,
    });
    expect(ops.write).toHaveBeenCalledWith({
      path: 'notes/todo.md',
      content: 'alpha\nbeta\n',
      overwrite: true,
    });
    expect(fromAny(writeResult.details).isError).toBeUndefined();
    expect(fromAny(writeResult.content[0]).text).toContain('"status": "created"');

    const editResult = await tool.execute('call-edit', {
      action: 'edit',
      path: 'notes/todo.md',
      old_text: 'alpha',
      new_text: 'gamma',
      replace_all: true,
    });
    expect(ops.edit).toHaveBeenCalledWith({
      path: 'notes/todo.md',
      oldText: 'alpha',
      newText: 'gamma',
      replaceAll: true,
    });
    expect(fromAny(editResult.content[0]).text).toContain('"replacements": 1');
  });

  it('refuses journal paths and retired list/search actions fail-closed', async () => {
    const ops = createMockOps();
    const tool = createFileEditorTool(ops);

    for (const action of ['read', 'write', 'edit'] as const) {
      const blocked = await tool.execute(`call-journal-${action}`, {
        action,
        path: 'journal/reflection.md',
        content: 'nope',
        old_text: 'a',
        new_text: 'b',
      });
      expect(fromAny(blocked.details).isError).toBe(true);
      expect(fromAny(blocked.content[0]).text).toContain('journal');
    }

    const listDenied = await tool.execute('call-list', { action: 'list', path: '.' });
    expect(fromAny(listDenied.details).isError).toBe(true);
    expect(fromAny(listDenied.content[0]).text).toContain('Supported actions: read, write, edit');
    expect(ops.list).not.toHaveBeenCalled();
    expect(ops.search).not.toHaveBeenCalled();
  });
});
