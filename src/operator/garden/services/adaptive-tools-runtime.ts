import type { AdaptiveToolRuntimeState } from '../../../agent/adaptive-tools-telemetry.js';
import type { RuntimeToolCatalogEntry, RuntimeToolCatalogSnapshot } from '../../../agent/tool-catalog.js';
import { cloneToolWiringMeta } from '../../../agent/tool-wiring-validator.js';
import type {
  RuntimeServiceHealth,
  RuntimeServiceHealthSnapshot,
  RuntimeServiceHealthStatus,
} from '../../tool-health/types.js';
import type {
  AdminToolFailureEvent,
  AdminToolHealthView,
} from './types.js';

interface DerivedToolDefinition {
  name: string;
  description: string;
  scope: 'core' | 'extended' | 'conditional';
  registered: boolean;
  wiringMeta?: RuntimeToolCatalogEntry['wiringMeta'];
}

const CONDITIONAL_TOOLS: DerivedToolDefinition[] = [
  {
    name: 'vault_write',
    description: 'Create or append to a markdown note in the Obsidian vault.',
    scope: 'conditional',
    registered: false,
    wiringMeta: {
      requiredServices: ['vault'],
    },
  },
  {
    name: 'vault_read',
    description: 'Read the content of a note from the Obsidian vault.',
    scope: 'conditional',
    registered: false,
    wiringMeta: {
      requiredServices: ['vault'],
    },
  },
  {
    name: 'vault_search',
    description: 'Search for notes in the Obsidian vault.',
    scope: 'conditional',
    registered: false,
    wiringMeta: {
      requiredServices: ['vault'],
    },
  },
  {
    name: 'vault_daily',
    description: 'Read from or append to the current Obsidian daily note.',
    scope: 'conditional',
    registered: false,
    wiringMeta: {
      requiredServices: ['vault'],
    },
  },
];

const VAULT_ACTION_BY_TOOL: Record<string, string> = {
  vault_write: 'write',
  vault_read: 'read',
  vault_search: 'search',
  vault_daily: 'daily',
};

export function cloneRuntimeState(state: AdaptiveToolRuntimeState): AdaptiveToolRuntimeState {
  return {
    ...state,
    coreTools: [...state.coreTools],
    extendedTools: [...state.extendedTools],
    promotedToolsConfigured: [...state.promotedToolsConfigured],
    promotedToolsActive: [...state.promotedToolsActive],
    promotedToolsSkipped: state.promotedToolsSkipped.map(entry => ({
      ...entry,
      ...(entry.missingTokens ? { missingTokens: [...entry.missingTokens] } : {}),
    })),
    loadedExtendedTools: state.loadedExtendedTools.map(entry => ({ ...entry })),
    activeTools: state.activeTools.map(entry => ({ ...entry })),
    lastSnapshot: state.lastSnapshot
      ? {
        ...state.lastSnapshot,
        tools: state.lastSnapshot.tools.map(tool => ({ ...tool })),
        skipped: state.lastSnapshot.skipped.map(skip => ({
          ...skip,
          ...(skip.missingTokens ? { missingTokens: [...skip.missingTokens] } : {}),
        })),
        counts: { ...state.lastSnapshot.counts },
      }
      : null,
  };
}

export function cloneToolCatalogSnapshot(
  snapshot: RuntimeToolCatalogSnapshot | null,
): RuntimeToolCatalogSnapshot | null {
  if (!snapshot) return null;
  return {
    generatedAt: snapshot.generatedAt,
    tools: snapshot.tools.map(tool => ({
      ...tool,
      ...(tool.wiringMeta ? { wiringMeta: cloneToolWiringMeta(tool.wiringMeta) } : {}),
    })),
  };
}

export function cloneServiceHealth(
  snapshot: RuntimeServiceHealthSnapshot | null,
): RuntimeServiceHealth[] {
  if (!snapshot) return [];
  return snapshot.services.map(service => ({
    ...service,
    ...(service.availableActions ? { availableActions: [...service.availableActions] } : {}),
    ...(service.lastFailure ? { lastFailure: { ...service.lastFailure } } : {}),
  }));
}

