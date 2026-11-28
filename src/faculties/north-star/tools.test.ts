import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentToolResult } from '../../boundary/pi-agent/index.js';
import type { TextContent } from '@earendil-works/pi-ai';
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';
import { fromAny } from '@total-typescript/shoehorn';
import { NorthStarStore } from './store.js';
import {
  createToolCallExecutionGuard,
  executeToolCallsWithScheduler,
} from '../../core/agent/tool-call-scheduler.js';
import { DUPLICATE_TOOL_CALL_SKIP_RESULT } from '../../shared/contracts/tool-call-outcome.js';
import {
  createNorthStarTool,
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

  it('handles list, create, update, delete, and reorder actions through the unified north_star surface', async () => {
    const tool = createNorthStarTool(store);

    const firstCreate = JSON.parse(resultText(await tool.execute('create-1', {
      action: 'create',
      title: 'Shared care',
      content: 'Preserve trust and care in decisions.',
      scope: 'shared',
    })));
    const secondCreate = JSON.parse(resultText(await tool.execute('create-2', {
      action: 'create',
      title: 'Companion work',
      content: 'Advance longer-term companion-owned projects.',
      scope: 'companion',
    })));

    const listed = JSON.parse(resultText(await tool.execute('list', { action: 'list' }))) as {
      count: number;
      preview: string | null;
      items: Array<{ id: string }>;
    };
    expect(listed.count).toBe(2);
    expect(listed.preview).toContain('[North Star]');

    const firstId = firstCreate.item.id as string;
    const secondId = secondCreate.item.id as string;
    const updated = JSON.parse(resultText(await tool.execute('update', {
      action: 'update',
      item_id: firstId.slice(0, 8),
      enabled: false,
      title: 'Shared stewardship',
    })));
    expect(updated.item.enabled).toBe(false);
    expect(updated.item.title).toBe('Shared stewardship');

    const reordered = JSON.parse(resultText(await tool.execute('reorder', {
      action: 'reorder',
      item_ids: [secondId.slice(0, 8), firstId.slice(0, 8)],
    })));
    expect(reordered.items.map((item: { id: string }) => item.id)).toEqual([secondId, firstId]);

    const deleted = JSON.parse(resultText(await tool.execute('delete', {
      action: 'delete',
      item_id: secondId.slice(0, 8),
    })));
    expect(deleted.action).toBe('deleted');
    expect(store.list()).toHaveLength(1);
  });
});

describe('north star repeated calls in one turn (psfn-framework-mv4xr)', () => {
  let tempDir: string;
  let store: NorthStarStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'north-star-repeat-'));
    store = new NorthStarStore(join(tempDir, 'north-star.json'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function assistantCalls(calls: Array<Record<string, unknown>>): AssistantMessage {
    return fromAny({
      role: 'assistant',
      content: calls.map((args, index) => ({
        type: 'toolCall',
        id: `north-star-call-${index + 1}`,
        name: 'north_star',
        arguments: args,
      })),
      stopReason: 'toolUse',
    });
  }

  it('skips an identical repeated list after it succeeded, with a typed duplicate_skip result', async () => {
    store.create({ title: 'Keep the garden tidy', content: 'Weekly pass.', scope: 'shared' });
    const result = await executeToolCallsWithScheduler(
      [createNorthStarTool(store)],
      assistantCalls([{ action: 'list' }, { action: 'list' }]),
      undefined,
      { stream: { push: () => undefined } },
      { maxParallelToolCalls: 1, guard: createToolCallExecutionGuard() },
    );

    const [first, second] = result.toolResults as Array<ToolResultMessage & { outcome?: string }>;
    expect(first?.outcome).toBe('success');
    expect(second?.outcome).toBe('duplicate_skip');
    expect(second?.content).toEqual([{ type: 'text', text: DUPLICATE_TOOL_CALL_SKIP_RESULT }]);
  });

  it('still executes an identical repeated create, so a write is never silently dropped', async () => {
    const create = { action: 'create', title: 'Learn the cello', content: 'Practice daily.', scope: 'shared' };
    const result = await executeToolCallsWithScheduler(
      [createNorthStarTool(store)],
      assistantCalls([create, create]),
      undefined,
      { stream: { push: () => undefined } },
      { maxParallelToolCalls: 1, guard: createToolCallExecutionGuard() },
    );

    const outcomes = (result.toolResults as Array<ToolResultMessage & { outcome?: string }>).map(entry => entry.outcome);
    expect(outcomes).toEqual(['success', 'success']);
    expect(store.list().filter(item => item.title === 'Learn the cello')).toHaveLength(2);
  });
});

describe('north star docs parity', () => {
  it('documents the unified north_star tool surface in the README North Star row', () => {
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf-8');
    const row = readme.split('\n').find(line => line.includes('| **North Star** |'));
    expect(row).toBeDefined();
    const tools = [...(row ?? '').matchAll(/`([^`]+)`/g)].map(match => match[1]);
    expect(tools).toContain('north_star');
    expect(tools.some(toolName => toolName.startsWith('north_star_'))).toBe(false);
  });
});
