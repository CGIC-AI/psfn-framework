import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JournalOps } from './ops.js';
import { createJournalTool } from './tools.js';

function resultText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map(entry => entry.text).join('');
}

describe('journal tool', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'journal-tool-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes, appends, lists, reads, and searches markdown notes', async () => {
    const tool = createJournalTool(new JournalOps(root));

    const written = await tool.execute('write-1', {
      action: 'write',
      title: 'Mood Repair Notes',
      content: 'A durable reflection about the repair.',
    });
    expect(resultText(written as any)).toContain('mood-repair-notes.md');

    await tool.execute('append-1', {
      action: 'append',
      path: 'mood-repair-notes',
      content: 'Second line with specific context.',
    });

    const listed = await tool.execute('list-1', { action: 'list' });
    expect(resultText(listed as any)).toContain('- mood-repair-notes.md');

    const read = await tool.execute('read-1', { action: 'read', path: 'mood-repair-notes.md' });
    expect(resultText(read as any)).toContain('Second line with specific context.');

    const searched = await tool.execute('search-1', { action: 'search', query: 'specific context' });
    expect(resultText(searched as any)).toContain('mood-repair-notes.md');
    expect(readFileSync(join(root, 'mood-repair-notes.md'), 'utf8')).toContain('durable reflection');
  });

  it('rejects traversal outside the journal root', async () => {
    const tool = createJournalTool(new JournalOps(root));
    const result = await tool.execute('write-escape', {
      action: 'write',
      path: '../escape',
      content: 'bad',
    });

    expect((result.details as any).isError).toBe(true);
    expect(resultText(result as any)).toContain('must stay inside the journal root');
  });
});
