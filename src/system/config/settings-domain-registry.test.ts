import { describe, expect, it } from 'vitest';
import {
  assertSettingsDomainId,
  buildSettingsDomainGardenProjection,
  buildSettingsFieldDomainProjection,
  listSettingsDomains,
  resolveSettingsDomainById,
  resolveSettingsDomainForField,
  resolveSettingsDomainForOwnerFile,
  resolveSettingsFieldGardenDomainTab,
  resolveSettingsDomainGardenMeta,
  SETTINGS_APPLY_MODES,
  SETTINGS_ACTIVATION_TIERS,
  SETTINGS_DOMAIN_GARDEN_TABS,
  SETTINGS_DOMAIN_IDS,
  SETTINGS_DOMAIN_REGISTRY,
  SETTINGS_FAILURE_SCOPES,
  SETTINGS_FIELD_DOMAIN_BY_KEY,
  SETTINGS_NON_DOMAIN_OWNER_FILES,
  verifySettingsDomainRegistry,
  type SettingsActivationTier,
  type SettingsApplyMode,
  type SettingsDomainDescriptor,
  type SettingsDomainId,
  type SettingsFailureScope,
} from './settings-domain-registry.js';
import { buildSettingsContractData } from './settings-contract.js';
import { verifySettingsContractGuard } from './settings-contract-guard.js';
import {
  SETTINGS_GARDEN_FIELD_EXPOSURE,
} from '../../shared/contracts/settings-garden-contract.js';

const REGISTRY_DOMAIN_IDS = SETTINGS_DOMAIN_IDS;

describe('settings-domain registry canonical shape', () => {
  it('registers exactly the eight operator-approved domains in canonical order', () => {
    expect([...REGISTRY_DOMAIN_IDS]).toEqual([
      'core',
      'models',
      'channels',
      'memory',
      'scheduler',
      'cogsec',
      'economy',
      'capabilities',
    ]);
    expect(Object.keys(SETTINGS_DOMAIN_REGISTRY)).toEqual([...REGISTRY_DOMAIN_IDS]);
    expect(listSettingsDomains().map(descriptor => descriptor.id)).toEqual([...REGISTRY_DOMAIN_IDS]);
  });

  it('owns a unique canonical file and real current owner files per domain', () => {
    const expected: Record<SettingsDomainId, {
      ownerFileName: string;
      currentOwnerFiles: readonly string[];
    }> = {
      core: { ownerFileName: 'core.json', currentOwnerFiles: ['settings.json', 'backup.json'] },
      models: { ownerFileName: 'models.json', currentOwnerFiles: ['models.json', 'providers.json'] },
      channels: { ownerFileName: 'channels.json', currentOwnerFiles: ['channels.json'] },
      memory: { ownerFileName: 'memory.json', currentOwnerFiles: ['partner-affect-shadow.json'] },
      scheduler: { ownerFileName: 'scheduler.json', currentOwnerFiles: ['scheduler.json'] },
      cogsec: { ownerFileName: 'cogsec.json', currentOwnerFiles: ['trust-policy.json', 'intake-policy.json'] },
      economy: { ownerFileName: 'economy.json', currentOwnerFiles: ['charge-policy.json'] },
      capabilities: {
        ownerFileName: 'capabilities.json',
        currentOwnerFiles: ['capability-tier.json', 'skills.json', 'subagent-roles.json'],
      },
    };

    for (const id of REGISTRY_DOMAIN_IDS) {
      const descriptor = SETTINGS_DOMAIN_REGISTRY[id];
      expect(descriptor.ownerFileName).toBe(expected[id].ownerFileName);
      expect(descriptor.currentOwnerFiles).toEqual(expected[id].currentOwnerFiles);
      expect(descriptor.schemaValidators.length).toBeGreaterThan(0);
      for (const validator of descriptor.schemaValidators) {
        expect(validator.ownerFile).toMatch(/\.json$/u);
        expect(validator.validator.length).toBeGreaterThan(0);
      }
    }
  });

  it('records the full runtime + Garden metadata contract for every domain', () => {
    for (const id of REGISTRY_DOMAIN_IDS) {
      const descriptor: SettingsDomainDescriptor = SETTINGS_DOMAIN_REGISTRY[id];
      expect(descriptor.id).toBe(id);
      expect(descriptor.title.trim().length).toBeGreaterThan(0);
      expect(descriptor.description.trim().length).toBeGreaterThan(0);
      expect(descriptor.units.trim().length).toBeGreaterThan(0);
      expect(new Set(['global', 'perCompanion']).has(descriptor.scope)).toBe(true);
      expect(SETTINGS_ACTIVATION_TIERS).toContain(descriptor.activationTier);
      expect(SETTINGS_FAILURE_SCOPES).toContain(descriptor.failureScope);
      expect(SETTINGS_APPLY_MODES).toContain(descriptor.applyMode);
      expect(descriptor.securityBounds.description.trim().length).toBeGreaterThan(0);
      expect(descriptor.garden.tabId).toBe(id);
      expect(descriptor.garden.order).toBeGreaterThanOrEqual(0);
      for (const relation of descriptor.relatedPaths) {
        expect(REGISTRY_DOMAIN_IDS).toContain(relation.domain);
      }
      for (const tab of descriptor.garden.relatedTabs) {
        expect(REGISTRY_DOMAIN_IDS).toContain(tab);
      }
    }

    // Every domain has a unique Garden tab order.
    const orders = REGISTRY_DOMAIN_IDS.map(id => SETTINGS_DOMAIN_REGISTRY[id].garden.order);
    expect(new Set(orders).size).toBe(orders.length);

    // Garden tabs are derived from the registry in canonical order.
    expect(SETTINGS_DOMAIN_GARDEN_TABS.map(tab => tab.tabId)).toEqual([...REGISTRY_DOMAIN_IDS]);
    expect(SETTINGS_DOMAIN_GARDEN_TABS.map(tab => tab.order)).toEqual([...orders].sort((a, b) => a - b));
  });

  it('passes its own fail-closed guard', () => {
    expect(verifySettingsDomainRegistry()).toEqual({ ok: true, errors: [] });
  });
});

