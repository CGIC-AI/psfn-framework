import type { ToolRegistrar } from '../../core/agent/tool-registrar.js';
import type { MemoryStorePort } from './memory-store-port.js';
import type { MemoryWriter } from './writer.js';
import {
  createMemoryTool,
  createMemoryDeleteTool,
  createMemoryImportTool,
  createMemoryPatchTool,
  createMemoryRedactTool,
  createMemoryWriteTool,
  createScratchpadTool,
  createScratchpadReadTool,
  createScratchpadWriteTool,
  createUndoMemoryDeleteTool,
} from './tools.js';

export interface MemoryRuntimeTarget {
  registerTool: ToolRegistrar;
}

export function registerMemoryTools(
  target: MemoryRuntimeTarget,
  options: {
    writer: MemoryWriter;
    memoryStore: MemoryStorePort;
  },
): void {
  target.registerTool(createMemoryTool(options.writer, options.memoryStore), 'core');
  target.registerTool(createScratchpadTool(options.memoryStore), 'core');
  target.registerTool(createMemoryWriteTool(options.writer), 'core');
  target.registerTool(createScratchpadReadTool(options.memoryStore), 'core');
  target.registerTool(createMemoryImportTool(options.writer), 'extended');
  target.registerTool(createMemoryPatchTool(options.writer), 'extended');
  target.registerTool(createMemoryRedactTool(options.writer), 'extended');
  target.registerTool(createMemoryDeleteTool(options.memoryStore), 'extended');
  target.registerTool(createUndoMemoryDeleteTool(options.memoryStore), 'extended');
  target.registerTool(createScratchpadWriteTool(options.memoryStore), 'extended');
}
