import { MODULE_REGISTRY_PATH } from '../../security/policy-constants.js';
import type { ThinkEvidence } from '../types.js';
import type { GatewayREPLCapabilities, ModuleRecord } from './contracts.js';
import { addEvidence, toErrorMessage, toTrimmedString } from './common.js';

interface ModuleMutationResult {
  ok: boolean;
  id?: string;
  version?: number;
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
}

function isModuleRecord(value: unknown): value is ModuleRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<ModuleRecord>;
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.source === 'string'
    && typeof candidate.enabled === 'boolean'
    && typeof candidate.installedAt === 'number'
    && typeof candidate.updatedAt === 'number'
    && typeof candidate.version === 'number';
}

export function createModuleCapabilities(options: CreateModuleCapabilitiesOptions): ModuleCapabilities {
  const loadModuleRegistry = async (): Promise<ModuleRecord[]> => {
    if (typeof options.gatewayCaps.fsRead !== 'function') {
      throw new Error('module ops require gateway fs policy (fsRead unavailable)');
    }

    try {
      const raw = await options.gatewayCaps.fsRead(MODULE_REGISTRY_PATH);
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
    await options.gatewayCaps.fsWrite(MODULE_REGISTRY_PATH, JSON.stringify(records, null, 2));
  };

  const module_list = async (): Promise<Array<Omit<ModuleRecord, 'source'>>> => {
    const items = await loadModuleRegistry();
    return items
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ source: _source, ...rest }) => rest);
  };

  const module_install = async (
    name: string,
    source: string,
    enable = false,
  ): Promise<ModuleMutationResult> => {
    try {
      const normalizedName = toTrimmedString(name).toLowerCase();
      if (!/^[a-z0-9._-]{2,64}$/.test(normalizedName)) {
        return { ok: false, error: 'name must match ^[a-z0-9._-]{2,64}$' };
      }
      if (typeof source !== 'string' || source.trim().length === 0) {
        return { ok: false, error: 'source is required' };
      }
      if (source.length > 100_000) {
        return { ok: false, error: 'source too large (max 100000 chars)' };
      }

      const now = Date.now();
      const items = await loadModuleRegistry();
      const existing = items.find(item => item.name === normalizedName);

      if (existing) {
        existing.source = source;
        existing.enabled = Boolean(enable);
        existing.updatedAt = now;
        existing.version += 1;
        await saveModuleRegistry(items);

        addEvidence(options.pushEvidence, {
          source: 'module',
          query: normalizedName,
          snippet: `updated module v${existing.version}`,
          resultCount: 1,
          timestamp: now,
        });

        return { ok: true, id: existing.id, version: existing.version };
      }

      const created: ModuleRecord = {
        id: `mod-${now}-${Math.random().toString(36).slice(2, 8)}`,
        name: normalizedName,
        source,
        enabled: Boolean(enable),
        installedAt: now,
        updatedAt: now,
        version: 1,
      };
      items.push(created);
      await saveModuleRegistry(items);

      addEvidence(options.pushEvidence, {
        source: 'module',
        query: normalizedName,
        snippet: 'installed module v1',
        resultCount: 1,
        timestamp: now,
      });

      return { ok: true, id: created.id, version: created.version };
    } catch (err) {
      return { ok: false, error: toErrorMessage(err) };
    }
  };

  const setModuleEnabled = async (idOrName: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> => {
    try {
      const key = toTrimmedString(idOrName);
      if (!key) {
        return { ok: false, error: 'module id or name is required' };
      }
      const items = await loadModuleRegistry();
      const target = items.find(item => item.id === key || item.name === key);
      if (!target) {
        return { ok: false, error: 'module not found' };
      }

      target.enabled = enabled;
      target.updatedAt = Date.now();
      target.version += 1;
      await saveModuleRegistry(items);

      addEvidence(options.pushEvidence, {
        source: 'module',
        query: target.name,
        snippet: `${enabled ? 'enabled' : 'disabled'} module v${target.version}`,
        resultCount: 1,
        timestamp: target.updatedAt,
      });

      return { ok: true };
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
