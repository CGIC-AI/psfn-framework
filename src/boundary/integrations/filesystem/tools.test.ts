import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceFilesystemOps } from './local-ops.js';
import { createFsTool } from './tools.js';

function resultText(result: AgentToolResult<any>): string {
  return result.content
    .filter((content): content is TextContent => content.type === 'text')
    .map(content => content.text)
    .join('');
}

describe('fs tool', () => {
  let tempDir: string;
  let workspace: string;
  let ops: WorkspaceFilesystemOps;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'filesystem-tool-'));
    workspace = join(tempDir, 'workspace');
    mkdirSync(join(workspace, 'docs'), { recursive: true });
    writeFileSync(join(workspace, 'docs', 'notes.txt'), 'alpha\nbeta\nalpha\n', 'utf-8');
    writeFileSync(join(workspace, 'docs', 'draft.txt'), 'old text\n', 'utf-8');
    ops = new WorkspaceFilesystemOps(workspace);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('lists, reads, and searches through the unified fs surface', async () => {
    writeFileSync(join(workspace, 'docs', 'long.txt'), 'x'.repeat(25_000), 'utf-8');
    const tool = createFsTool(ops);

    const listed = JSON.parse(resultText(await tool.execute('list', {
      action: 'list',
      glob: 'docs/*.txt',
      max_entries: 10,
    })));
    const shortRead = JSON.parse(resultText(await tool.execute('read-short', {
      action: 'read',
      path: 'docs/notes.txt',
    })));
    const longRead = JSON.parse(resultText(await tool.execute('read-long', {
      action: 'read',
      path: 'docs/long.txt',
    })));
    const searched = JSON.parse(resultText(await tool.execute('search', {
      action: 'search',
      glob: 'docs/*.txt',
      query: 'alpha',
      max_matches: 10,
    })));

    expect(listed).toEqual({
      action: 'list',
      glob: 'docs/*.txt',
      count: 3,
      paths: ['docs/draft.txt', 'docs/long.txt', 'docs/notes.txt'],
    });
    expect(shortRead).toEqual({
      action: 'read',
      path: 'docs/notes.txt',
      truncated: false,
      content: 'alpha\nbeta\nalpha\n',
    });
    expect(longRead.action).toBe('read');
    expect(longRead.path).toBe('docs/long.txt');
    expect(longRead.truncated).toBe(true);
    expect(String(longRead.content)).toHaveLength(20_000);
    expect(searched).toMatchObject({
      action: 'search',
      query: 'alpha',
      match_count: 2,
      hit_limit: false,
    });
    expect(searched.matches).toEqual([
      expect.objectContaining({ path: 'docs/notes.txt', line: 1, column: 1 }),
      expect.objectContaining({ path: 'docs/notes.txt', line: 3, column: 1 }),
    ]);
  });

  it('writes new files and edits existing files through the unified fs surface', async () => {
    const tool = createFsTool(ops);

    const writeResult = JSON.parse(resultText(await tool.execute('write', {
      action: 'write',
      path: 'docs/new.txt',
      content: 'hello\n',
    })));
    const editResult = JSON.parse(resultText(await tool.execute('edit', {
      action: 'edit',
      path: 'docs/draft.txt',
      old_text: 'old text',
      new_text: 'new text',
    })));

    expect(writeResult).toEqual({
      action: 'write',
      path: 'docs/new.txt',
      status: 'created',
      bytes_written: 6,
    });
    expect(editResult).toEqual({
      action: 'edit',
      path: 'docs/draft.txt',
      replacements: 1,
    });
    expect(readFileSync(join(workspace, 'docs', 'new.txt'), 'utf-8')).toBe('hello\n');
    expect(readFileSync(join(workspace, 'docs', 'draft.txt'), 'utf-8')).toBe('new text\n');
  });
});
