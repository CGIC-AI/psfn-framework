import { describe, it, expect } from 'vitest';
import {
  REPO_ALLOWED_PATHS,
  DEFAULT_GATEWAY_SOCKET_PATH,
  WEB_FETCH_USER_AGENT,
  WEB_FETCH_TIMEOUT_MS,
  isAllowedRepoRelativePath,
  resolveRequiredModuleRegistryPath,
} from './policy-constants.js';

describe('policy constants', () => {
  it('exposes canonical repo path allowlist', () => {
    expect(REPO_ALLOWED_PATHS).toEqual(['src/', 'docs/', 'companion/', 'psfn/']);
  });

  it('defaults the module registry path when env is unset', () => {
    expect(resolveRequiredModuleRegistryPath({})).toBe('modules/repl-registry.json');
    expect(resolveRequiredModuleRegistryPath({
      MODULE_REGISTRY_PATH: 'modules/repl-registry.json',
    })).toBe('modules/repl-registry.json');
  });

  it('exposes canonical gateway fetch defaults', () => {
    expect(WEB_FETCH_USER_AGENT).toBe('Companion-Substrate/0.1');
    expect(WEB_FETCH_TIMEOUT_MS).toBe(15_000);
    expect(DEFAULT_GATEWAY_SOCKET_PATH).toBe('/run/psfn/gateway.sock');
  });

  it('validates allowed repo-relative paths consistently', () => {
    expect(isAllowedRepoRelativePath('src/a.ts')).toBe(true);
    expect(isAllowedRepoRelativePath('./docs/readme.md')).toBe(true);
    expect(isAllowedRepoRelativePath('companion/modules/x.json')).toBe(true);
    expect(isAllowedRepoRelativePath('psfn/modules/x.json')).toBe(true);
    expect(isAllowedRepoRelativePath('config/secret.json')).toBe(false);
    expect(isAllowedRepoRelativePath('../escape.txt')).toBe(false);
  });
});
