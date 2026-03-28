// ── Security / Policy Constants ──
// Canonical values reused across runtime, gateway, git, and REPL policy surfaces.

import {
  DEFAULT_COMPANION_SKILLS_DIRECTORY,
  LEGACY_COMPANION_SKILLS_DIRECTORY,
} from '../../core/identity/companion-naming.js';

export const REPO_ALLOWED_PATHS = [
  'src/',
  'docs/',
  DEFAULT_COMPANION_SKILLS_DIRECTORY.replace(/skills$/, ''),
  LEGACY_COMPANION_SKILLS_DIRECTORY.replace(/skills$/, ''),
] as const;

export const DEFAULT_GATEWAY_SOCKET_PATH = '/run/psfn/gateway.sock';

export const WEB_FETCH_USER_AGENT = 'Companion-Substrate/0.1';
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

export function resolveRequiredModuleRegistryPath(
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = env.MODULE_REGISTRY_PATH?.trim();
  if (!configured) {
    throw new Error(
      'MODULE_REGISTRY_PATH must be set (for example: companion/modules/repl-registry.json)',
    );
  }
  return configured;
}