describe('settings-domain registry topology/authority/extension boundary', () => {
  it('keeps topology, authority, and extension files explicitly outside the domains', () => {
    expect([...SETTINGS_NON_DOMAIN_OWNER_FILES]).toEqual([
      'companions.json',
      'fleet-auth.json',
      'mcp-servers.json',
      'satellites.json',
    ]);

    for (const file of SETTINGS_NON_DOMAIN_OWNER_FILES) {
      expect(resolveSettingsDomainForOwnerFile(file)).toBeUndefined();
      for (const id of REGISTRY_DOMAIN_IDS) {
        const descriptor = SETTINGS_DOMAIN_REGISTRY[id];
        expect(descriptor.currentOwnerFiles).not.toContain(file);
        expect(descriptor.ownerFileName).not.toBe(file);
      }
    }
  });

  it('resolves every real owner file to exactly one domain', () => {
    const fileToDomain = new Map<string, Set<SettingsDomainId>>();
    for (const id of REGISTRY_DOMAIN_IDS) {
      const descriptor = SETTINGS_DOMAIN_REGISTRY[id];
      const files = new Set<string>([...descriptor.currentOwnerFiles, descriptor.ownerFileName]);
      for (const file of files) {
        const resolved = resolveSettingsDomainForOwnerFile(file);
        expect(resolved, `${file} should resolve to ${id}`).toBe(id);
        const owners = fileToDomain.get(file) ?? new Set<SettingsDomainId>();
        owners.add(id);
        fileToDomain.set(file, owners);
      }
    }
    // No file may belong to two different domains.
    for (const [file, owners] of fileToDomain) {
      expect(owners.size, `${file} owned by ${[...owners].join(', ')}`).toBe(1);
    }
  });

  it('fails closed when a field is owned by a non-domain topology file', () => {
    expect(() =>
      resolveSettingsDomainForField('syntheticTopologyField', { syntheticTopologyField: { ownerFile: 'companions.json' } }),
    ).toThrow(/not a settings domain owner/u);
  });
});

