import type { SubstrateConfig } from '../../types.js';
import type { RuntimeHealthResult } from '../../gateway/protocol.js';
import type {
  RuntimeServiceHealth,
  RuntimeServiceHealthSnapshot,
} from '../../tool-health/types.js';
import { toErrorMessage } from '../../shared/utils/errors.js';

const ALL_VAULT_ACTIONS = ['write', 'read', 'search', 'daily'] as const;

export interface AdminToolHealthProvider {
  getRuntimeServiceHealth(): Promise<RuntimeServiceHealthSnapshot>;
}

export interface GatewayRuntimeHealthClient {
  runtimeHealth(): Promise<RuntimeHealthResult>;
}

export function createLocalAdminToolHealthProvider(
  config: Pick<SubstrateConfig, 'obsidianVaultName'>,
  env: NodeJS.ProcessEnv = process.env,
): AdminToolHealthProvider {
  return {
    async getRuntimeServiceHealth(): Promise<RuntimeServiceHealthSnapshot> {
      const checkedAt = Date.now();
      const ntfyBaseUrl = env.NTFY_BASE_URL?.trim() || '';
      const ntfyTopic = env.NTFY_TOPIC?.trim() || '';
      const vaultName = config.obsidianVaultName?.trim() || '';

      return {
        checkedAt,
        services: [
          {
            serviceId: 'gateway',
            status: 'not_applicable',
            detail: 'Single-process runtime does not use gateway RPC.',
            checkedAt,
          },
          resolveLocalNtfyHealth(checkedAt, ntfyBaseUrl, ntfyTopic),
          vaultName
            ? {
              serviceId: 'vault',
              status: 'healthy',
              detail: `Local vault tools are configured for "${vaultName}".`,
              checkedAt,
              availableActions: [...ALL_VAULT_ACTIONS],
            }
            : {
              serviceId: 'vault',
              status: 'not_applicable',
              detail: 'Vault tools are disabled in this runtime.',
              checkedAt,
            },
        ],
      };
    },
  };
}

export function createGatewayAdminToolHealthProvider(
  gateway: GatewayRuntimeHealthClient,
): AdminToolHealthProvider {
  return {
    async getRuntimeServiceHealth(): Promise<RuntimeServiceHealthSnapshot> {
      try {
        return await gateway.runtimeHealth();
      } catch (error) {
        const checkedAt = Date.now();
        const message = toErrorMessage(error);
        const gatewayFailure: RuntimeServiceHealth = {
          serviceId: 'gateway',
          status: 'unavailable',
          detail: `Gateway runtime health RPC failed: ${message}`,
          checkedAt,
          lastFailure: {
            message,
            at: checkedAt,
            scope: 'runtime.health',
          },
        };
        return {
          checkedAt,
          services: [
            gatewayFailure,
            {
              serviceId: 'vault',
              status: 'unavailable',
              detail: 'Gateway runtime health is unavailable; vault status is unknown.',
              checkedAt,
            },
            {
              serviceId: 'ntfy',
              status: 'unavailable',
              detail: 'Gateway runtime health is unavailable; ntfy status is unknown.',
              checkedAt,
            },
          ],
        };
      }
    },
  };
}

function resolveLocalNtfyHealth(
  checkedAt: number,
  baseUrl: string,
  topic: string,
): RuntimeServiceHealth {
  if (baseUrl && topic) {
    return {
      serviceId: 'ntfy',
      status: 'healthy',
      detail: 'Local ntfy notifier is configured.',
      checkedAt,
    };
  }

  if (baseUrl || topic) {
    return {
      serviceId: 'ntfy',
      status: 'unavailable',
      detail: 'Local ntfy notifier is misconfigured: both NTFY_BASE_URL and NTFY_TOPIC are required.',
      checkedAt,
    };
  }

  return {
    serviceId: 'ntfy',
    status: 'unavailable',
    detail: 'Local ntfy notifier is not configured.',
    checkedAt,
  };
}
