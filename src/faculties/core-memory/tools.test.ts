import { describe, expect, it, vi } from 'vitest';
import {
  createCoreMemoryAppendTool,
  createCoreMemoryReplaceTool,
  createMemoryRethinkTool,
} from './tools.js';
import type {
  CoreMemoryAppendOptions,
  CoreMemoryBlock,
  CoreMemoryLabel,
  CoreMemoryRethinkInput,
  CoreMemorySnapshot,
} from './store.js';

function resultText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map(entry => entry.text).join('');
}

function makeBlock(label: CoreMemoryLabel, overrides: Partial<CoreMemoryBlock> = {}): CoreMemoryBlock {
  return {
    label,
    content: '',
    maxChars: label === 'goals' ? 1600 : 2400,
    ...(label === 'human' ? { trustLevel: 'trusted' } : {}),
    ...overrides,
  };
}

function makeSnapshot(overrides?: Partial<CoreMemorySnapshot>): CoreMemorySnapshot {
  return {
    version: 1,
    updatedAt: '2026-03-05T00:00:00.000Z',
    blocks: {
      persona: makeBlock('persona'),
      human: makeBlock('human'),
      goals: makeBlock('goals'),
    },
    ...overrides,
  };
}

describe('core memory tools', () => {
  it('core_memory_append appends to the requested block', async () => {
    const store = {
      append: vi.fn<(
        label: CoreMemoryLabel,
        appendText: string,
        options?: CoreMemoryAppendOptions,
      ) => CoreMemoryBlock>().mockReturnValue(
        makeBlock('persona', { content: 'line one\nline two' }),
      ),
      replace: vi.fn(),
      rethink: vi.fn(),
    };
    const tool = createCoreMemoryAppendTool(store);

    const result = await tool.execute('call-1', {
      block: 'persona',
      text: '  line two  ',
    });

    expect(store.append).toHaveBeenCalledWith('persona', 'line two', { separator: undefined });
    expect(resultText(result)).toContain('Appended to persona core memory');
    expect(result.details?.isError).toBeUndefined();
  });

  it('core_memory_append rejects empty text', async () => {
    const store = {
      append: vi.fn(),
      replace: vi.fn(),
      rethink: vi.fn(),
    };
    const tool = createCoreMemoryAppendTool(store);

    const result = await tool.execute('call-2', {
      block: 'persona',
      text: '   ',
    });

    expect(resultText(result)).toContain('Error: text is required');
    expect(result.details?.isError).toBe(true);
    expect(store.append).not.toHaveBeenCalled();
  });

  it('core_memory_replace replaces one block', async () => {
    const store = {
      append: vi.fn(),
      replace: vi.fn<(
        label: CoreMemoryLabel,
        content: string,
      ) => CoreMemoryBlock>().mockReturnValue(
        makeBlock('goals', { content: 'Ship PSFN-du0t today.' }),
      ),
      rethink: vi.fn(),
    };
    const tool = createCoreMemoryReplaceTool(store);

    const result = await tool.execute('call-3', {
      block: 'goals',
      text: 'Ship PSFN-du0t today.',
    });

    expect(store.replace).toHaveBeenCalledWith('goals', 'Ship PSFN-du0t today.');
    expect(resultText(result)).toContain('Replaced goals core memory');
    expect(result.details?.isError).toBeUndefined();
  });

  it('memory_rethink rewrites all three blocks', async () => {
    const store = {
      append: vi.fn(),
      replace: vi.fn(),
      rethink: vi.fn<(input: CoreMemoryRethinkInput) => CoreMemorySnapshot>().mockReturnValue(
        makeSnapshot({
          blocks: {
            persona: makeBlock('persona', { content: 'Pragmatic and helpful.' }),
            human: makeBlock('human', { content: 'Prefers concise, technical answers.' }),
            goals: makeBlock('goals', { content: 'Complete Phase V core memory integration.' }),
          },
        }),
      ),
    };
    const tool = createMemoryRethinkTool(store);

    const result = await tool.execute('call-4', {
      persona: 'Pragmatic and helpful.',
      human: 'Prefers concise, technical answers.',
      goals: 'Complete Phase V core memory integration.',
    });

    expect(store.rethink).toHaveBeenCalledWith({
      persona: 'Pragmatic and helpful.',
      human: 'Prefers concise, technical answers.',
      goals: 'Complete Phase V core memory integration.',
    });
    expect(resultText(result)).toContain('Rewrote core memory blocks');
    expect(result.details?.isError).toBeUndefined();
  });

  it('memory_rethink returns an error payload when store throws', async () => {
    const store = {
      append: vi.fn(),
      replace: vi.fn(),
      rethink: vi.fn().mockImplementation(() => {
        throw new Error('disk full');
      }),
    };
    const tool = createMemoryRethinkTool(store);

    const result = await tool.execute('call-5', {
      persona: 'x',
      human: 'y',
      goals: 'z',
    });

    expect(resultText(result)).toContain('Error rewriting core memory');
    expect(resultText(result)).toContain('disk full');
    expect(result.details?.isError).toBe(true);
  });
});
