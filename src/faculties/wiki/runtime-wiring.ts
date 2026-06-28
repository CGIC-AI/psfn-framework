import type { ToolRegistrar } from '../../core/agent/tool-registrar.js';
import { createWikiTool } from './tools.js';
import { WikiStore } from './store.js';

export interface WikiRuntimeTarget {
  registerTool: ToolRegistrar;
}

export function wireWikiRuntime(
  target: WikiRuntimeTarget,
  workspacePath: string,
): WikiStore {
  const store = new WikiStore(workspacePath);
  target.registerTool(createWikiTool(store), 'core');
  return store;
}
