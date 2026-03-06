import type Database from 'better-sqlite3';
import type { ToolRegistrar } from '../agent/tool-registrar.js';
import {
  ActiveConcernStore,
  type ActiveConcernContextProvider,
} from './concerns.js';
import {
  createCreateConcernTool,
  createListConcernsTool,
  createResolveConcernTool,
} from './tools.js';

export interface IntentionRuntimeTarget {
  activeConcernProvider: ActiveConcernContextProvider | null;
  registerTool: ToolRegistrar;
}

export function wireIntentionRuntime(
  target: IntentionRuntimeTarget,
  db: Database.Database,
): ActiveConcernStore {
  const concernStore = new ActiveConcernStore(db);
  target.activeConcernProvider = concernStore;
  target.registerTool(createCreateConcernTool(concernStore));
  target.registerTool(createListConcernsTool(concernStore));
  target.registerTool(createResolveConcernTool(concernStore));
  return concernStore;
}
