import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { EventBus } from '../event-bus.js';
import { createComponentLogger } from '../logger.js';
import { toErrorMessage } from '../utils/errors.js';
import {
  readModuleRegistry,
  resolveModuleRegistryPath,
  writeModuleRegistry,
} from './registry.js';
import type {
  ModuleRecord,
  ModuleRegistryMutation,
  ModuleRuntimeContext,
  SubstrateModule,
} from './types.js';

const log = createComponentLogger('ModuleLoader');

type ActivationSource = 'startup' | 'install' | 'update' | 'enable';
type DeactivationReason = 'disable' | 'reload' | 'shutdown';

interface ActiveModule {
  record: ModuleRecord;
  definition: SubstrateModule;
}

export interface ModuleLoaderOptions {
  eventBus: EventBus;
  registerTool: (tool: AgentTool<any>, category?: 'core' | 'extended') => void;
  registryPath?: string;
}

export interface ModuleLoadSummary {
  attempted: number;
  loaded: number;
  failed: number;
}

function toModuleDefinition(value: unknown): SubstrateModule {
  if (!value || typeof value !== 'object') {
    throw new Error('module must export an object');
  }
  return value as SubstrateModule;
}

function toActivationSource(action: ModuleRegistryMutation['action']): ActivationSource {
  switch (action) {
    case 'install':
      return 'install';
    case 'update':
      return 'update';
    case 'enable':
      return 'enable';
    default:
      return 'update';
  }
}

export class ModuleLoader {
  private readonly eventBus: EventBus;
  private readonly registerTool: (tool: AgentTool<any>, category?: 'core' | 'extended') => void;
  private readonly registryPath: string;
  private readonly activeModules = new Map<string, ActiveModule>();

  constructor(options: ModuleLoaderOptions) {
    this.eventBus = options.eventBus;
    this.registerTool = options.registerTool;
    this.registryPath = resolveModuleRegistryPath(options.registryPath);
  }

  getRegistryPath(): string {
    return this.registryPath;
  }

  async loadEnabledModules(): Promise<ModuleLoadSummary> {
    const records = await readModuleRegistry(this.registryPath);
    let mutated = false;
    let attempted = 0;
    let loaded = 0;
    let failed = 0;

    for (const record of records) {
      if (!record.enabled) continue;
      attempted += 1;
      try {
        await this.activateRecord(record, 'startup');
        if (record.lastError) {
          delete record.lastError;
          mutated = true;
        }
        loaded += 1;
      } catch (error) {
        const message = toErrorMessage(error);
        record.lastError = message;
        mutated = true;
        failed += 1;

        await this.eventBus.emit('module.error', {
          id: record.id,
          name: record.name,
          stage: 'activate',
          error: message,
        });

        log.warn('Failed to activate installed module', {
          moduleId: record.id,
          moduleName: record.name,
          error: message,
        });
      }
    }

    if (mutated) {
      await writeModuleRegistry(this.registryPath, records);
    }

    return {
      attempted,
      loaded,
      failed,
    };
  }

  async applyRegistryMutation(mutation: ModuleRegistryMutation): Promise<void> {
    if (mutation.next.enabled) {
      if (this.activeModules.has(mutation.next.id)) {
        await this.deactivateById(mutation.next.id, 'reload');
      }

      try {
        await this.activateRecord(mutation.next, toActivationSource(mutation.action));
        await this.clearRegistryError(mutation.next.id);
      } catch (error) {
        const message = toErrorMessage(error);
        await this.persistRegistryError(mutation.next.id, message);
        throw new Error(`module ${mutation.next.name} activation failed: ${message}`);
      }
      return;
    }

    if (this.activeModules.has(mutation.next.id)) {
      await this.deactivateById(mutation.next.id, 'disable');
    }
  }

  async shutdown(): Promise<void> {
    const active = [...this.activeModules.values()].reverse();
    for (const entry of active) {
      await this.deactivateById(entry.record.id, 'shutdown');
    }
  }

