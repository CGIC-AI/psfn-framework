import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import type { BeadsAction, PolicyContext, PolicyDecision } from './protocol.js';
import { evaluateUrlPolicy, type UrlPolicyConfig, type UrlPolicyLane } from './url-policy.js';
import {
  normalizeWorkspaceRelativeGlob,
  resolveWorkspaceFsPathFromRoot,
  resolveWorkspaceRoot,
} from './filesystem-paths.js';

export interface ShellExecPolicyConfig {
  enabled?: boolean;
  allowlist?: string[];
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

export interface PolicyConfig {
  workspacePath: string;
  allowedReadPaths?: string[];
  fullCodebaseReadRoot?: string;
  urlPolicy?: UrlPolicyConfig;
  webFetchTlsCaCertPaths?: string[];
  shellExec?: ShellExecPolicyConfig;
  beads?: BeadsPolicyConfig;
}

const BEADS_ACTION_BY_METHOD: Readonly<Record<string, BeadsAction>> = {
  'beads.ready': 'ready',
  'beads.show': 'show',
  'beads.create': 'create',
  'beads.update': 'update',
  'beads.close': 'close',
  'beads.sync': 'sync',
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
        } catch {
          // Parent doesn't exist either — use normalized path (will fail at write time)
          return normalized;
        }
      }
      return normalized;
    }
    // ELOOP, EACCES, or any other error — refuse to resolve (caller should DENY)
    return null;
  }
}

export function evaluatePolicy(ctx: PolicyContext, policyConfig: PolicyConfig): PolicyDecision {
  const { method, params } = ctx;

  switch (method) {
    case 'llm.chat':
    case 'llm.complete':
    case 'llm.embed':
    case 'discord.send':
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
