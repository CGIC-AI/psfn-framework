import { JSONRPCErrorException } from 'json-rpc-2.0';
import type { VaultPolicyAction } from './policy.js';
import { GatewayErrors } from './protocol.js';
import type {
  RuntimeServiceFailure,
  RuntimeServiceHealth,
  RuntimeServiceHealthSnapshot,
} from '../../operator/tool-health/types.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import type { McpGatewayBroker } from './mcp/broker.js';

type GatewayTrackedMethod =
  | 'notify.ntfy'
  | 'vault.write'
  | 'vault.read'
  | 'vault.search'
  | 'vault.daily'
  | 'mcp.execute';

export interface GatewayConnectionSummary {
  total: number;
  registering: number;
  ready: number;
  degraded: number;
  offline: number;
}

export interface GatewayRuntimeHealthOptions {
  ntfyConfigured: boolean;
  vaultEnabled: boolean;
  vaultAllowActions: readonly VaultPolicyAction[];
  vaultOpsConfigured: boolean;
  mcpBroker?: McpGatewayBroker;
}

interface MethodHealthState {
  lastSuccessAt?: number;
  lastFailure?: RuntimeServiceFailure;
}

const TRACKED_METHODS = new Set<GatewayTrackedMethod>([
  'notify.ntfy',
  'vault.write',
  'vault.read',
  'vault.search',
  'vault.daily',
  'mcp.execute',
]);

export class GatewayRuntimeHealthTracker {
  private readonly ntfyConfigured: boolean;
  private readonly vaultEnabled: boolean;
  private readonly vaultAllowActions: readonly VaultPolicyAction[];
  private readonly vaultOpsConfigured: boolean;
  private readonly mcpBroker: McpGatewayBroker | undefined;
  private readonly methodState = new Map<GatewayTrackedMethod, MethodHealthState>();

  constructor(options: GatewayRuntimeHealthOptions) {
    this.ntfyConfigured = options.ntfyConfigured;
    this.vaultEnabled = options.vaultEnabled;
    this.vaultAllowActions = [...options.vaultAllowActions];
    this.vaultOpsConfigured = options.vaultOpsConfigured;
    this.mcpBroker = options.mcpBroker;
  }

  recordMethodSuccess(method: string): void {
    if (!TRACKED_METHODS.has(method as GatewayTrackedMethod)) return;
    const trackedMethod = method as GatewayTrackedMethod;
    const state = this.methodState.get(trackedMethod) ?? {};
    this.methodState.set(trackedMethod, {
      ...state,
      lastSuccessAt: Date.now(),
    });
  }

  recordMethodFailure(method: string, error: unknown): void {
    if (!TRACKED_METHODS.has(method as GatewayTrackedMethod)) return;
    if (shouldIgnoreGatewayFailure(error)) return;

    const trackedMethod = method as GatewayTrackedMethod;
    const state = this.methodState.get(trackedMethod) ?? {};
    this.methodState.set(trackedMethod, {
      ...state,
      lastFailure: {
        message: toErrorMessage(error),
        at: Date.now(),
        scope: trackedMethod,
      },
    });
  }

  getSnapshot(
    connectionSummary: GatewayConnectionSummary,
    companionId?: string,
  ): RuntimeServiceHealthSnapshot {
    const checkedAt = Date.now();
    return {
      checkedAt,
      services: [
        this.buildGatewayServiceHealth(connectionSummary, checkedAt),
        this.buildNtfyServiceHealth(checkedAt),
        this.buildVaultServiceHealth(checkedAt),
        this.buildMcpServiceHealth(checkedAt, companionId),
      ],
    };
  }

  private buildGatewayServiceHealth(
    connectionSummary: GatewayConnectionSummary,
    checkedAt: number,
  ): RuntimeServiceHealth {
    const { total, ready, degraded, offline, registering } = connectionSummary;
    if (ready > 0 && degraded === 0 && offline === 0) {
      return {
        serviceId: 'gateway',
        status: 'healthy',
        detail: `Gateway ready (${ready}/${total || ready} active connection${ready === 1 ? '' : 's'}).`,
        checkedAt,
      };
    }

    if (ready > 0 || degraded > 0 || registering > 0 || offline > 0) {
      return {
        serviceId: 'gateway',
        status: 'degraded',
        detail: `Gateway connections: ready=${ready}, degraded=${degraded}, registering=${registering}, offline=${offline}.`,
        checkedAt,
      };
    }

    return {
      serviceId: 'gateway',
      status: 'unavailable',
      detail: 'Gateway has no active agent connections.',
      checkedAt,
    };
  }

