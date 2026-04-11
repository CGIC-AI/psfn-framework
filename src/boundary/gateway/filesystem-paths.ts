import { isAbsolute, normalize, resolve } from 'node:path';

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