describe('settings-domain registry fail-closed validation', () => {
  type MutableDescriptor = { -readonly [K in keyof SettingsDomainDescriptor]: SettingsDomainDescriptor[K] };
  type MutableRegistry = { [K in SettingsDomainId]: MutableDescriptor };
  type RegistryInput = Parameters<typeof verifySettingsDomainRegistry>[0];

  function cloneRegistry(): MutableRegistry {
    return structuredClone(SETTINGS_DOMAIN_REGISTRY) as unknown as MutableRegistry;
  }

  function withMutation(
    mutate: (registry: MutableRegistry) => void,
  ): ReturnType<typeof verifySettingsDomainRegistry> {
    const registry = cloneRegistry();
    mutate(registry);
    return verifySettingsDomainRegistry(registry as unknown as RegistryInput);
  }

  it('rejects an unknown domain id', () => {
    const registry = cloneRegistry();
    const mutated = {
      ...registry,
      extensions: {
        ...registry.core,
        id: 'extensions' as SettingsDomainId,
        title: 'Extensions',
      },
    };
    const result = verifySettingsDomainRegistry(mutated as unknown as RegistryInput);
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('unknown domain ids'))).toBe(true);
  });

  it('rejects a missing canonical domain', () => {
    const registry = cloneRegistry();
    delete registry.memory;
    const result = verifySettingsDomainRegistry(registry as unknown as RegistryInput);
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('missing canonical domain "memory"'))).toBe(true);
  });

  it('rejects a duplicate canonical owner file name', () => {
    const result = withMutation(registry => {
      registry.economy.ownerFileName = 'models.json';
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('claimed by domains'))).toBe(true);
  });

  it('rejects an overlapping current owner file', () => {
    const result = withMutation(registry => {
      registry.economy.currentOwnerFiles = ['charge-policy.json', 'scheduler.json'];
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('claimed by domains'))).toBe(true);
  });

  it('rejects a topology/authority file claimed as a domain owner', () => {
    const result = withMutation(registry => {
      registry.core.currentOwnerFiles = ['settings.json', 'companions.json'];
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('explicitly outside the eight domains'))).toBe(true);
  });

  it('rejects an invalid apply mode', () => {
    const result = withMutation(registry => {
      registry.scheduler.applyMode = 'instant' as SettingsApplyMode;
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('invalid applyMode'))).toBe(true);
  });

  it('rejects an invalid activation tier', () => {
    const result = withMutation(registry => {
      registry.capabilities.activationTier = 'always' as SettingsActivationTier;
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('invalid activationTier'))).toBe(true);
  });

  it('rejects an invalid failure scope', () => {
    const result = withMutation(registry => {
      registry.channels.failureScope = 'planet' as SettingsFailureScope;
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('invalid failureScope'))).toBe(true);
  });

  it('rejects a Garden tab id that drifts from the domain id', () => {
    const result = withMutation(registry => {
      registry.cogsec.garden = { ...registry.cogsec.garden, tabId: 'security' as SettingsDomainId };
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('must equal the domain id'))).toBe(true);
  });

  it('rejects a duplicate Garden tab order', () => {
    const result = withMutation(registry => {
      registry.economy.garden = { ...registry.economy.garden, order: registry.scheduler.garden.order };
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('tab order'))).toBe(true);
  });

  it('rejects a relation to an unknown domain', () => {
    const result = withMutation(registry => {
      registry.core.relatedPaths = [
        { domain: 'satellites' as SettingsDomainId, kind: 'references', description: 'x' },
      ];
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('unknown related domain'))).toBe(true);
  });

  it('rejects malformed security bounds', () => {
    const result = withMutation(registry => {
      registry.models.securityBounds = {
        ...registry.models.securityBounds,
        description: '',
      };
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('malformed security bounds'))).toBe(true);
  });

  it('rejects a descriptor whose key and id disagree', () => {
    const registry = cloneRegistry();
    registry.core = { ...registry.core, id: 'models' };
    const result = verifySettingsDomainRegistry(registry as unknown as RegistryInput);
    expect(result.ok).toBe(false);
    expect(result.errors.some(error => error.includes('does not match its key'))).toBe(true);
  });

  it('throws when resolving an unknown domain id', () => {
    expect(() => assertSettingsDomainId('planets')).toThrow(/Unknown settings domain/u);
    expect(() => resolveSettingsDomainById('planets')).toThrow(/Unknown settings domain/u);
    expect(() => resolveSettingsDomainGardenMeta('planets' as SettingsDomainId)).toThrow(/Unknown settings domain/u);
  });
});

