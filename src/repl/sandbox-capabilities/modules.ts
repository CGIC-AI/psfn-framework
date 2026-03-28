import { resolveRequiredModuleRegistryPath } from '../../system/security/policy-constants.js';
import type { ConfirmationQueue } from '../../system/capabilities/confirmation-queue.js';
import type { CapabilityTier } from '../../types.js';
import { isModuleRecord } from '../../modules/registry.js';
import type { ModuleRegistryMutation } from '../../modules/types.js';
import type { ThinkEvidence } from '../types.js';
import type { GatewayREPLCapabilities, ModuleRecord } from './contracts.js';
import { addEvidence, toErrorMessage, toTrimmedString } from './common.js';

interface ModuleMutationResult {
  ok: boolean;
  id?: string;
  version?: number;
  queued?: boolean;
  confirmationId?: string;
  error?: string;
}

export interface ModuleCapabilities {
  module_list: () => Promise<Array<Omit<ModuleRecord, 'source'>>>;
  module_install: (name: string, source: string, enable?: boolean) => Promise<ModuleMutationResult>;
  module_enable: (idOrName: string) => Promise<{ ok: boolean; error?: string }>;
  module_disable: (idOrName: string) => Promise<{ ok: boolean; error?: string }>;
  module_health: (
    idOrName?: string,
  ) => Promise<Array<{ id: string; name: string; enabled: boolean; health: string; version: number; updatedAt: number; lastError?: string }>>;
}

interface CreateModuleCapabilitiesOptions {
  gatewayCaps: GatewayREPLCapabilities;
  pushEvidence: (entry: ThinkEvidence) => void;
  getCapabilityTier?: () => CapabilityTier;
  confirmationQueue?: ConfirmationQueue | null;
  onModuleRegistryMutation?: (mutation: ModuleRegistryMutation) => Promise<void> | void;
}

interface NormalizedInstallInput {
  name: string;
  source: string;
}

function normalizeInstallInput(name: string, source: string): NormalizedInstallInput | { error: string } {
  const normalizedName = toTrimmedString(name).toLowerCase();
  if (!/^[a-z0-9._-]{2,64}$/.test(normalizedName)) {
    return { error: 'name must match ^[a-z0-9._-]{2,64}$' };
  }

  if (typeof source !== 'string' || source.trim().length === 0) {
    return { error: 'source is required' };
  }

  if (source.length > 100_000) {
    return { error: 'source too large (max 100000 chars)' };
  }

  return {
    name: normalizedName,
    source,
  };
}

function proposalReason(tier: CapabilityTier): string {
  return `Module install proposed by ${tier} tier`;
}

