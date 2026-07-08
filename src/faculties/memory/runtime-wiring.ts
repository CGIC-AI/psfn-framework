import type { ToolRegistrar } from '../../core/agent/tool-registrar.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import type { MemoryStorePort } from './memory-store-port.js';
import type { EpisodicTimelineStore } from './retrieval/episodic.js';
import type { MemoryWriter } from './writer.js';
import { createSharedBackgroundProvider } from './retrieval/shared-background.js';
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
    contactStore?: ContactStorePort | null;
  },
): void {
  const sharedBackgroundProvider = options.contactStore
    ? createSharedBackgroundProvider({
      memoryStore: options.memoryStore,
      contactStore: options.contactStore,
    })
    : null;
  target.registerTool(createMemoryTool(options.writer, options.memoryStore, {
    episodicStore: options.episodicStore ?? null,
    sharedBackgroundProvider,
  }), 'core');
  target.registerTool(createScratchpadTool(options.memoryStore), 'core');
}
