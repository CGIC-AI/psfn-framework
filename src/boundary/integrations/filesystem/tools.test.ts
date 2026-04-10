import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceFilesystemOps } from './local-ops.js';
import { createFsListTool, createFsReadTool } from './tools.js';

function resultText(result: AgentToolResult<any>): string {
  return result.content
    .filter((content): content is TextContent => content.type === 'text')
    .map(content => content.text)
    .join('');
}

describe('filesystem read tools', () => {
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

  it('lists workspace files through fs_list', async () => {
    const tool = createFsListTool(ops);

    const listed = JSON.parse(resultText(await tool.execute('list', {
      glob: 'docs/*.txt',
      max_entries: 10,
    })));

    expect(listed).toEqual({
      action: 'list',
      glob: 'docs/*.txt',
      count: 2,
      paths: ['docs/draft.txt', 'docs/notes.txt'],
    });
  });

  it('reads text files through fs_read and truncates long content', async () => {
    writeFileSync(join(workspace, 'docs', 'long.txt'), 'x'.repeat(25_000), 'utf-8');
    const tool = createFsReadTool(ops);

    const shortRead = await tool.execute('read-short', { path: 'docs/notes.txt' });
    const longRead = await tool.execute('read-long', { path: 'docs/long.txt' });

    expect(resultText(shortRead)).toContain('alpha\nbeta\nalpha');
    expect(resultText(longRead)).toContain('... (truncated)');
    expect(resultText(longRead).length).toBeLessThan(21_000);
  });
});
