import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import type { PolicyContext, PolicyDecision } from './protocol.js';
import { evaluateUrlPolicy, type UrlPolicyConfig } from './url-policy.js';
import {
  normalizeWorkspaceRelativeGlob,
  resolveWorkspaceFsPathFromRoot,
  resolveWorkspaceRoot,
} from './filesystem-paths.js';

export interface PolicyConfig {
  workspacePath: string;
  allowedReadPaths?: string[];
  urlPolicy?: UrlPolicyConfig;
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

/**
 * Resolve the canonical (symlink-resolved) path for policy checking.
 * Returns the normalized path unchanged if the file doesn't exist (ENOENT).
 * For writes to new files, resolves the parent directory if it exists.
 * Returns null only if a symlink explicitly resolves outside allowed paths.
 */
function resolveCanonicalPath(normalized: string, isWrite: boolean): string {
  try {
    return realpathSync(normalized);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT = path doesn't exist at all (not a symlink issue) — safe to use normalized
    // ELOOP = too many symlinks (suspicious, but ENOENT for broken symlink targets too)
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
    // For any other error (EACCES, ELOOP, etc.), use normalized path
    return normalized;
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

    case 'web.fetch': {
      // Synchronous URL policy check so the audit log reflects the real decision
      const url = (params as Record<string, unknown>).url as string | undefined;
      if (url && policyConfig.urlPolicy) {
        const urlCheck = evaluateUrlPolicy(url, policyConfig.urlPolicy);
        if (!urlCheck.allowed) {
          return 'DENY';
        }
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
      if (method === 'fs.read' && policyConfig.allowedReadPaths) {
        for (const allowed of policyConfig.allowedReadPaths) {
          allowedPrefixes.push(resolveWorkspaceFsPathFromRoot(allowed, workspaceRoot));
        }
      }

      // Step 1: Check normalized path (string prefix match)
      if (!isInsideAllowedPaths(normalizedPath, allowedPrefixes)) {
        return 'NEEDS_APPROVAL';
      }

      // Step 2: Resolve symlinks and check canonical path
      const isWrite = method === 'fs.write';
      const canonical = resolveCanonicalPath(normalizedPath, isWrite);

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

    default:
      return 'DENY';
  }
}
