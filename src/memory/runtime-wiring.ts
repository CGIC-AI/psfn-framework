import type { ToolRegistrar } from '../agent/tool-registrar.js';
import type { MemoryStore } from './store.js';
import type { MemoryWriter } from './writer.js';
import {
  createMemoryTool,
  createScratchpadReadTool,
  createScratchpadWriteTool,
} from './tools.js';

export interface MemoryRuntimeTarget {
  registerTool: ToolRegistrar;
}

export function registerMemoryTools(
  target: MemoryRuntimeTarget,
  options: {
    writer: MemoryWriter;
    memoryStore: MemoryStore;
  },
): void {
  target.registerTool(createMemoryTool(options.writer, options.memoryStore), 'core');
  target.registerTool(createScratchpadReadTool(options.memoryStore), 'core');
  target.registerTool(createScratchpadWriteTool(options.memoryStore), 'extended');
}