  private buildNtfyServiceHealth(checkedAt: number): RuntimeServiceHealth {
    if (!this.ntfyConfigured) {
      return {
        serviceId: 'ntfy',
        status: 'unavailable',
        detail: 'Gateway ntfy notifier is not configured.',
        checkedAt,
      };
    }

    const methodState = this.methodState.get('notify.ntfy');
    if (hasUnresolvedFailure(methodState)) {
      return {
        serviceId: 'ntfy',
        status: 'degraded',
        detail: `Gateway ntfy notifier is configured, but the last send failed: ${methodState!.lastFailure!.message}`,
        checkedAt,
        lastFailure: methodState?.lastFailure,
      };
    }

    return {
      serviceId: 'ntfy',
      status: 'healthy',
      detail: 'Gateway ntfy notifier is configured.',
      checkedAt,
    };
  }

  private buildVaultServiceHealth(checkedAt: number): RuntimeServiceHealth {
    if (!this.vaultEnabled) {
      return {
        serviceId: 'vault',
        status: 'not_applicable',
        detail: 'Gateway vault RPC is disabled.',
        checkedAt,
      };
    }

    if (!this.vaultOpsConfigured) {
      return {
        serviceId: 'vault',
        status: 'unavailable',
        detail: 'Gateway vault RPC is enabled but operations are not configured.',
        checkedAt,
        availableActions: [...this.vaultAllowActions],
      };
    }

    const lastFailure = resolveLatestFailure([
      this.methodState.get('vault.write'),
      this.methodState.get('vault.read'),
      this.methodState.get('vault.search'),
      this.methodState.get('vault.daily'),
    ]);

    if (lastFailure) {
      return {
        serviceId: 'vault',
        status: 'degraded',
        detail: `Gateway vault RPC is enabled for ${formatVaultActions(this.vaultAllowActions)}, but the last call failed: ${lastFailure.message}`,
        checkedAt,
        availableActions: [...this.vaultAllowActions],
        lastFailure,
      };
    }

    return {
      serviceId: 'vault',
      status: 'healthy',
      detail: `Gateway vault RPC is enabled for ${formatVaultActions(this.vaultAllowActions)}.`,
      checkedAt,
      availableActions: [...this.vaultAllowActions],
    };
  }

  private buildMcpServiceHealth(
    checkedAt: number,
    companionId: string | undefined,
  ): RuntimeServiceHealth {
    if (!this.mcpBroker) {
      return {
        serviceId: 'mcp',
        status: 'not_applicable',
        detail: 'External MCP tooling is disabled.',
        checkedAt,
      };
    }
    const snapshot = this.mcpBroker.health({ ...(companionId ? { companionId } : {}) });
    const lastFailure = hasUnresolvedFailure(this.methodState.get('mcp.execute'))
      ? this.methodState.get('mcp.execute')?.lastFailure
      : undefined;
    return {
      serviceId: 'mcp',
      status: lastFailure ? 'degraded' : 'healthy',
      detail: lastFailure
        ? `External MCP tooling is configured, but the last operation failed: ${lastFailure.message}`
        : `External MCP tooling has ${snapshot.servers.length} configured server${snapshot.servers.length === 1 ? '' : 's'}, ${snapshot.activeSessions} active session${snapshot.activeSessions === 1 ? '' : 's'}, and ${snapshot.cachedStaticMetadataEntries} screened metadata cache entr${snapshot.cachedStaticMetadataEntries === 1 ? 'y' : 'ies'}.`,
      checkedAt,
      availableActions: ['catalog', 'search', 'inspect', 'call', 'release'],
      ...(lastFailure ? { lastFailure } : {}),
      mcp: {
        activeSessions: snapshot.activeSessions,
        cachedStaticMetadataEntries: snapshot.cachedStaticMetadataEntries,
        servers: snapshot.servers,
      },
    };
  }
}

function shouldIgnoreGatewayFailure(error: unknown): boolean {
  if (!(error instanceof JSONRPCErrorException)) return false;
  return error.code === GatewayErrors.POLICY_DENIED
    || error.code === GatewayErrors.NEEDS_APPROVAL
    || error.code === GatewayErrors.APPROVAL_DENIED;
}

function hasUnresolvedFailure(state: MethodHealthState | undefined): boolean {
  if (!state?.lastFailure) return false;
  if (!state.lastSuccessAt) return true;
  return state.lastFailure.at >= state.lastSuccessAt;
}

function resolveLatestFailure(states: Array<MethodHealthState | undefined>): RuntimeServiceFailure | undefined {
  const failures = states
    .filter((state): state is MethodHealthState & { lastFailure: RuntimeServiceFailure } => hasUnresolvedFailure(state))
    .map(state => state.lastFailure);
  if (failures.length === 0) return undefined;
  failures.sort((left, right) => right.at - left.at);
  return failures[0];
}

function formatVaultActions(actions: readonly VaultPolicyAction[]): string {
  if (actions.length === 0) return 'no actions';
  return actions.join(', ');
}
