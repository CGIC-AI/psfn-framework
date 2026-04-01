import { describe, expect, it, vi } from 'vitest';
import {
  createOrientTool,
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

describe('orient tool', () => {
  it('appends to the requested orientation block', async () => {
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
    const tool = createOrientTool(store);

    const result = await tool.execute('call-1', {
      action: 'append',
      block: 'persona',
      text: '  line two  ',
    });

    expect(store.append).toHaveBeenCalledWith('persona', 'line two', { separator: undefined });
    expect(resultText(result)).toContain('Appended to persona orientation');
    expect(result.details?.isError).toBeUndefined();
  });

  it('rejects empty append text', async () => {
    const store = {
      append: vi.fn(),
      replace: vi.fn(),
      rethink: vi.fn(),
    };
    const tool = createOrientTool(store);

    const result = await tool.execute('call-2', {
      action: 'append',
      block: 'persona',
      text: '   ',
    });

    expect(resultText(result)).toContain('Error: text is required for action=append');
    expect(result.details?.isError).toBe(true);
    expect(store.append).not.toHaveBeenCalled();
  });

  it('replaces one orientation block', async () => {
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
    const tool = createOrientTool(store);

    const result = await tool.execute('call-3', {
      action: 'replace',
      block: 'goals',
      text: 'Ship PSFN-du0t today.',
    });

    expect(store.replace).toHaveBeenCalledWith('goals', 'Ship PSFN-du0t today.');
    expect(resultText(result)).toContain('Replaced goals orientation');
    expect(result.details?.isError).toBeUndefined();
  });

  it('reorients all three blocks at once', async () => {
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
    const tool = createOrientTool(store);

    const result = await tool.execute('call-4', {
      action: 'reorient',
      persona: 'Pragmatic and helpful.',
      human: 'Prefers concise, technical answers.',
      goals: 'Complete Phase V core memory integration.',
    });

    expect(store.rethink).toHaveBeenCalledWith({
      persona: 'Pragmatic and helpful.',
      human: 'Prefers concise, technical answers.',
      goals: 'Complete Phase V core memory integration.',
    });
    expect(resultText(result)).toContain('Reoriented active blocks');
    expect(result.details?.isError).toBeUndefined();
  });

  it('returns an error payload when orientation update fails', async () => {
    const store = {
      append: vi.fn(),
      replace: vi.fn(),
      rethink: vi.fn().mockImplementation(() => {
        throw new Error('disk full');
      }),
    };
    const tool = createOrientTool(store);

    const result = await tool.execute('call-5', {
      action: 'reorient',
      persona: 'x',
      human: 'y',
      goals: 'z',
    });

    expect(resultText(result)).toContain('Error updating orientation');
    expect(resultText(result)).toContain('disk full');
    expect(result.details?.isError).toBe(true);
  });
});
