import { describe, it, expect } from 'vitest';
import {
  REPO_ALLOWED_PATHS,
  MODULE_REGISTRY_PATH,
  DEFAULT_GATEWAY_SOCKET_PATH,
  WEB_FETCH_USER_AGENT,
  WEB_FETCH_TIMEOUT_MS,
  isAllowedRepoRelativePath,
} from './policy-constants.js';

describe('policy constants', () => {
  it('exposes canonical repo path allowlist', () => {
    expect(REPO_ALLOWED_PATHS).toEqual(['src/', 'docs/', 'purrsephone/']);
  });

  it('exposes canonical module registry path', () => {
    expect(MODULE_REGISTRY_PATH).toBe('purrsephone/modules/repl-registry.json');
  });

  it('exposes canonical gateway fetch defaults', () => {
    expect(WEB_FETCH_USER_AGENT).toBe('PurrsePhone-Substrate/0.1');
    expect(WEB_FETCH_TIMEOUT_MS).toBe(15_000);
    expect(DEFAULT_GATEWAY_SOCKET_PATH).toBe('/run/psfn/gateway.sock');
  });

  it('validates allowed repo-relative paths consistently', () => {
    expect(isAllowedRepoRelativePath('src/a.ts')).toBe(true);
    expect(isAllowedRepoRelativePath('./docs/readme.md')).toBe(true);
    expect(isAllowedRepoRelativePath('purrsephone/modules/x.json')).toBe(true);
    expect(isAllowedRepoRelativePath('config/secret.json')).toBe(false);
    expect(isAllowedRepoRelativePath('../escape.txt')).toBe(false);
  });
});
