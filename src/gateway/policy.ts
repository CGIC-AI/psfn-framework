import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { createComponentLogger } from '../logger.js';
import type { BeadsAction, PolicyContext, PolicyDecision } from './protocol.js';
import type { VaultOperations } from '../vault/ops.js';
import type { ShardBackendRequestBackend } from './protocol.js';

const log = createComponentLogger('Policy');
import { evaluateUrlPolicy, type UrlPolicyConfig, type UrlPolicyLane } from './url-policy.js';
import {
  normalizeWorkspaceRelativeGlob,
  resolveWorkspaceFsPathFromRoot,
  resolveWorkspaceRoot,
} from './filesystem-paths.js';

export interface ShellExecPolicyConfig {
  enabled?: boolean;
  allowlist?: string[];
  envAllowlist?: string[];
  allowedCwd?: string[];
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
  defaultMaxOutputChars?: number;
  maxOutputChars?: number;
}

export interface BeadsPolicyConfig {
  enabled?: boolean;
  allowActions?: BeadsAction[];
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
  fullCodebaseReadRoot?: string;
  urlPolicy?: UrlPolicyConfig;
  webFetchTlsCaCertPaths?: string[];
  shellExec?: ShellExecPolicyConfig;
  beads?: BeadsPolicyConfig;
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
  | 'allowed_shard_memory_import'
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

/**
 * Resolve the canonical (symlink-resolved) path for policy checking.
 * Returns the normalized path unchanged if the file doesn't exist (ENOENT).
 * For writes to new files, resolves the parent directory if it exists.
 * Returns null only if a symlink explicitly resolves outside allowed paths.
 */
function resolveCanonicalPath(normalized: string, isWrite: boolean): string | null {
  try {
    return realpathSync(normalized);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT = path doesn't exist at all (not a symlink issue) — safe to use normalized
    if (code === 'ENOENT') {
      // For writes, try to resolve the parent directory to catch symlinked parents
      if (isWrite) {
        try {
          const parentReal = realpathSync(dirname(normalized));
          return resolve(parentReal, basename(normalized));
        } catch (parentErr) {
          // Parent doesn't exist either — use normalized path (will fail at write time)
          log.debug('resolveCanonicalPath: parent resolution failed', { path: normalized, error: String(parentErr) });
          return normalized;
        }
      }
      return normalized;
    }
    // ELOOP, EACCES, or any other error — refuse to resolve (caller should DENY)
    return null;
  }
}

const PRIME_TO_SHARD_SYNC_OPERATIONS: Readonly<Record<ShardSessionMemorySyncClass, readonly ShardSessionMemorySyncOperation[]>> = {
  transcript_fact: ['context_pack_session'],
  derived_memory: ['context_pack_memory'],
  runtime_state: [],
};

const SHARD_TO_PRIME_SYNC_OPERATIONS: Readonly<Record<ShardSessionMemorySyncClass, readonly ShardSessionMemorySyncOperation[]>> = {
  transcript_fact: [],
  derived_memory: ['memory_write', 'memory_import_batch'],
  runtime_state: [],
};

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeShardBackendRequestBackend(value: unknown): ShardBackendRequestBackend | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'container' || normalized === 'orchestrated') {
    return normalized;
  }
  return null;
}

function normalizeAllowlistCommand(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return '';
  }
  return basename(trimmed);
}

function allowlistIncludesCommand(
  allowlist: readonly string[] | undefined,
  command: string,
): boolean {
  if (!allowlist || allowlist.length === 0) {
    return false;
  }

  const expected = normalizeAllowlistCommand(command);
  return allowlist.some(entry => normalizeAllowlistCommand(entry) === expected);
}

