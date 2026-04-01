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

describe('filesystem tool', () => {
  let tempDir: string;
  let workspace: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'filesystem-tool-'));
    workspace = join(tempDir, 'workspace');
    mkdirSync(join(workspace, 'docs'), { recursive: true });
    writeFileSync(join(workspace, 'docs', 'notes.txt'), 'alpha\nbeta\nalpha\n', 'utf-8');
    writeFileSync(join(workspace, 'docs', 'draft.txt'), 'old text\n', 'utf-8');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('handles list, read, and search through the unified fs surface', async () => {
    const tool = createFsTool(new WorkspaceFilesystemOps(workspace));

    const listed = JSON.parse(resultText(await tool.execute('list', {
      action: 'list',
      glob: 'docs/*.txt',
    })));
    expect(listed.action).toBe('list');
    expect(listed.paths).toEqual(['docs/draft.txt', 'docs/notes.txt']);

    const read = JSON.parse(resultText(await tool.execute('read', {
      action: 'read',
      path: 'docs/notes.txt',
      max_bytes: 8,
    })));
    expect(read.truncated).toBe(true);
    expect(read.content).toContain('alpha');

    const search = JSON.parse(resultText(await tool.execute('search', {
      action: 'search',
      query: 'alpha',
      glob: 'docs/*.txt',
      max_matches: 2,
      context_lines: 1,
    })));
    expect(search.action).toBe('search');
    expect(search.match_count).toBe(2);
    expect(search.hit_limit).toBe(true);
    expect(search.matches[0]).toMatchObject({
      path: 'docs/notes.txt',
      line: 1,
    });
  });

  it('enforces write and edit guardrails', async () => {
    const tool = createFsTool(new WorkspaceFilesystemOps(workspace));

    const created = JSON.parse(resultText(await tool.execute('write-create', {
      action: 'write',
      path: 'docs/new.txt',
      content: 'created',
    })));
    expect(created.status).toBe('created');
    expect(readFileSync(join(workspace, 'docs', 'new.txt'), 'utf-8')).toBe('created');

    const deniedOverwrite = await tool.execute('write-denied', {
      action: 'write',
      path: 'docs/new.txt',
      content: 'changed',
    });
    expect((deniedOverwrite.details as any).isError).toBe(true);
    expect(resultText(deniedOverwrite)).toContain('overwrite=true');

    const edited = JSON.parse(resultText(await tool.execute('edit', {
      action: 'edit',
      path: 'docs/draft.txt',
      old_text: 'old text',
      new_text: 'updated text',
    })));
    expect(edited.replacements).toBe(1);
    expect(readFileSync(join(workspace, 'docs', 'draft.txt'), 'utf-8')).toBe('updated text\n');

    const ambiguous = await tool.execute('edit-ambiguous', {
      action: 'edit',
      path: 'docs/notes.txt',
      old_text: 'alpha',
      new_text: 'omega',
    });
    expect((ambiguous.details as any).isError).toBe(true);
    expect(resultText(ambiguous)).toContain('replaceAll=true');
  });
});
