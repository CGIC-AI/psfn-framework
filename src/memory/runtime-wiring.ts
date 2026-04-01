import type { ToolRegistrar } from '../agent/tool-registrar.js';
import type { MemoryStore } from './store.js';
import type { MemoryWriter } from './writer.js';
import {
  createMemoryTool,
  createScratchpadTool,
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
  target.registerTool(createScratchpadTool(options.memoryStore), 'core');
}
