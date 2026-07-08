import { basename, isAbsolute, relative } from 'node:path';
import { createComponentLogger } from '../../shared/logger.js';
import type { BeadsAction, PolicyContext, PolicyDecision } from './protocol.js';
import type { VaultOperations } from '../integrations/vault/ops.js';
import type { ShellExecPolicyConfig } from '../sandbox/execution/shell-policy-config.js';

const log = createComponentLogger('Policy');
import { evaluateUrlPolicy, type UrlPolicyConfig, type UrlPolicyLane } from './url-policy.js';
import {
  normalizeWorkspaceRelativeGlob,
  resolveCanonicalPath,
  resolveWorkspaceFsPathFromRoot,
  resolveWorkspaceRoot,
} from './filesystem-paths.js';

export interface BeadsPolicyConfig {
  enabled?: boolean;
  allowActions?: BeadsAction[];
}

export interface HomeAssistantPolicyConfig {
  enabled?: boolean;
  baseUrl?: string;
  tokenConfigured?: boolean;
}

export type VaultPolicyAction = 'write' | 'read' | 'search' | 'daily';

export interface VaultPolicyConfig {
  enabled?: boolean;
  allowActions?: VaultPolicyAction[];
  /**
   * Gateway-side runtime dependency for dedicated vault RPC operations.
   * Kept optional so policy-only checks remain pure in tests.
   */
  ops?: VaultOperations;
}

export interface PolicyConfig {
  workspacePath: string;
  allowedReadPaths?: string[];
  protectedWritePaths?: string[];
  fullCodebaseReadRoot?: string;
  urlPolicy?: UrlPolicyConfig;
  webFetchTlsCaCertPaths?: string[];
  shellExec?: ShellExecPolicyConfig;
  beads?: BeadsPolicyConfig;
  homeAssistant?: HomeAssistantPolicyConfig;
  vault?: VaultPolicyConfig;
}

export type ShardSessionMemorySyncClass = 'transcript_fact' | 'derived_memory' | 'runtime_state';
export type ShardSessionMemorySyncDirection = 'prime_to_shard' | 'shard_to_prime';
export type ShardSessionMemorySyncAuthority = 'prime' | 'shard' | 'runtime';
export type ShardSessionMemorySyncOperation =
  | 'context_pack_session'
  | 'context_pack_memory'
  | 'memory_write'
  | 'memory_import_batch'
  | 'memory_redact';

export interface ShardSessionMemorySyncEnvelope {
  version: number;
  syncClass: ShardSessionMemorySyncClass;
  direction: ShardSessionMemorySyncDirection;
  authority: ShardSessionMemorySyncAuthority;
  operation: ShardSessionMemorySyncOperation;
  shardId: string;
  sourceId: string;
  targetId: string;
  idempotencyKey: string;
  requestedAt: number;
}

export type ShardSessionMemorySyncDecisionReason =
  | 'allowed_prime_transcript_fact'
  | 'allowed_prime_memory_seed'
  | 'allowed_shard_memory_write'
  | 'denied_invalid_envelope'
  | 'denied_runtime_state_sync'
  | 'denied_direction_class'
  | 'denied_authority'
  | 'denied_operation';

export interface ShardSessionMemorySyncDecision {
  allowed: boolean;
  reason: ShardSessionMemorySyncDecisionReason;
}

const BEADS_ACTION_BY_METHOD: Readonly<Record<string, BeadsAction>> = {
  'beads.ready': 'ready',
  'beads.show': 'show',
  'beads.create': 'create',
  'beads.update': 'update',
  'beads.close': 'close',
  'beads.sync': 'sync',
};

const VAULT_ACTION_BY_METHOD: Readonly<Record<string, VaultPolicyAction>> = {
  'vault.write': 'write',
  'vault.read': 'read',
  'vault.search': 'search',
  'vault.daily': 'daily',
};

function normalizeWebLane(value: unknown): UrlPolicyLane | null {
  if (value === undefined || value === null || value === '' || value === 'default') return 'default';
  if (value === 'local_crawler') return 'local_crawler';
  if (value === 'discovery') return 'discovery';
  return null;
}

function shellAllowlistIncludesCommand(allowlist: readonly string[] | undefined, command: string): boolean {
  if (!allowlist || allowlist.length === 0) return false;
  const expected = command.trim().toLowerCase();
  if (!expected) return false;
  return allowlist.some((entry) => {
    const trimmed = entry.trim().toLowerCase();
    return trimmed === expected || basename(trimmed) === expected;
  });
}

function isPositiveIntegerInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Math.floor(value) === value
    && value >= min
    && value <= max;
}

/** Check whether a resolved path falls inside any of the allowed prefixes */
export function isInsideAllowedPaths(resolvedPath: string, allowedPrefixes: string[]): boolean {
  for (const prefix of allowedPrefixes) {
    const relativePath = relative(prefix, resolvedPath);
    if (
      relativePath === ''
      || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
    ) {
      return true;
    }
  }
  return false;
}

function resolvePolicyCanonicalPath(normalizedPath: string, isWrite: boolean): string | null {
  return resolveCanonicalPath(normalizedPath, {
    missingPathBehavior: isWrite ? 'resolveParent' : 'returnNormalized',
    errorBehavior: 'deny',
    onParentResolutionError: ({ path, error }) => {
      log.debug('resolveCanonicalPath: parent resolution failed', {
        path,
        error: String(error),
      });
    },
  });
}

const PRIME_TO_SHARD_SYNC_OPERATIONS: Readonly<Record<ShardSessionMemorySyncClass, readonly ShardSessionMemorySyncOperation[]>> = {
  transcript_fact: ['context_pack_session'],
  derived_memory: ['context_pack_memory'],
  runtime_state: [],
};

const SHARD_TO_PRIME_SYNC_OPERATIONS: Readonly<Record<ShardSessionMemorySyncClass, readonly ShardSessionMemorySyncOperation[]>> = {
  transcript_fact: [],
  derived_memory: ['memory_write'],
  runtime_state: [],
};

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isWorkspaceRelativeDirectoryPath(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return false;
  }
  const normalizedPath = normalizeWorkspaceRelativeGlob(value.trim());
  return normalizedPath !== null && !/[*?[\]{}]/.test(normalizedPath);
}

export function evaluateShardSessionMemorySyncPolicy(
  envelope: ShardSessionMemorySyncEnvelope,
): ShardSessionMemorySyncDecision {
  if (
    envelope.version !== 1
    || !Number.isFinite(envelope.requestedAt)
    || envelope.requestedAt <= 0
    || !hasText(envelope.shardId)
    || !hasText(envelope.sourceId)
    || !hasText(envelope.targetId)
    || !hasText(envelope.idempotencyKey)
    || envelope.idempotencyKey.trim().length > 200
  ) {
    return { allowed: false, reason: 'denied_invalid_envelope' };
  }

  if (envelope.syncClass === 'runtime_state') {
    return { allowed: false, reason: 'denied_runtime_state_sync' };
  }

  const allowedOperations = envelope.direction === 'prime_to_shard'
    ? PRIME_TO_SHARD_SYNC_OPERATIONS[envelope.syncClass]
    : SHARD_TO_PRIME_SYNC_OPERATIONS[envelope.syncClass];
  if (allowedOperations.length === 0) {
    return { allowed: false, reason: 'denied_direction_class' };
  }

  if (envelope.direction === 'prime_to_shard' && envelope.authority !== 'prime') {
    return { allowed: false, reason: 'denied_authority' };
  }
  if (envelope.direction === 'shard_to_prime' && envelope.authority !== 'shard') {
    return { allowed: false, reason: 'denied_authority' };
  }

  if (!allowedOperations.includes(envelope.operation)) {
    return { allowed: false, reason: 'denied_operation' };
  }

  if (envelope.operation === 'context_pack_session') {
    return { allowed: true, reason: 'allowed_prime_transcript_fact' };
  }
  if (envelope.operation === 'context_pack_memory') {
    return { allowed: true, reason: 'allowed_prime_memory_seed' };
  }
  if (envelope.operation === 'memory_write') {
    return { allowed: true, reason: 'allowed_shard_memory_write' };
  }
  return { allowed: false, reason: 'denied_operation' };
}

