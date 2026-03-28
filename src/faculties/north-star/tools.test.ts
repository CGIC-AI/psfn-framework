import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentToolResult } from '@mariozechner/pi-agent-core';
import type { TextContent } from '@mariozechner/pi-ai';
import { NorthStarStore } from './store.js';
import {
  createNorthStarCreateTool,
  createNorthStarDeleteTool,
  createNorthStarListTool,
  createNorthStarReorderTool,
  createNorthStarUpdateTool,
} from './tools.js';

function resultText(result: AgentToolResult<any>): string {
  return result.content
    .filter((content): content is TextContent => content.type === 'text')
    .map(content => content.text)
    .join('');
}

describe('north star tools', () => {
  let tempDir: string;
  let store: NorthStarStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'north-star-tools-'));
    store = new NorthStarStore(join(tempDir, 'north-star.json'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates, lists, updates, deletes, and reorders North Star items', async () => {
    const createTool = createNorthStarCreateTool(store);
    const listTool = createNorthStarListTool(store);
    const updateTool = createNorthStarUpdateTool(store);
    const deleteTool = createNorthStarDeleteTool(store);
    const reorderTool = createNorthStarReorderTool(store);

    const firstCreate = JSON.parse(resultText(await createTool.execute('create-1', {
      title: 'Shared care',
      content: 'Preserve trust and care in decisions.',
      scope: 'shared',
    })));
    const secondCreate = JSON.parse(resultText(await createTool.execute('create-2', {
      title: 'Companion work',
      content: 'Advance longer-term companion-owned projects.',
      scope: 'companion',
    })));

    const listed = JSON.parse(resultText(await listTool.execute('list', {}))) as {
      count: number;
      preview: string | null;
      items: Array<{ id: string }>;
    };
    expect(listed.count).toBe(2);
    expect(listed.preview).toContain('[North Star]');

    const firstId = firstCreate.item.id as string;
    const secondId = secondCreate.item.id as string;
    const updated = JSON.parse(resultText(await updateTool.execute('update', {
      item_id: firstId.slice(0, 8),
      enabled: false,
      title: 'Shared stewardship',
    })));
    expect(updated.item.enabled).toBe(false);
    expect(updated.item.title).toBe('Shared stewardship');

    const reordered = JSON.parse(resultText(await reorderTool.execute('reorder', {
      item_ids: [secondId.slice(0, 8), firstId.slice(0, 8)],
    })));
    expect(reordered.items.map((item: { id: string }) => item.id)).toEqual([secondId, firstId]);

    const deleted = JSON.parse(resultText(await deleteTool.execute('delete', {
      item_id: secondId.slice(0, 8),
    })));
    expect(deleted.action).toBe('deleted');
    expect(store.list()).toHaveLength(1);
  });
});

describe('north star docs parity', () => {
  it('documents the north_star_* tool surface in the README identity section', () => {
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf-8');
    const identityRow = readme.split('\n').find(line => line.includes('| **Identity** |'));
    expect(identityRow).toBeDefined();
    const tools = [...(identityRow ?? '').matchAll(/`([^`]+)`/g)].map(match => match[1]);
    expect(tools).toEqual(expect.arrayContaining([
      'north_star_list',
      'north_star_create',
      'north_star_update',
      'north_star_delete',
      'north_star_reorder',
    ]));
  });
});
