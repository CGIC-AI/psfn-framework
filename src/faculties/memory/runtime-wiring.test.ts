import { describe, expect, it, vi } from 'vitest';
import { registerMemoryTools } from './runtime-wiring.js';

describe('registerMemoryTools', () => {
  it('registers unified memory and scratchpad tools without split read/write aliases', () => {
    const registerTool = vi.fn();

    registerMemoryTools(
      { registerTool },
      {
        writer: {} as any,
        memoryStore: {} as any,
      },
    );

    const names = registerTool.mock.calls.map(([tool]) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'memory',
      'scratchpad',
      'memory_import_batch',
      'memory_patch',
      'memory_redact',
      'memory_delete',
      'undo_memory_delete',
      'scratchpad_write',
    ]));
    expect(names).not.toContain('memory_write');
    expect(names).not.toContain('scratchpad_read');
  });
});
