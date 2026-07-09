import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentToolResult } from '../../pi-agent/index.js';
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
      scanned_entries: expect.any(Number),
      max_entries: 10,
      max_scanned_entries: 5000,
      truncated: false,
      scan_limit_reached: false,
      entry_limit_reached: false,
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
      count: 0,
      truncated: false,
      scan_limit_reached: false,
      entry_limit_reached: false,
    });
    expect(homeList.paths).toEqual([]);
    expect(homeList.paths).not.toContain('docs');
    expect(homeList.paths).not.toContain('downloads');
    expect(homeList.paths).not.toContain('src');
    expect(homeList.paths).not.toContain('docs/notes.txt');
    expect(homeList.paths).not.toContain('downloads/COMPANION_EXPERIENCE.md');
    expect(homeList.paths).not.toContain('src/noise.ts');
    expect(downloadsList).toEqual({
      action: 'list',
      path: 'downloads',
      glob: '*',
      count: 1,
      scanned_entries: expect.any(Number),
      max_entries: 20,
      max_scanned_entries: 5000,
      truncated: false,
      scan_limit_reached: false,
      entry_limit_reached: false,
      paths: ['downloads/COMPANION_EXPERIENCE.md'],
    });
  });

  it('reports list match caps without scan-limit metadata', async () => {
    writeFileSync(join(workspace, 'docs', 'a.txt'), 'a', 'utf-8');
    writeFileSync(join(workspace, 'docs', 'b.txt'), 'b', 'utf-8');
    writeFileSync(join(workspace, 'docs', 'c.txt'), 'c', 'utf-8');
    const tool = createFsTool(ops);

    const listed = JSON.parse(resultText(await tool.execute('list-entry-cap', {
      action: 'list',
      glob: 'docs/*.txt',
      max_entries: 2,
      max_scanned_entries: 20,
    })));

    expect(listed).toMatchObject({
      action: 'list',
      glob: 'docs/*.txt',
      count: 2,
      max_entries: 2,
      max_scanned_entries: 20,
      truncated: true,
      scan_limit_reached: false,
      entry_limit_reached: true,
    });
    expect(listed.paths).toHaveLength(2);
  });

  it('reports scan-limit truncation for sparse list globs', async () => {
    mkdirSync(join(workspace, 'deep', 'nested'), { recursive: true });
    writeFileSync(join(workspace, 'deep', 'nested', 'noise.txt'), 'noise', 'utf-8');
    const tool = createFsTool(ops);

    const listed = JSON.parse(resultText(await tool.execute('list-scan-cap', {
      action: 'list',
      glob: '**/*.needle',
      max_entries: 10,
      max_scanned_entries: 2,
    })));

    expect(listed).toMatchObject({
      action: 'list',
      glob: '**/*.needle',
      count: 0,
      scanned_entries: 2,
      max_entries: 10,
      max_scanned_entries: 2,
      truncated: true,
      scan_limit_reached: true,
      entry_limit_reached: false,
      paths: [],
    });
  });

  it('preserves list path policy checks when scan controls are present', async () => {
    const tool = createFsTool(ops);

    const result = await tool.execute('list-traversal', {
      action: 'list',
      path: '../outside',
      glob: '*.txt',
      max_scanned_entries: 2,
    });

    expect(resultText(result)).toContain('fs failed: fs list path must be a workspace-relative directory path');
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
