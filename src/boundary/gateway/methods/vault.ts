import { JSONRPCErrorException } from 'json-rpc-2.0';
import type {
  VaultDailyParams,
  VaultReadParams,
  VaultSearchParams,
  VaultWriteMode,
  VaultWriteParams,
} from '../protocol.js';
import { GatewayErrors } from '../protocol.js';
import type { GatedMethodDescriptor, GatewayMethodRuntime } from './types.js';
import { registerGatedDescriptors } from './register.js';

const VALID_WRITE_MODES = new Set<VaultWriteMode>(['create', 'append', 'prepend']);

function ensureNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new JSONRPCErrorException(
      `vault.${field} must be a non-empty string`,
      GatewayErrors.POLICY_DENIED,
    );
  }
  return value;
}

function getVaultOps(runtime: GatewayMethodRuntime) {
  const ops = runtime.policyConfig.vault?.ops;
  if (!ops) {
    throw new Error('Vault operations are not configured on the gateway');
  }
  return ops;
}

const vaultDescriptors: Array<GatedMethodDescriptor<any, unknown>> = [
  {
    name: 'vault.write',
    handler: async (params: VaultWriteParams, runtime) => {
      const name = ensureNonEmptyString(params.name, 'write.name');
      const content = ensureNonEmptyString(params.content, 'write.content');
      const mode = params.mode ?? 'create';
      if (!VALID_WRITE_MODES.has(mode)) {
        throw new JSONRPCErrorException(
          `vault.write mode must be one of: ${[...VALID_WRITE_MODES].join(', ')}`,
          GatewayErrors.POLICY_DENIED,
        );
      }
      const folder = params.folder === undefined
        ? undefined
        : ensureNonEmptyString(params.folder, 'write.folder');
      return await getVaultOps(runtime).write(name, content, { folder, mode });
    },
    summary: (params: VaultWriteParams) => ({
      name: params.name,
      mode: params.mode ?? 'create',
      folder: params.folder,
      contentLength: typeof params.content === 'string' ? params.content.length : 0,
    }),
    approvalAction: 'vault.write',
    approvalScope: (params: VaultWriteParams) =>
      typeof params.name === 'string' && params.name.trim().length > 0
        ? params.name
        : 'vault',
  },
  {
    name: 'vault.read',
    handler: async (params: VaultReadParams, runtime) => {
      const name = ensureNonEmptyString(params.name, 'read.name');
      return await getVaultOps(runtime).read(name);
    },
    summary: (params: VaultReadParams) => ({ name: params.name }),
    approvalAction: 'vault.read',
    approvalScope: (params: VaultReadParams) =>
      typeof params.name === 'string' && params.name.trim().length > 0
        ? params.name
        : 'vault',
  },
  {
    name: 'vault.search',
    handler: async (params: VaultSearchParams, runtime) => {
      const query = ensureNonEmptyString(params.query, 'search.query');
      const limit = params.limit;
      if (
        limit !== undefined
        && (
          !Number.isFinite(limit)
          || Math.floor(limit) < 1
          || limit > 100
        )
      ) {
        throw new JSONRPCErrorException(
          'vault.search limit must be a number between 1 and 100',
          GatewayErrors.POLICY_DENIED,
        );
      }
      return await getVaultOps(runtime).search(
        query,
        typeof limit === 'number' ? Math.floor(limit) : undefined,
      );
    },
    summary: (params: VaultSearchParams) => ({
      queryLength: typeof params.query === 'string' ? params.query.length : 0,
      limit: params.limit,
    }),
    approvalAction: 'vault.search',
    approvalScope: (_params: VaultSearchParams) => 'vault',
  },
  {
    name: 'vault.daily',
    handler: async (params: VaultDailyParams, runtime) => {
      const content = params.content;
      if (content !== undefined && typeof content !== 'string') {
        throw new JSONRPCErrorException(
          'vault.daily content must be a string',
          GatewayErrors.POLICY_DENIED,
        );
      }
      return await getVaultOps(runtime).daily(
        typeof content === 'string'
          ? { content }
          : undefined,
      );
    },
    summary: (params: VaultDailyParams) => ({
      hasContent: typeof params.content === 'string' && params.content.length > 0,
      contentLength: typeof params.content === 'string' ? params.content.length : 0,
    }),
    approvalAction: 'vault.daily',
    approvalScope: (_params: VaultDailyParams) => 'vault-daily',
  },
];

export function registerVaultMethods(runtime: GatewayMethodRuntime): void {
  if (runtime.policyConfig.vault?.enabled && !runtime.policyConfig.vault.ops) {
    throw new Error(
      'Vault policy is enabled but gateway vault operations are not configured.',
    );
  }
  registerGatedDescriptors(runtime, vaultDescriptors);
}
