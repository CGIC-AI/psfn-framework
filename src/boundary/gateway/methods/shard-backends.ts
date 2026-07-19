import { JSONRPCErrorException } from 'json-rpc-2.0';
import type {
  ShardBackendRequestBackend,
  ShardBackendRequestParams,
  ShardBackendRequestResult,
} from '../protocol.js';
import { GatewayErrors } from '../protocol.js';
import type { GatewayMethodRuntime, GatedMethodDescriptor } from './types.js';
import { registerGatedDescriptors } from './register.js';
import { createComponentLogger } from '../../../shared/logger.js';
import {
  deriveShardCapabilityGrantFromSnapshot,
  type DerivedShardCapabilityGrant,
} from '../../../system/capabilities/shard-derivation.js';

const log = createComponentLogger('GatewayShardBackends');

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

function normalizeGrantAssertion(value: unknown, field: 'ownerVersion' | 'grantDigest'): string {
  const normalized = normalizeRequiredText(value, field);
  if (normalized !== value || !/^[0-9a-f]{64}$/.test(normalized)) {
    deny(`shard.backend.request ${field} must be a lowercase SHA-256 digest`);
  }
  return normalized;
}

function requireAuthenticatedCompanionId(runtime: GatewayMethodRuntime): string {
  const companionId = runtime.authenticatedCompanionId();
  if (typeof companionId !== 'string' || !companionId.trim() || companionId !== companionId.trim()) {
    deny(
      'Shard backend admission requires an authenticated companion identity '
      + '(fail closed).',
    );
  }
  return companionId;
}

function resolveAuthoritativeGrant(
  runtime: GatewayMethodRuntime,
  companionId: string,
  stage: 'admission' | 'pre-execution',
  request: {
    readonly backend: ShardBackendRequestBackend;
    readonly name: string;
    readonly shardId: string;
  },
): DerivedShardCapabilityGrant {
  const snapshotProvider = runtime.capabilityGrantSnapshotProvider;
  if (!snapshotProvider) {
    deny(
      `Shard backend "${request.backend}" for "${request.name}" (${request.shardId}) cannot be `
      + 'authorized: the gateway capability grant snapshot provider is unavailable '
      + '(fail closed).',
    );
  }

  try {
    const snapshot = snapshotProvider();
    return deriveShardCapabilityGrantFromSnapshot(companionId, snapshot);
  } catch (error) {
    log.error(
      `Capability grant snapshot failed during shard backend ${stage}; refusing (fail closed)`,
      {
        backend: request.backend,
        name: request.name,
        shardId: request.shardId,
        companionId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    deny(
      `Shard backend "${request.backend}" for "${request.name}" (${request.shardId}) cannot be `
      + `authorized: the gateway capability grant could not be resolved during ${stage} `
      + '(fail closed).',
    );
  }
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
      runtime: GatewayMethodRuntime,
    ): Promise<ShardBackendRequestResult> => {
      const backend = normalizeBackend(params.backend);
      const shardId = normalizeRequiredText(params.shardId, 'shardId');
      const name = normalizeRequiredText(params.name, 'name');
      const ownerVersion = normalizeGrantAssertion(params.ownerVersion, 'ownerVersion');
      const grantDigest = normalizeGrantAssertion(params.grantDigest, 'grantDigest');
      const companionId = requireAuthenticatedCompanionId(runtime);
      const request = { backend, shardId, name };

      // One authoritative owner read drives the tier gate, shard.spawn check,
      // derived access, owner version, and digest. Caller tier/token fields are
      // neither read nor represented in the protocol.
      const admittedGrant = resolveAuthoritativeGrant(
        runtime,
        companionId,
        'admission',
        request,
      );
      const capabilityTier = admittedGrant.parent.tier;

      if (!AUTONOMOUS_SHARD_BACKEND_TIERS.has(capabilityTier)) {
        deny(
          `Shard backend "${backend}" for "${name}" (${shardId}) requires autonomous or custom `
          + `capability tier (current: "${capabilityTier}").`,
        );
      }
      if (!admittedGrant.parent.tokens.includes('shard.spawn')) {
        deny(
          `Shard backend "${backend}" for "${name}" (${shardId}) requires authoritative `
          + 'parent capability "shard.spawn".',
        );
      }
      if (
        admittedGrant.ownerVersion !== ownerVersion
        || admittedGrant.grantDigest !== grantDigest
      ) {
        deny(
          `Shard backend "${backend}" for "${name}" (${shardId}) manager-bound capability `
          + 'grant does not match current gateway authority (fail closed).',
        );
      }

      const authorizedContext = Object.freeze({
        backend,
        shardId,
        name,
        parentCompanionId: companionId,
        parentTier: admittedGrant.parent.tier,
        ownerVersion: admittedGrant.ownerVersion,
        grantDigest: admittedGrant.grantDigest,
        access: admittedGrant.access,
      });

      // Executor-bound TOCTOU closure: take one new atomic owner snapshot and
      // require the same owner version immediately before any executor call.
      // The already-admitted immutable access remains the execution authority.
      const currentGrant = resolveAuthoritativeGrant(
        runtime,
        companionId,
        'pre-execution',
        request,
      );
      if (currentGrant.ownerVersion !== authorizedContext.ownerVersion) {
        deny(
          `Shard backend "${backend}" for "${name}" (${shardId}) capability owner changed `
          + 'after admission; refusing before backend execution (fail closed).',
        );
      }

      if (runtime.shardBackendExecutor) {
        return await runtime.shardBackendExecutor(authorizedContext);
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
      ownerVersion: params.ownerVersion,
      grantDigest: params.grantDigest,
    }),
    approvalAction: 'shard.backend.request',
    approvalScope: (params: ShardBackendRequestParams) => `${params.backend}:${params.name}`,
  },
];

export function registerShardBackendMethods(runtime: GatewayMethodRuntime): void {
  registerGatedDescriptors(runtime, shardBackendDescriptors);
}