  private async activateRecord(record: ModuleRecord, source: ActivationSource): Promise<void> {
    await this.eventBus.emit('module.install', {
      id: record.id,
      name: record.name,
      version: record.version,
      source,
    });

    const moduleContext: ModuleRuntimeContext = {
      module: record,
      eventBus: this.eventBus,
      registerTool: this.registerTool,
    };

    const moduleDefinition = await this.loadModuleDefinition(record);
    await moduleDefinition.validate?.(moduleContext);
    await moduleDefinition.init?.(moduleContext);
    await moduleDefinition.activate?.(moduleContext);
    await moduleDefinition.start?.(moduleContext);

    this.activeModules.set(record.id, {
      record: { ...record },
      definition: moduleDefinition,
    });

    const health = await this.evaluateHealth(moduleDefinition);
    await this.eventBus.emit('module.health', {
      id: record.id,
      name: record.name,
      ok: health.ok,
      details: health.details,
    });

    if (!health.ok) {
      throw new Error(health.details || 'module health check failed');
    }
  }

  private async loadModuleDefinition(record: ModuleRecord): Promise<SubstrateModule> {
    const moduleSource = `${record.source}\n//# sourceURL=psfn-module:${record.name}@${record.version}-${record.updatedAt}`;
    const encoded = Buffer.from(moduleSource, 'utf-8').toString('base64');
    const imported = await import(`data:text/javascript;base64,${encoded}`);
    const candidate = (imported.default ?? imported) as unknown;
    const moduleDefinition = toModuleDefinition(candidate);

    if (moduleDefinition.name && moduleDefinition.name.trim().toLowerCase() !== record.name) {
      throw new Error(
        `module export name "${moduleDefinition.name}" does not match registry name "${record.name}"`,
      );
    }

    return moduleDefinition;
  }

  private async deactivateById(id: string, reason: DeactivationReason): Promise<void> {
    const entry = this.activeModules.get(id);
    if (!entry) return;

    const context: ModuleRuntimeContext = {
      module: entry.record,
      eventBus: this.eventBus,
      registerTool: this.registerTool,
    };

    try {
      await entry.definition.deactivate?.(context);
      await entry.definition.stop?.();
    } catch (error) {
      const message = toErrorMessage(error);
      await this.eventBus.emit('module.error', {
        id: entry.record.id,
        name: entry.record.name,
        stage: 'deactivate',
        error: message,
      });
      log.warn('Module deactivation failed', {
        moduleId: entry.record.id,
        moduleName: entry.record.name,
        reason,
        error: message,
      });
    } finally {
      this.activeModules.delete(id);
      await this.eventBus.emit('module.uninstall', {
        id: entry.record.id,
        name: entry.record.name,
        reason,
      });
    }
  }

  private async evaluateHealth(
    moduleDefinition: SubstrateModule,
  ): Promise<{ ok: boolean; details?: string }> {
    if (!moduleDefinition.health) {
      return { ok: true };
    }

    try {
      const status = await moduleDefinition.health();
      if (!status || typeof status !== 'object') {
        return { ok: false, details: 'module health() must return an object' };
      }
      if (status.ok) return { ok: true, details: status.details };
      return { ok: false, details: status.details || 'module reported unhealthy status' };
    } catch (error) {
      return { ok: false, details: toErrorMessage(error) };
    }
  }

  private async persistRegistryError(id: string, message: string): Promise<void> {
    const records = await readModuleRegistry(this.registryPath);
    const target = records.find((entry) => entry.id === id);
    if (!target) return;
    target.lastError = message;
    await writeModuleRegistry(this.registryPath, records);
  }

  private async clearRegistryError(id: string): Promise<void> {
    const records = await readModuleRegistry(this.registryPath);
    const target = records.find((entry) => entry.id === id);
    if (!target || !target.lastError) return;
    delete target.lastError;
    await writeModuleRegistry(this.registryPath, records);
  }
}
