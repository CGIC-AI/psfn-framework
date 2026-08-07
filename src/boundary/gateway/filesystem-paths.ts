import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, normalize, relative, resolve } from 'node:path';

const DEFAULT_FS_LIST_GLOB = '**/*';
const MAX_FS_LIST_GLOB_LENGTH = 512;

export function resolveWorkspaceRoot(workspacePath: string): string {
  return resolve(normalize(workspacePath));
}

export function resolveWorkspaceFsPathFromRoot(path: string, workspaceRoot: string): string {
  const normalizedPath = normalize(path);
  if (isAbsolute(normalizedPath)) {
    return resolve(normalizedPath);
  }
  return resolve(workspaceRoot, normalizedPath);
}

export interface NormalizedWorkspacePathInput {
  path: string;
  strippedPrefix?: string;
  ambiguity?: string;
}

function isLexicallyInsideRoot(pathValue: string, root: string): boolean {
  const relativePath = relative(root, pathValue);
  return relativePath === ''
    || (
      relativePath !== '..'
      && !relativePath.startsWith('../')
      && !relativePath.startsWith('..\\')
      && !isAbsolute(relativePath)
    );
}

function listWorkspaceInputPrefixes(workspaceRoot: string): string[] {
  const normalizedRoot = resolveWorkspaceRoot(workspaceRoot).replace(/\\/g, '/');
  const withoutLeadingSlash = normalizedRoot.replace(/^\/+/, '');
  const segments = withoutLeadingSlash.split('/').filter(Boolean);
  const workspaceMarkerIndex = segments.lastIndexOf('workspaces');
  const markerPrefix = workspaceMarkerIndex >= 0
    ? segments.slice(workspaceMarkerIndex).join('/')
    : undefined;
  return [...new Set([
    withoutLeadingSlash,
    ...(markerPrefix ? [markerPrefix] : []),
  ].filter(Boolean))].sort((left, right) => right.length - left.length);
}

/**
 * Accept the canonical personal-root-relative form while repairing the common
 * duplicate-root form produced when a caller copies the displayed workspace
 * path back into fs.read/fs.write. Traversal is rejected before normalization,
 * so `..` can never be erased while stripping a known root prefix.
 */
export function normalizeWorkspacePathInput(
  pathValue: string,
  workspaceRoot: string,
): NormalizedWorkspacePathInput {
  const slashNormalized = pathValue.replace(/\\/g, '/');
  if (
    slashNormalized.length === 0
    || slashNormalized.includes('\0')
    || slashNormalized.split('/').includes('..')
  ) {
    throw new Error(
      'Filesystem path must be a non-empty Personal Workspace-relative path without traversal segments',
    );
  }

  const root = resolveWorkspaceRoot(workspaceRoot);
  const normalizedOriginal = resolveWorkspaceFsPathFromRoot(pathValue, root);
  if (isAbsolute(pathValue) && isLexicallyInsideRoot(normalizedOriginal, root)) {
    return { path: normalizedOriginal };
  }

  const withoutLeadingSlash = slashNormalized.replace(/^\/+/, '').replace(/^\.\//, '');
  for (const prefix of listWorkspaceInputPrefixes(root)) {
    if (
      withoutLeadingSlash !== prefix
      && !withoutLeadingSlash.startsWith(`${prefix}/`)
    ) {
      continue;
    }
    const stripped = withoutLeadingSlash.slice(prefix.length).replace(/^\/+/, '');
    if (stripped.length === 0) {
      return {
        path: '.',
        ambiguity: 'Filesystem path names the Personal Workspace root',
      };
    }
    if (existsSync(resolve(root, prefix))) {
      return {
        path: stripped,
        ambiguity:
          `Filesystem path "${pathValue}" is ambiguous because both the prefixed and `
          + 'Personal Workspace-relative interpretations are viable',
      };
    }
    return {
      path: stripped,
      strippedPrefix: prefix,
    };
  }

  if (withoutLeadingSlash.startsWith('workspaces/personal/')) {
    return {
      path: '.',
      ambiguity:
        `Filesystem path "${pathValue}" names a different or malformed Personal Workspace prefix`,
    };
  }
  const workspaceName = basename(root);
  if (withoutLeadingSlash === workspaceName) {
    return {
      path: '.',
      ambiguity:
        `Filesystem path "${pathValue}" names the Personal Workspace root`,
    };
  }
  if (withoutLeadingSlash.startsWith(`${workspaceName}/`)) {
    const stripped = withoutLeadingSlash
      .slice(workspaceName.length)
      .replace(/^\/+/, '');
    if (existsSync(resolve(root, workspaceName))) {
      return {
        path: stripped,
        ambiguity:
          `Filesystem path "${pathValue}" is ambiguous because both the root-name-prefixed `
          + 'and Personal Workspace-relative interpretations are viable',
      };
    }
    return {
      path: stripped,
      strippedPrefix: workspaceName,
    };
  }

  return { path: normalize(pathValue) };
}

export type CanonicalPathMissingPathBehavior = 'returnNormalized' | 'resolveParent';
export type CanonicalPathErrorBehavior = 'returnNormalized' | 'deny';

export interface ResolveCanonicalPathOptions {
  missingPathBehavior: CanonicalPathMissingPathBehavior;
  errorBehavior: CanonicalPathErrorBehavior;
  onParentResolutionError?: (details: { path: string; error: unknown }) => void;
}

function resolveThroughNearestExistingAncestor(pathValue: string): string {
  const suffix: string[] = [];
  let cursor = pathValue;
  for (;;) {
    try {
      return resolve(realpathSync(cursor), ...suffix.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(basename(cursor));
      cursor = parent;
    }
  }
}

export function resolveCanonicalPath(
  pathValue: string,
  options: ResolveCanonicalPathOptions & { errorBehavior: 'returnNormalized' },
): string;
export function resolveCanonicalPath(
  pathValue: string,
  options: ResolveCanonicalPathOptions & { errorBehavior: 'deny' },
): string | null;
export function resolveCanonicalPath(
  pathValue: string,
  options: ResolveCanonicalPathOptions,
): string | null {
  const normalized = resolve(normalize(pathValue));
  try {
    return realpathSync(normalized);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      if (options.missingPathBehavior === 'resolveParent') {
        try {
          return resolveThroughNearestExistingAncestor(normalized);
        } catch (parentErr) {
          options.onParentResolutionError?.({ path: normalized, error: parentErr });
        }
      }
      return normalized;
    }
    return options.errorBehavior === 'returnNormalized' ? normalized : null;
  }
}

export function normalizeWorkspaceRelativeGlob(rawGlob: string | undefined): string | null {
  const trimmed = typeof rawGlob === 'string' ? rawGlob.trim() : DEFAULT_FS_LIST_GLOB;
  const normalizedGlob = trimmed.replace(/\\/g, '/');
  if (
    !normalizedGlob
    || normalizedGlob.length > MAX_FS_LIST_GLOB_LENGTH
    || normalizedGlob.includes('\0')
    || normalizedGlob.startsWith('/')
    || normalizedGlob.startsWith('\\')
    || /(^|\/)\.\.(\/|$)/.test(normalizedGlob)
  ) {
    return null;
  }
  return normalizedGlob;
}
