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

  it('retargets broad searches to working folders and skips directories', async () => {
    mkdirSync(join(workspace, 'downloads'), { recursive: true });
    mkdirSync(join(workspace, 'docs', 'nested'), { recursive: true });
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(join(workspace, 'downloads', 'COMPANION_EXPERIENCE.md'), 'needle in downloads\n', 'utf-8');
    writeFileSync(join(workspace, 'src', 'noise.ts'), 'needle outside working folders\n', 'utf-8');
    const tool = createFsTool(ops);

    const broadSearch = JSON.parse(resultText(await tool.execute('search-broad', {
      action: 'search',
      glob: '**/*',
      query: 'needle',
      max_matches: 10,
    })));
    const directorySearch = JSON.parse(resultText(await tool.execute('search-directory-glob', {
      action: 'search',
      glob: 'docs/*',
      query: 'alpha',
      max_matches: 10,
    })));

    expect(broadSearch.glob).not.toBe('**/*');
    expect(broadSearch.matches).toEqual([
      expect.objectContaining({ path: 'downloads/COMPANION_EXPERIENCE.md' }),
    ]);
    expect(directorySearch.isError).toBeUndefined();
    expect(directorySearch.matches).toEqual([
      expect.objectContaining({ path: 'docs/notes.txt' }),
      expect.objectContaining({ path: 'docs/notes.txt' }),
    ]);
  });

  it('defaults list to a shallow personal-root view and honors list path', async () => {
    mkdirSync(join(workspace, 'downloads'), { recursive: true });
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(join(workspace, 'downloads', 'COMPANION_EXPERIENCE.md'), 'personal note\n', 'utf-8');
    writeFileSync(join(workspace, 'src', 'noise.ts'), 'repo-shaped noise\n', 'utf-8');
    const tool = createFsTool(ops);

    const homeList = JSON.parse(resultText(await tool.execute('list-home', {
      action: 'list',
      glob: '**/*',
      max_entries: 20,
    })));
    const downloadsList = JSON.parse(resultText(await tool.execute('list-downloads', {
      action: 'list',
      path: 'downloads',
      max_entries: 20,
    })));

    expect(homeList).toMatchObject({
      action: 'list',
      glob: '*',
    });
    expect(homeList.paths).toEqual(expect.arrayContaining(['docs', 'downloads', 'src']));
    expect(homeList.paths).not.toContain('docs/notes.txt');
    expect(homeList.paths).not.toContain('downloads/COMPANION_EXPERIENCE.md');
    expect(homeList.paths).not.toContain('src/noise.ts');
    expect(downloadsList).toEqual({
      action: 'list',
      path: 'downloads',
      glob: '*',
      count: 1,
      paths: ['downloads/COMPANION_EXPERIENCE.md'],
    });
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