function requiredShardBackendCommand(
  backend: ShardBackendRequestBackend,
): 'docker' | 'kubectl' {
  return backend === 'container' ? 'docker' : 'kubectl';
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
  return { allowed: true, reason: 'allowed_shard_memory_import' };
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
    case 'web.fetch_binary': {
      // Synchronous URL policy check so the audit log reflects the real decision
      const url = (params as Record<string, unknown>).url as string | undefined;
      const laneValue = (params as Record<string, unknown>).lane;
      const lane: UrlPolicyLane = laneValue === 'local_crawler'
        ? 'local_crawler'
        : laneValue === 'discovery'
          ? 'discovery'
          : 'default';
      if (!url || typeof url !== 'string') {
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
      const backend = normalizeShardBackendRequestBackend(
        (params as Record<string, unknown>).backend,
      );
      if (!backend) {
        return 'DENY';
      }
      const shellPolicy = policyConfig.shellExec;
      if (!shellPolicy?.enabled) {
        return 'DENY';
      }
      const requiredCommand = requiredShardBackendCommand(backend);
      if (!allowlistIncludesCommand(shellPolicy.allowlist, requiredCommand)) {
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

      const maxBytes = (params as Record<string, unknown>).maxBytes;
      if (method === 'fs.read' && maxBytes !== undefined) {
        if (
          typeof maxBytes !== 'number'
          || !Number.isFinite(maxBytes)
          || Math.floor(maxBytes) < 1
          || maxBytes > 200_000
        ) {
          return 'DENY';
        }
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
      }

      // Step 1: Check normalized path (string prefix match)
      if (!isInsideAllowedPaths(normalizedPath, allowedPrefixes)) {
        return 'NEEDS_APPROVAL';
      }

      // Step 2: Resolve symlinks and check canonical path
      const isWrite = method === 'fs.write';
      const canonical = resolveCanonicalPath(normalizedPath, isWrite);

      // null = resolution failed (ELOOP, EACCES, etc.) — deny access
      if (canonical === null) {
        return 'DENY';
      }

      // If canonical differs from normalized (symlink), re-check against allowed prefixes
      if (canonical !== normalizedPath && !isInsideAllowedPaths(canonical, allowedPrefixes)) {
        return 'DENY';
      }

      return 'ALLOW';
    }

    case 'fs.list': {
      const glob = (params as Record<string, unknown>).glob;
      if (glob !== undefined && typeof glob !== 'string') {
        return 'DENY';
      }
      if (!normalizeWorkspaceRelativeGlob(glob as string | undefined)) {
        return 'DENY';
      }

      const maxEntries = (params as Record<string, unknown>).maxEntries;
      if (maxEntries !== undefined) {
        if (
          typeof maxEntries !== 'number' ||
          !Number.isFinite(maxEntries) ||
          Math.floor(maxEntries) < 1 ||
          maxEntries > 500
        ) {
          return 'DENY';
        }
      }

      return 'ALLOW';
    }

    case 'fs.search': {
      const query = (params as Record<string, unknown>).query;
      if (typeof query !== 'string' || query.trim().length === 0) {
        return 'DENY';
      }

      const glob = (params as Record<string, unknown>).glob;
      if (glob !== undefined && typeof glob !== 'string') {
        return 'DENY';
      }
      if (!normalizeWorkspaceRelativeGlob(glob as string | undefined)) {
        return 'DENY';
      }

      const mode = (params as Record<string, unknown>).mode;
      if (mode !== undefined && mode !== 'literal' && mode !== 'regex') {
        return 'DENY';
      }

      for (const [field, max] of [
        ['maxMatches', 200],
        ['maxFiles', 500],
        ['maxBytesPerFile', 200_000],
        ['contextLines', 2],
      ] as const) {
        const value = (params as Record<string, unknown>)[field];
        if (value === undefined) {
          continue;
        }
        if (
          typeof value !== 'number'
          || !Number.isFinite(value)
          || Math.floor(value) < 0
          || value > max
          || (field !== 'contextLines' && Math.floor(value) < 1)
        ) {
          return 'DENY';
        }
      }

      return 'ALLOW';
    }

    case 'fs.edit': {
      const path = (params as Record<string, unknown>).path;
      const oldText = (params as Record<string, unknown>).oldText;
      const newText = (params as Record<string, unknown>).newText;
      const replaceAll = (params as Record<string, unknown>).replaceAll;
      if (
        typeof path !== 'string'
        || path.trim().length === 0
        || typeof oldText !== 'string'
        || oldText.length === 0
        || typeof newText !== 'string'
        || (replaceAll !== undefined && typeof replaceAll !== 'boolean')
      ) {
        return 'DENY';
      }

      const workspaceRoot = resolveWorkspaceRoot(policyConfig.workspacePath);
      const normalizedPath = resolveWorkspaceFsPathFromRoot(path, workspaceRoot);
      if (!isInsideAllowedPaths(normalizedPath, [workspaceRoot])) {
        return 'NEEDS_APPROVAL';
      }

      const canonical = resolveCanonicalPath(normalizedPath, true);
      if (canonical === null) {
        return 'DENY';
      }
      if (canonical !== normalizedPath && !isInsideAllowedPaths(canonical, [workspaceRoot])) {
        return 'DENY';
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
