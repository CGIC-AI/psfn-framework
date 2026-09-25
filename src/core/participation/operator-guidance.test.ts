import { describe, expect, it } from 'vitest';
import type { PromptLayer } from '../identity/prompt-types.js';
import { selectAppraiserOperatorGuidance } from './operator-guidance.js';

function layer(overrides: Partial<PromptLayer>): PromptLayer {
  return {
    id: 'layer',
    type: 'operator',
    name: 'layer',
    content: 'guidance',
    enabled: true,
    priority: 0,
    updatedAt: '2026-09-25T00:00:00.000Z',
    updatedBy: 'admin',
    checksum: 'abc',
    version: 1,
    ...overrides,
  };
}

describe('selectAppraiserOperatorGuidance (9iooo)', () => {
  it('keeps only enabled, unscoped, non-empty operator layers in stack order', () => {
    expect(selectAppraiserOperatorGuidance([
      layer({ id: 'b', name: 'second', content: 'two', priority: 2 }),
      layer({ id: 'a', name: 'first', content: ' one ', priority: 1 }),
      layer({ id: 'off', enabled: false }),
      layer({ id: 'empty', content: '   ' }),
      layer({ id: 'scoped', channelType: 'discord_text' }),
      layer({ id: 'task', taskKind: 'reflection' }),
      layer({ id: 'base', type: 'base', content: 'the whole character card' }),
    ])).toEqual([
      { name: 'first', content: 'one' },
      { name: 'second', content: 'two' },
    ]);
  });
});
