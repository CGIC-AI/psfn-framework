import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

  it('returns explicit byte progress for paged reads', async () => {
    writeFileSync(join(root, 'large.md'), `${'🙂'.repeat(4_000)}\ntail\n`, 'utf8');
    const tool = createJournalTool(new JournalOps(root));

    const first = await tool.execute('read-1', { action: 'read', path: 'large.md' });
    const firstText = resultText(first as any);
    expect(firstText).toContain('offset_bytes: 0');
    expect(firstText).toContain('next_offset_bytes: 12000');
    expect(firstText).toContain('eof: false');
    expect(firstText).not.toContain('tail');

    const second = await tool.execute('read-2', {
      action: 'read',
      path: 'large.md',
      offset_bytes: 12_000,
    } as any);
    const secondText = resultText(second as any);
    expect(secondText).toContain('offset_bytes: 12000');
    expect(secondText).toContain('next_offset_bytes: null');
    expect(secondText).toContain('eof: true');
    expect(secondText).toContain('tail');
  });

  it('surfaces skipped oversized notes as explicit incomplete search metadata', async () => {
    writeFileSync(join(root, 'first.md'), 'needle\n', 'utf8');
    writeFileSync(join(root, 'oversized.md'), Buffer.alloc(200_001, 0x61));
    const tool = createJournalTool(new JournalOps(root));

    const result = await tool.execute('search-1', { action: 'search', query: 'needle' });

    expect((result.details as any).isError).not.toBe(true);
    expect(resultText(result as any)).toContain('Search complete: false');
    expect(resultText(result as any)).toContain('scanned 1 of 2 notes');
    expect(resultText(result as any)).toContain('Skipped oversized notes: oversized.md');
    expect(resultText(result as any)).toContain('first.md');
  });

  it('surfaces truncated list and file-count-limited search metadata', async () => {
    for (let index = 0; index < 205; index += 1) {
      writeFileSync(join(root, `note-${String(index).padStart(3, '0')}.md`), 'needle\n');
    }
    const tool = createJournalTool(new JournalOps(root));

    const listed = await tool.execute('list-1', { action: 'list' });
    const listText = resultText(listed as any);
    expect(listText).toContain('Journal notes (200 of 205)');
    expect(listText).toContain('List truncated: true');
    expect(listText).toContain('- note-199.md');
    expect(listText).not.toContain('- note-200.md');

    const searched = await tool.execute('search-1', { action: 'search', query: 'needle' });
    const searchText = resultText(searched as any);
    expect((searched.details as any).isError).not.toBe(true);
    expect(searchText).toContain('Search complete: false');
    expect(searchText).toContain('scanned 200 of 205 notes');
  });
});