export function deriveToolHealthViews(params: {
  catalog: RuntimeToolCatalogSnapshot | null;
  state: AdaptiveToolRuntimeState | null;
  serviceHealth: RuntimeServiceHealth[];
  recentFailures: readonly AdminToolFailureEvent[];
}): AdminToolHealthView[] {
  const definitions = resolveToolDefinitions(params.catalog, params.serviceHealth);
  const serviceById = new Map(params.serviceHealth.map(service => [service.serviceId, service]));
  const activeSources = new Map(params.state?.activeTools.map(tool => [tool.toolName, tool.source]) ?? []);
  const failureByTool = new Map<string, AdminToolFailureEvent>();

  for (const failure of params.recentFailures) {
    if (!failureByTool.has(failure.toolName)) {
      failureByTool.set(failure.toolName, { ...failure });
    }
  }

  return definitions.map((definition) => {
    const lastFailure = failureByTool.get(definition.name);
    const health = resolveToolHealth(definition, serviceById, lastFailure);
    return {
      name: definition.name,
      description: definition.description,
      scope: definition.scope,
      health,
      contexts: {
        chat: resolveContextAvailability(definition, health.status, activeSources.get(definition.name), 'chat'),
        internalHeartbeat: resolveContextAvailability(
          definition,
          health.status,
          activeSources.get(definition.name),
          'internalHeartbeat',
        ),
      },
      ...(lastFailure ? { lastFailure: { ...lastFailure } } : {}),
    };
  });
}

function resolveToolDefinitions(
  catalog: RuntimeToolCatalogSnapshot | null,
  serviceHealth: RuntimeServiceHealth[],
): DerivedToolDefinition[] {
  const definitions = new Map<string, DerivedToolDefinition>();
  for (const tool of catalog?.tools ?? []) {
    definitions.set(tool.name, {
      name: tool.name,
      description: tool.description,
      scope: tool.scope,
      registered: true,
      ...(tool.wiringMeta ? { wiringMeta: cloneToolWiringMeta(tool.wiringMeta) } : {}),
    });
  }

  const vaultService = serviceHealth.find(service => service.serviceId === 'vault');
  if (vaultService && !definitions.has('vault_write') && vaultService.status !== 'healthy') {
    for (const conditionalTool of CONDITIONAL_TOOLS) {
      definitions.set(conditionalTool.name, {
        ...conditionalTool,
        ...(conditionalTool.wiringMeta ? { wiringMeta: cloneToolWiringMeta(conditionalTool.wiringMeta) } : {}),
      });
    }
  }

  return [...definitions.values()].sort((left, right) => {
    const scopeWeight = compareScope(left.scope, right.scope);
    return scopeWeight !== 0 ? scopeWeight : left.name.localeCompare(right.name);
  });
}

function compareScope(left: AdminToolHealthView['scope'], right: AdminToolHealthView['scope']): number {
  const weight: Record<AdminToolHealthView['scope'], number> = {
    core: 0,
    extended: 1,
    conditional: 2,
  };
  return weight[left] - weight[right];
}

function resolveToolHealth(
  definition: DerivedToolDefinition,
  serviceById: Map<string, RuntimeServiceHealth>,
  lastFailure: AdminToolFailureEvent | undefined,
): AdminToolHealthView['health'] {
  if (!definition.registered) {
    const serviceBackedStatus = resolveServiceBackedStatus(definition, serviceById);
    if (serviceBackedStatus) {
      return serviceBackedStatus;
    }
    return {
      status: 'unavailable',
      detail: 'Tool is not registered in this runtime.',
    };
  }

  const statuses: Array<{ status: RuntimeServiceHealthStatus; detail: string }> = [];
  if (definition.wiringMeta?.requiredGatewayMethods?.length) {
    const gatewayHealth = serviceById.get('gateway');
    if (gatewayHealth) {
      statuses.push({
        status: gatewayHealth.status === 'not_applicable' ? 'unavailable' : gatewayHealth.status,
        detail: gatewayHealth.detail,
      });
    }
  }

  for (const serviceId of definition.wiringMeta?.requiredServices ?? []) {
    const serviceHealth = serviceById.get(serviceId as RuntimeServiceHealth['serviceId']);
    if (!serviceHealth) continue;
    statuses.push({
      status: serviceHealth.status,
      detail: serviceHealth.detail,
    });
  }

  if (definition.name in VAULT_ACTION_BY_TOOL) {
    const vaultHealth = serviceById.get('vault');
    const requiredAction = VAULT_ACTION_BY_TOOL[definition.name];
    if (vaultHealth?.availableActions && !vaultHealth.availableActions.includes(requiredAction)) {
      statuses.push({
        status: 'unavailable',
        detail: `Vault action "${requiredAction}" is not enabled in this runtime.`,
      });
    }
  }

  const baseStatus = foldStatuses(statuses);
  if (lastFailure && baseStatus.status !== 'unavailable' && baseStatus.status !== 'not_applicable') {
    return {
      status: 'degraded',
      detail: `Last failure: ${lastFailure.message}`,
    };
  }
  return baseStatus;
}

