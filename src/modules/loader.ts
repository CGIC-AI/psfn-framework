import type { EventBus } from '../shared/event-bus.js';
import { createComponentLogger } from '../logger.js';
import { toErrorMessage } from '../shared/utils/errors.js';
import type { ToolRegistrar } from '../agent/tool-registrar.js';
import {
  ensureRegistryFile,
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
  registerTool: ToolRegistrar;
  registryPath?: string;
}

export interface ModuleLoadSummary {
  attempted: number;
  loaded: number;
  failed: number;
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
  private readonly registerTool: ToolRegistrar;
  private readonly registryPath: string;
  private readonly activeModules = new Map<string, ActiveModule>();
  private registryMutationChain: Promise<void> = Promise.resolve();

  constructor(options: ModuleLoaderOptions) {
    this.eventBus = options.eventBus;
    this.registerTool = options.registerTool;
    this.registryPath = resolveModuleRegistryPath(options.registryPath);
  }

  getRegistryPath(): string {
    return this.registryPath;
  }

  async loadEnabledModules(): Promise<ModuleLoadSummary> {
    return await this.runRegistryMutation(async () => {
      ensureRegistryFile(this.registryPath);
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
    });
  }

  async applyRegistryMutation(mutation: ModuleRegistryMutation): Promise<void> {
    await this.runRegistryMutation(async () => {
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
    });
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
    void record;
    throw new Error('registry-backed module source execution is disabled');
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

  private async runRegistryMutation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.registryMutationChain.then(operation, operation);
    this.registryMutationChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
