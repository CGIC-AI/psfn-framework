import { JSONRPCErrorException } from 'json-rpc-2.0';
import type {
  ShardBackendRequestBackend,
  ShardBackendRequestParams,
  ShardBackendRequestResult,
} from '../protocol.js';
import { GatewayErrors } from '../protocol.js';
import type { GatewayMethodRuntime, GatedMethodDescriptor } from './types.js';
import { registerGatedDescriptors } from './register.js';
import { normalizeCapabilityTier } from '../../../system/capabilities/tiers.js';

const AUTONOMOUS_SHARD_BACKEND_TIERS = new Set(['autonomous', 'custom']);

function deny(message: string): never {
  throw new JSONRPCErrorException(message, GatewayErrors.POLICY_DENIED);
}

function normalizeRequiredText(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    deny(`shard.backend.request ${field} must be a string`);
  }
  const normalized = value.trim();
  if (!normalized) {
    deny(`shard.backend.request ${field} is required`);
  }
  return normalized;
}

function normalizeBackend(value: unknown): ShardBackendRequestBackend {
  const normalized = normalizeRequiredText(value, 'backend').toLowerCase();
  if (normalized === 'container' || normalized === 'orchestrated') {
    return normalized;
  }
  deny(`Unsupported shard backend "${normalized}"`);
}

function requiredShardBackendCommand(
  backend: ShardBackendRequestBackend,
): 'docker' | 'kubectl' {
  return backend === 'container' ? 'docker' : 'kubectl';
}

const shardBackendDescriptors: Array<GatedMethodDescriptor<any, unknown>> = [
  {
    name: 'shard.backend.request',
    handler: async (
      params: ShardBackendRequestParams,
      _runtime: GatewayMethodRuntime,
    ): Promise<ShardBackendRequestResult> => {
      const backend = normalizeBackend(params.backend);
      const shardId = normalizeRequiredText(params.shardId, 'shardId');
      const name = normalizeRequiredText(params.name, 'name');
      const capabilityTier = normalizeCapabilityTier(params.capabilityTier);

      if (!AUTONOMOUS_SHARD_BACKEND_TIERS.has(capabilityTier)) {
        deny(
          `Shard backend "${backend}" for "${name}" (${shardId}) requires autonomous or custom `
          + `capability tier (current: "${capabilityTier}").`,
        );
      }

      return {
        backend,
        controller: 'gateway',
        status: 'unavailable',
        reason:
          `Gateway mediation accepted shard backend "${backend}" but no `
          + `${requiredShardBackendCommand(backend)}-backed shard executor is wired.`,
      };
    },
    summary: (params: ShardBackendRequestParams) => ({
      shardId: params.shardId,
      name: params.name,
      backend: params.backend,
      capabilityTier: params.capabilityTier,
    }),
    approvalAction: 'shard.backend.request',
    approvalScope: (params: ShardBackendRequestParams) => `${params.backend}:${params.name}`,
  },
];

export function registerShardBackendMethods(runtime: GatewayMethodRuntime): void {
  registerGatedDescriptors(runtime, shardBackendDescriptors);
}
