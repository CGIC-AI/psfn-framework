// ── Security / Policy Constants ──
// Canonical values reused across runtime, gateway, git, and REPL policy surfaces.

export const REPO_ALLOWED_PATHS = ['src/', 'docs/', 'psfn/'] as const;

export const MODULE_REGISTRY_PATH = 'psfn/modules/repl-registry.json';

export const DEFAULT_GATEWAY_SOCKET_PATH = '/run/psfn/gateway.sock';

export const WEB_FETCH_USER_AGENT = 'PurrsePhone-Substrate/0.1';
export const WEB_FETCH_TIMEOUT_MS = 15_000;

/**
 * Validate repo-relative path against canonical allowlisted prefixes.
 * Input should be normalized to repo-relative semantics.
 */
export function isAllowedRepoRelativePath(path: string): boolean {
  const normalized = path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\//, '');

  for (const prefix of REPO_ALLOWED_PATHS) {
    const bare = prefix.replace(/\/$/, '');
    if (normalized === bare || normalized.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}