export function createModuleCapabilities(options: CreateModuleCapabilitiesOptions): ModuleCapabilities {
  const getCapabilityTier = options.getCapabilityTier ?? (() => 'autonomous' as CapabilityTier);
  const confirmationQueue = options.confirmationQueue ?? null;
  const moduleRegistryPath = resolveRequiredModuleRegistryPath();
  let registryMutationChain: Promise<void> = Promise.resolve();

  const loadModuleRegistry = async (): Promise<ModuleRecord[]> => {
    if (typeof options.gatewayCaps.fsRead !== 'function') {
      throw new Error('module ops require gateway fs policy (fsRead unavailable)');
    }

    try {
      const raw = await options.gatewayCaps.fsRead(moduleRegistryPath);
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.filter((entry): entry is ModuleRecord => isModuleRecord(entry));
    } catch (err) {
      const msg = toErrorMessage(err).toLowerCase();
      if (msg.includes('enoent') || msg.includes('not found')) {
        return [];
      }
      throw err;
    }
  };

  const saveModuleRegistry = async (records: ModuleRecord[]): Promise<void> => {
    if (typeof options.gatewayCaps.fsWrite !== 'function') {
      throw new Error('module ops require gateway fs policy (fsWrite unavailable)');
    }
    await options.gatewayCaps.fsWrite(moduleRegistryPath, JSON.stringify(records, null, 2));
  };

  const runRegistryMutation = async <T>(operation: () => Promise<T>): Promise<T> => {
    const next = registryMutationChain.then(operation, operation);
    registryMutationChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const notifyMutation = async (
    action: ModuleRegistryMutation['action'],
    next: ModuleRecord,
    previous: ModuleRecord | null,
  ): Promise<void> => {
    if (!options.onModuleRegistryMutation) {
      return;
    }
    await options.onModuleRegistryMutation({
      action,
      next: { ...next },
      previous: previous ? { ...previous } : null,
    });
  };

  const module_list = async (): Promise<Array<Omit<ModuleRecord, 'source'>>> => {
    const items = await loadModuleRegistry();
    return items
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ source: _source, ...rest }) => rest);
  };

  const applyInstallMutation = async (
    name: string,
    source: string,
    enable = false,
    recordEvidence = true,
  ): Promise<ModuleMutationResult> => {
    return await runRegistryMutation(async () => {
      const normalizedInput = normalizeInstallInput(name, source);
      if ('error' in normalizedInput) {
        return { ok: false, error: normalizedInput.error };
      }

      const now = Date.now();
      const items = await loadModuleRegistry();
      const existing = items.find(item => item.name === normalizedInput.name);

      if (existing) {
        const previous = { ...existing };
        existing.source = normalizedInput.source;
        existing.enabled = Boolean(enable);
        existing.updatedAt = now;
        existing.version += 1;
        await saveModuleRegistry(items);

        await notifyMutation('update', existing, previous);

        if (recordEvidence) {
          addEvidence(options.pushEvidence, {
            source: 'module',
            query: normalizedInput.name,
            snippet: `updated module v${existing.version}`,
            resultCount: 1,
            timestamp: now,
          });
        }

        return { ok: true, id: existing.id, version: existing.version };
      }

      const created: ModuleRecord = {
        id: `mod-${now}-${Math.random().toString(36).slice(2, 8)}`,
        name: normalizedInput.name,
        source: normalizedInput.source,
        enabled: Boolean(enable),
        installedAt: now,
        updatedAt: now,
        version: 1,
      };
      items.push(created);
      await saveModuleRegistry(items);

      await notifyMutation('install', created, null);

      if (recordEvidence) {
        addEvidence(options.pushEvidence, {
          source: 'module',
          query: normalizedInput.name,
          snippet: 'installed module v1',
          resultCount: 1,
          timestamp: now,
        });
      }

      return { ok: true, id: created.id, version: created.version };
    });
  };

  const module_install = async (
    name: string,
    source: string,
    enable = false,
  ): Promise<ModuleMutationResult> => {
    try {
      const tier = getCapabilityTier();
      if (tier === 'nursery') {
        return {
          ok: false,
          error: 'module_install is disabled for nursery tier',
        };
      }

      if (tier === 'apprentice') {
        if (!confirmationQueue) {
          return {
            ok: false,
            error: 'module_install in apprentice tier requires confirmation queue support',
          };
        }

        const normalizedInput = normalizeInstallInput(name, source);
        if ('error' in normalizedInput) {
          return { ok: false, error: normalizedInput.error };
        }

        const entry = confirmationQueue.enqueue(
          {
            method: 'module.install',
            action: 'install',
            scope: normalizedInput.name,
            params: {
              name: normalizedInput.name,
              source: normalizedInput.source,
              enable: Boolean(enable),
            },
            companionReason: proposalReason(tier),
          },
          async (approvedParams: Record<string, unknown>) => {
            const approvedName = typeof approvedParams.name === 'string'
              ? approvedParams.name
              : normalizedInput.name;
            const approvedSource = typeof approvedParams.source === 'string'
              ? approvedParams.source
              : normalizedInput.source;
            const approvedEnable = typeof approvedParams.enable === 'boolean'
              ? approvedParams.enable
              : Boolean(enable);
            const result = await applyInstallMutation(
              approvedName,
              approvedSource,
              approvedEnable,
              false,
            );
            if (!result.ok) {
              throw new Error(result.error || 'module installation failed');
            }
          },
        );

        return {
          ok: true,
          queued: true,
          confirmationId: entry.id,
        };
      }

      return await applyInstallMutation(name, source, enable, true);
    } catch (err) {
      return { ok: false, error: toErrorMessage(err) };
    }
  };

  const setModuleEnabled = async (idOrName: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> => {
    try {
      return await runRegistryMutation(async () => {
        const key = toTrimmedString(idOrName);
        if (!key) {
          return { ok: false, error: 'module id or name is required' };
        }
        const items = await loadModuleRegistry();
        const target = items.find(item => item.id === key || item.name === key);
        if (!target) {
          return { ok: false, error: 'module not found' };
        }

        const previous = { ...target };
        target.enabled = enabled;
        target.updatedAt = Date.now();
        target.version += 1;
        await saveModuleRegistry(items);
        await notifyMutation(enabled ? 'enable' : 'disable', target, previous);

        addEvidence(options.pushEvidence, {
          source: 'module',
          query: target.name,
          snippet: `${enabled ? 'enabled' : 'disabled'} module v${target.version}`,
          resultCount: 1,
          timestamp: target.updatedAt,
        });

        return { ok: true };
      });
    } catch (err) {
      return { ok: false, error: toErrorMessage(err) };
    }
  };

  const module_enable = async (idOrName: string): Promise<{ ok: boolean; error?: string }> => {
    return setModuleEnabled(idOrName, true);
  };

  const module_disable = async (idOrName: string): Promise<{ ok: boolean; error?: string }> => {
    return setModuleEnabled(idOrName, false);
  };

  const module_health = async (
    idOrName?: string,
  ): Promise<Array<{ id: string; name: string; enabled: boolean; health: string; version: number; updatedAt: number; lastError?: string }>> => {
    const items = await loadModuleRegistry();
    const filtered = idOrName
      ? items.filter(item => item.id === idOrName || item.name === idOrName)
      : items;

    return filtered.map(item => ({
      id: item.id,
      name: item.name,
      enabled: item.enabled,
      health: item.enabled ? (item.lastError ? 'degraded' : 'ready') : 'disabled',
      version: item.version,
      updatedAt: item.updatedAt,
      ...(item.lastError ? { lastError: item.lastError } : {}),
    }));
  };

  return {
    module_list,
    module_install,
    module_enable,
    module_disable,
    module_health,
  };
}
