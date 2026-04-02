import type { ToolRegistrar } from '../agent/tool-registrar.js';
import type { MemoryStorePort } from '../memory/memory-store-port.js';
import { ResearchLibraryStore } from './store.js';
import { createResearchLibraryTool } from './tools.js';

export interface ResearchLibraryRuntimeTarget {
  registerTool: ToolRegistrar;
}

export function registerResearchLibraryTools(
  target: ResearchLibraryRuntimeTarget,
  options: {
    store: ResearchLibraryStore;
    memoryStore: MemoryStorePort;
  },
): void {
  target.registerTool(createResearchLibraryTool(options.store, options.memoryStore), 'extended');
}
