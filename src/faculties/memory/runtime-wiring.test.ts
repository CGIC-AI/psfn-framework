import { describe, expect, it, vi } from 'vitest';
import { registerMemoryTools } from './runtime-wiring.js';

describe('registerMemoryTools', () => {
  it('registers only canonical memory and scratchpad tools', () => {
    const registerTool = vi.fn();

    registerMemoryTools(
      { registerTool },
      {
        writer: {} as any,
        memoryStore: {} as any,
      },
    );

    const names = registerTool.mock.calls.map(([tool]) => tool.name);
    expect(names).toEqual(['memory', 'scratchpad']);
    expect(names).not.toEqual(expect.arrayContaining([
      'memory_import_batch',
      'memory_patch',
      'memory_redact',
      'memory_delete',
      'undo_memory_delete',
      'memory_write',
      'scratchpad_read',
      'scratchpad_write',
    ]));
  });
});
