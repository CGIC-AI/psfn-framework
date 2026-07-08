import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, normalize, resolve } from 'node:path';

const DEFAULT_FS_LIST_GLOB = '**/*';
const MAX_FS_LIST_GLOB_LENGTH = 512;

export function resolveWorkspaceRoot(workspacePath: string): string {
  return resolve(normalize(workspacePath));
}

export function resolveWorkspaceFsPath(path: string, workspacePath: string): string {
  const workspaceRoot = resolveWorkspaceRoot(workspacePath);
  return resolveWorkspaceFsPathFromRoot(path, workspaceRoot);
}

export function resolveWorkspaceFsPathFromRoot(path: string, workspaceRoot: string): string {
  const normalizedPath = normalize(path);
  if (isAbsolute(normalizedPath)) {
    return resolve(normalizedPath);
  }
  return resolve(workspaceRoot, normalizedPath);
}

export type CanonicalPathMissingPathBehavior = 'returnNormalized' | 'resolveParent';
export type CanonicalPathErrorBehavior = 'returnNormalized' | 'deny';

export interface ResolveCanonicalPathOptions {
  missingPathBehavior: CanonicalPathMissingPathBehavior;
  errorBehavior: CanonicalPathErrorBehavior;
  onParentResolutionError?: (details: { path: string; error: unknown }) => void;
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
          const parentReal = realpathSync(dirname(normalized));
          return resolve(parentReal, basename(normalized));
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