function resolveServiceBackedStatus(
  definition: DerivedToolDefinition,
  serviceById: Map<string, RuntimeServiceHealth>,
): AdminToolHealthView['health'] | null {
  if (definition.name in VAULT_ACTION_BY_TOOL) {
    const vaultHealth = serviceById.get('vault');
    if (!vaultHealth) {
      return {
        status: 'unavailable',
        detail: 'Vault service health is unavailable.',
      };
    }

    const requiredAction = VAULT_ACTION_BY_TOOL[definition.name];
    if (vaultHealth.availableActions && !vaultHealth.availableActions.includes(requiredAction)) {
      return {
        status: 'unavailable',
        detail: `Vault action "${requiredAction}" is not enabled in this runtime.`,
      };
    }

    return {
      status: vaultHealth.status === 'healthy' ? 'unavailable' : vaultHealth.status,
      detail: vaultHealth.detail,
    };
  }

  return null;
}

function foldStatuses(statuses: Array<{ status: RuntimeServiceHealthStatus; detail: string }>): AdminToolHealthView['health'] {
  let resolved: AdminToolHealthView['health'] = {
    status: 'healthy',
    detail: 'Runtime dependencies are available.',
  };

  for (const status of statuses) {
    if (statusPriority(status.status) > statusPriority(resolved.status)) {
      resolved = {
        status: status.status,
        detail: status.detail,
      };
    }
  }

  return resolved;
}

function statusPriority(status: RuntimeServiceHealthStatus): number {
  switch (status) {
    case 'unavailable':
      return 4;
    case 'degraded':
      return 3;
    case 'not_applicable':
      return 2;
    case 'healthy':
    default:
      return 1;
  }
}

function resolveContextAvailability(
  definition: DerivedToolDefinition,
  healthStatus: RuntimeServiceHealthStatus,
  activeSource: string | undefined,
  context: 'chat' | 'internalHeartbeat',
): AdminToolHealthView['contexts']['chat'] {
  if (healthStatus === 'unavailable') {
    return {
      status: 'unavailable',
      detail: 'Runtime dependency is unavailable.',
    };
  }

  if (healthStatus === 'not_applicable') {
    return {
      status: 'not_applicable',
      detail: 'Tool is not enabled in this runtime.',
    };
  }

  const eligibility = definition.wiringMeta?.concurrency?.eligibility;
  if (context === 'chat') {
    if (eligibility && !eligibility.foreground) {
      return {
        status: 'not_applicable',
        detail: 'Background-only tool; not available during direct turns.',
      };
    }
  } else if (eligibility && !eligibility.background) {
    return {
      status: 'not_applicable',
      detail: 'Foreground-only tool; not available during internal heartbeat turns.',
    };
  }

  if (context === 'internalHeartbeat') {
    if (definition.wiringMeta?.contextRestrictions?.disallowInternal) {
      return {
        status: 'not_applicable',
        detail: 'Blocked on internal channels.',
      };
    }
    if (definition.wiringMeta?.contextRestrictions?.disallowScheduled) {
      return {
        status: 'not_applicable',
        detail: 'Blocked during scheduled turns.',
      };
    }
  }

  if (activeSource) {
    return {
      status: 'active',
      detail: describeActiveSource(activeSource),
      source: activeSource,
    };
  }

  if (definition.scope === 'core') {
    return {
      status: 'available',
      detail: 'Core tool is ready.',
    };
  }

  if (!definition.registered) {
    return {
      status: 'unavailable',
      detail: 'Tool is not registered in this runtime.',
    };
  }

  return {
    status: 'available',
    detail: 'Extended tool can be loaded on demand.',
  };
}

function describeActiveSource(source: string): string {
  switch (source) {
    case 'core':
      return 'Core tool currently active.';
    case 'promoted':
      return 'Promoted tool currently active.';
    case 'autoload':
      return 'Autoloaded tool currently active.';
    case 'extended_loaded':
      return 'Loaded via load_tools and currently active.';
    case 'deferred':
      return 'Deferred tool currently active.';
    default:
      return 'Tool currently active.';
  }
}