export function evaluatePolicy(ctx: PolicyContext, policyConfig: PolicyConfig): PolicyDecision {
  const { method, params } = ctx;

  switch (method) {
    case 'llm.chat':
    case 'llm.complete':
    case 'llm.embed':
    case 'discord.send':
    case 'discord.sendMedia':
    case 'discord.typing':
    case 'notify.ntfy':
      return 'ALLOW';

    case 'web.fetch':
    case 'web.fetch_binary':
    case 'web.request_binary': {
      // Synchronous URL policy check so the audit log reflects the real decision
      const url = (params as Record<string, unknown>).url as string | undefined;
      const laneValue = (params as Record<string, unknown>).lane;
      const lane = normalizeWebLane(laneValue);
      if (!url || typeof url !== 'string') {
        return 'DENY';
      }
      if (!lane) {
        return 'DENY';
      }
      if (!policyConfig.urlPolicy) {
        return 'DENY';
      }
      const urlCheck = evaluateUrlPolicy(url, policyConfig.urlPolicy, lane);
      if (!urlCheck.allowed) {
        return 'DENY';
      }
      return 'ALLOW';
    }

    case 'shell.exec': {
      if (!policyConfig.shellExec?.enabled) {
        return 'DENY';
      }
      return 'ALLOW';
    }

    case 'shard.backend.request': {
      const backend = (params as Record<string, unknown>).backend;
      if (backend !== 'container' && backend !== 'orchestrated') {
        return 'DENY';
      }
      if (!policyConfig.shellExec?.enabled) {
        return 'DENY';
      }
      const requiredCommand = backend === 'container' ? 'docker' : 'kubectl';
      if (!shellAllowlistIncludesCommand(policyConfig.shellExec.allowlist, requiredCommand)) {
        return 'DENY';
      }
      return 'ALLOW';
    }

    case 'beads.ready':
    case 'beads.show':
    case 'beads.create':
    case 'beads.update':
    case 'beads.close':
    case 'beads.sync': {
      const beadsPolicy = policyConfig.beads;
      if (!beadsPolicy?.enabled) {
        return 'DENY';
      }
      const action = BEADS_ACTION_BY_METHOD[method];
      const allowedActions = new Set(beadsPolicy.allowActions ?? []);
      if (!allowedActions.has(action)) {
        return 'DENY';
      }
      return 'ALLOW';
    }

    case 'image.create':
    case 'image.edit':
      return 'ALLOW';

    case 'home_assistant.get_states':
    case 'home_assistant.check_connection':
      return 'ALLOW';

    case 'home_assistant.call_service': {
      const ha = policyConfig.homeAssistant;
      return ha?.enabled === true && Boolean(ha.baseUrl?.trim()) && ha.tokenConfigured === true
        ? 'NEEDS_APPROVAL'
        : 'ALLOW';
    }

    case 'vault.write':
    case 'vault.read':
    case 'vault.search':
    case 'vault.daily': {
      const vaultPolicy = policyConfig.vault;
      if (!vaultPolicy?.enabled) {
        return 'DENY';
      }
      const action = VAULT_ACTION_BY_METHOD[method];
      const allowedActions = new Set(vaultPolicy.allowActions ?? []);
      if (!allowedActions.has(action)) {
        return 'DENY';
      }
      return 'ALLOW';
    }

    case 'fs.read':
    case 'fs.write': {
      const path = (params as Record<string, unknown>).path;
      if (typeof path !== 'string' || path.trim().length === 0) {
        return 'DENY';
      }

      const workspaceRoot = resolveWorkspaceRoot(policyConfig.workspacePath);
      const normalizedPath = resolveWorkspaceFsPathFromRoot(path, workspaceRoot);

      // Build list of all allowed prefixes for this operation
      const allowedPrefixes = [workspaceRoot];
      if (method === 'fs.read') {
        if (policyConfig.allowedReadPaths) {
          for (const allowed of policyConfig.allowedReadPaths) {
            allowedPrefixes.push(resolveWorkspaceFsPathFromRoot(allowed, workspaceRoot));
          }
        }
        if (policyConfig.fullCodebaseReadRoot) {
          allowedPrefixes.push(
            resolveWorkspaceFsPathFromRoot(policyConfig.fullCodebaseReadRoot, workspaceRoot),
          );
        }
      } else if (policyConfig.protectedWritePaths) {
        const protectedPrefixes = policyConfig.protectedWritePaths.map((blockedPath) =>
          resolveWorkspaceFsPathFromRoot(blockedPath, workspaceRoot),
        );
        if (isInsideAllowedPaths(normalizedPath, protectedPrefixes)) {
          return 'DENY';
        }
      }

      // Step 1: Check normalized path (string prefix match)
      if (!isInsideAllowedPaths(normalizedPath, allowedPrefixes)) {
        return 'NEEDS_APPROVAL';
      }

      // Step 2: Resolve symlinks and check canonical path
      const isWrite = method === 'fs.write';
      const canonical = resolvePolicyCanonicalPath(normalizedPath, isWrite);

      // null = resolution failed (ELOOP, EACCES, etc.) — deny access
      if (canonical === null) {
        return 'DENY';
      }

      if (isWrite && policyConfig.protectedWritePaths) {
        const protectedPrefixes = policyConfig.protectedWritePaths.map((blockedPath) =>
          resolveWorkspaceFsPathFromRoot(blockedPath, workspaceRoot),
        );
        if (isInsideAllowedPaths(canonical, protectedPrefixes)) {
          return 'DENY';
        }
      }

      // If canonical differs from normalized (symlink), re-check against allowed prefixes
      if (canonical !== normalizedPath && !isInsideAllowedPaths(canonical, allowedPrefixes)) {
        return 'DENY';
      }

      return 'ALLOW';
    }

    case 'fs.list': {
      const paramsRecord = params as Record<string, unknown>;
      const path = paramsRecord.path;
      const glob = paramsRecord.glob;
      if (!isWorkspaceRelativeDirectoryPath(path)) {
        return 'DENY';
      }
      if (glob !== undefined && typeof glob !== 'string') {
        return 'DENY';
      }
      if (!normalizeWorkspaceRelativeGlob(glob as string | undefined)) {
        return 'DENY';
      }

      const maxEntries = (params as Record<string, unknown>).maxEntries;
      if (maxEntries !== undefined && !isPositiveIntegerInRange(maxEntries, 1, 500)) {
        return 'DENY';
      }

      const maxScannedEntries = (params as Record<string, unknown>).maxScannedEntries;
      if (maxScannedEntries !== undefined && !isPositiveIntegerInRange(maxScannedEntries, 1, 20_000)) {
        return 'DENY';
      }

      return 'ALLOW';
    }

    case 'fs.search': {
      const query = (params as Record<string, unknown>).query;
      const glob = (params as Record<string, unknown>).glob;
      const contextLines = (params as Record<string, unknown>).contextLines;
      const maxMatches = (params as Record<string, unknown>).maxMatches;
      const maxFiles = (params as Record<string, unknown>).maxFiles;
      const maxBytesPerFile = (params as Record<string, unknown>).maxBytesPerFile;

      if (typeof query !== 'string' || query.trim().length === 0) {
        return 'DENY';
      }
      if (glob !== undefined && (typeof glob !== 'string' || !normalizeWorkspaceRelativeGlob(glob))) {
        return 'DENY';
      }
      if (contextLines !== undefined && !isPositiveIntegerInRange(contextLines, 0, 2)) {
        return 'DENY';
      }
      if (maxMatches !== undefined && !isPositiveIntegerInRange(maxMatches, 1, 500)) {
        return 'DENY';
      }
      if (maxFiles !== undefined && !isPositiveIntegerInRange(maxFiles, 1, 500)) {
        return 'DENY';
      }
      if (maxBytesPerFile !== undefined && !isPositiveIntegerInRange(maxBytesPerFile, 1, 1_000_000)) {
        return 'DENY';
      }
      return 'ALLOW';
    }

    case 'fs.edit': {
      const path = (params as Record<string, unknown>).path;
      if (typeof path !== 'string' || path.trim().length === 0) {
        return 'DENY';
      }

      const workspaceRoot = resolveWorkspaceRoot(policyConfig.workspacePath);
      const normalizedPath = resolveWorkspaceFsPathFromRoot(path, workspaceRoot);
      if (!isInsideAllowedPaths(normalizedPath, [workspaceRoot])) {
        return 'NEEDS_APPROVAL';
      }

      const canonical = resolvePolicyCanonicalPath(normalizedPath, true);
      if (canonical === null) {
        return 'DENY';
      }
      if (!isInsideAllowedPaths(canonical, [workspaceRoot])) {
        return 'DENY';
      }

      if (policyConfig.protectedWritePaths) {
        const protectedPrefixes = policyConfig.protectedWritePaths.map((blockedPath) =>
          resolveWorkspaceFsPathFromRoot(blockedPath, workspaceRoot),
        );
        if (isInsideAllowedPaths(canonical, protectedPrefixes)) {
          return 'DENY';
        }
      }

      return 'ALLOW';
    }

    // Git read operations — ALLOW (GitOps has its own path allowlisting)
    case 'git.status':
    case 'git.diff':
      return 'ALLOW';

    // Git write operations — require approval gate
    case 'git.create_branch':
    case 'git.apply_patch':
    case 'git.commit':
    case 'git.open_pr':
      return 'NEEDS_APPROVAL';

    default:
      return 'DENY';
  }
}