describe('settings-domain tracer: memoryRetrievalPolicy resolves and renders through the registry', () => {
  const tracerKey = 'memoryRetrievalPolicy';

  it('is an existing mutable settings.json field with Garden exposure', () => {
    const contractData = buildSettingsContractData();
    const field = contractData.fields[tracerKey];
    expect(field).toBeDefined();
    expect(field.ownerFile).toBe('settings.json');
    expect(field.deprecated).toBeUndefined();
    expect(SETTINGS_GARDEN_FIELD_EXPOSURE[tracerKey]).toBeDefined();
  });

  it('resolves to the memory domain before settings.json is split', () => {
    const contractData = buildSettingsContractData();
    expect(SETTINGS_FIELD_DOMAIN_BY_KEY[tracerKey]).toBe('memory');
    expect(resolveSettingsDomainForField(tracerKey, contractData.fields)).toBe('memory');
  });

  it('shares one Garden domain tab between runtime resolution and UI metadata', () => {
    const contractData = buildSettingsContractData();

    const runtimeTab = resolveSettingsFieldGardenDomainTab(tracerKey, contractData.fields);
    const registryTab = resolveSettingsDomainGardenMeta('memory');
    expect(runtimeTab.tabId).toBe('memory');
    expect(runtimeTab).toEqual({
      tabId: 'memory',
      order: registryTab.order,
      title: registryTab.title,
      description: registryTab.description,
      relatedTabs: registryTab.relatedTabs,
    });

    // The existing Garden field section already aligns with the memory domain
    // tab, proving UI rendering and runtime resolution share one descriptor
    // rather than copied page metadata.
    expect(SETTINGS_GARDEN_FIELD_EXPOSURE[tracerKey].sectionId).toBe('memory');
    expect(SETTINGS_DOMAIN_GARDEN_TABS.find(tab => tab.tabId === 'memory')).toBeDefined();
  });

  it('projects the tracer into the Garden contract domain payload', () => {
    const contractData = buildSettingsContractData();
    const projection = buildSettingsDomainGardenProjection(contractData.fields);

    expect(projection.domainIds).toEqual([...REGISTRY_DOMAIN_IDS]);
    expect(projection.fieldDomains[tracerKey]).toBe('memory');
    expect(projection.unresolvedFields).toEqual([]);
    expect(projection.tabs.map(tab => tab.tabId)).toEqual([...REGISTRY_DOMAIN_IDS]);
  });

  it('keeps the tracer covered by the integrated settings contract guard', () => {
    expect(verifySettingsContractGuard()).toEqual({ ok: true, errors: [] });

    const contractData = buildSettingsContractData();
    const projection = buildSettingsFieldDomainProjection(contractData.fields);
    expect(projection.unresolved).toEqual([]);
    expect(projection.fieldDomains[tracerKey]).toBe('memory');
  });
});

describe('settings-domain field projection completeness', () => {
  it('classifies every registered settings field into one of the eight domains', () => {
    const contractData = buildSettingsContractData();
    const projection = buildSettingsFieldDomainProjection(contractData.fields);

    expect(projection.unresolved).toEqual([]);
    for (const domain of Object.values(projection.fieldDomains)) {
      expect(REGISTRY_DOMAIN_IDS).toContain(domain);
    }

    // Representative fields land in their expected target domains via the
    // current owner file (or the field-level override seam).
    expect(projection.fieldDomains.sessionHistoryBudgetPct).toBe('core');
    expect(projection.fieldDomains.modelCatalog).toBe('models');
    expect(projection.fieldDomains.backgroundMaintenanceIntervalMs).toBe('scheduler');
    expect(projection.fieldDomains.capabilityTier).toBe('capabilities');
    expect(projection.fieldDomains.memoryRetrievalPolicy).toBe('memory');
  });

  it('does not classify any field as a topology/authority/extension owner', () => {
    const contractData = buildSettingsContractData();
    for (const field of Object.values(contractData.fields)) {
      expect(SETTINGS_NON_DOMAIN_OWNER_FILES).not.toContain(field.ownerFile);
    }
  });
});
