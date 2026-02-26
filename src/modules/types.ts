import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { EventBus } from '../event-bus.js';

export interface ModuleRecord {
  id: string;
  name: string;
  source: string;
  enabled: boolean;
  installedAt: number;
  updatedAt: number;
  version: number;
  lastError?: string;
}

export type ModuleMutationAction =
  | 'install'
  | 'update'
  | 'enable'
  | 'disable';

export interface ModuleRegistryMutation {
  action: ModuleMutationAction;
  next: ModuleRecord;
  previous: ModuleRecord | null;
}

export interface ModuleRuntimeContext {
  module: ModuleRecord;
  eventBus: EventBus;
  registerTool: (tool: AgentTool<any>, category?: 'core' | 'extended') => void;
}

export interface ModuleHealthStatus {
  ok: boolean;
  details?: string;
}

export interface SubstrateModule {
  name?: string;
  version?: string;
  description?: string;
  validate?: (context: ModuleRuntimeContext) => Promise<void> | void;
  init?: (context: ModuleRuntimeContext) => Promise<void> | void;
  activate?: (context: ModuleRuntimeContext) => Promise<void> | void;
  start?: (context: ModuleRuntimeContext) => Promise<void> | void;
  deactivate?: (context: ModuleRuntimeContext) => Promise<void> | void;
  stop?: () => Promise<void> | void;
  health?: () => Promise<ModuleHealthStatus> | ModuleHealthStatus;
}
