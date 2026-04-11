import { describe, expect, it, vi } from 'vitest';
import { registerMemoryTools } from './runtime-wiring.js';

describe('registerMemoryTools', () => {
  it('registers unified memory and scratchpad tools as core semantic surfaces', () => {
    const registerTool = vi.fn();

    registerMemoryTools(
      { registerTool },
      {
        writer: {} as any,
        memoryStore: {} as any,
      },
    );

    expect(registerTool.mock.calls).toEqual(expect.arrayContaining([
      [expect.objectContaining({ name: 'memory' }), 'core'],
      [expect.objectContaining({ name: 'scratchpad' }), 'core'],
      [expect.objectContaining({ name: 'memory_write' }), 'core'],
      [expect.objectContaining({ name: 'scratchpad_read' }), 'core'],
      [expect.objectContaining({ name: 'scratchpad_write' }), 'extended'],
    ]));
  });
});
