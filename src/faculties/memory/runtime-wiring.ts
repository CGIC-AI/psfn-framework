import type { ToolRegistrar } from '../../core/agent/tool-registrar.js';
import type { MemoryStorePort } from './memory-store-port.js';
import type { EpisodicTimelineStore } from './retrieval/episodic.js';
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
    memoryStore: MemoryStorePort;
    episodicStore?: EpisodicTimelineStore | null;
  },
): void {
  target.registerTool(createMemoryTool(options.writer, options.memoryStore, {
    episodicStore: options.episodicStore ?? null,
  }), 'core');
  target.registerTool(createScratchpadTool(options.memoryStore), 'core');
}
