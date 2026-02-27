import { describe, it, expect } from 'vitest';
import {
  resolveAllowedReadPathsFromEnv,
  resolveTrustedModuleRegistryPathFromEnv,
} from './policy-config.js';

describe('resolveAllowedReadPathsFromEnv', () => {
  const workspacePath = '/app/workspace';

  it('returns undefined when no allowlisted paths are configured', () => {
    expect(resolveAllowedReadPathsFromEnv({}, workspacePath)).toBeUndefined();
  });

  it('parses ALLOWED_READ_PATHS and trims empties', () => {
    const value = resolveAllowedReadPathsFromEnv({
      ALLOWED_READ_PATHS: ' /app/identity : :/app/shared ',
    }, workspacePath);

    expect(value).toEqual(['/app/identity', '/app/shared']);
  });

  it('adds module registry path when MODULE_REGISTRY_TRUSTED_READ=true', () => {
    const value = resolveAllowedReadPathsFromEnv({
      MODULE_REGISTRY_TRUSTED_READ: 'true',
    }, workspacePath);

    expect(value).toEqual(['/app/workspace/purrsephone/modules/repl-registry.json']);
  });

  it('uses MODULE_REGISTRY_PATH override when trusted read is enabled', () => {
    const value = resolveAllowedReadPathsFromEnv({
      MODULE_REGISTRY_TRUSTED_READ: 'TRUE',
      MODULE_REGISTRY_PATH: 'custom/modules.json',
      ALLOWED_READ_PATHS: '/app/identity',
    }, workspacePath);

    expect(value).toEqual(['/app/identity', '/app/workspace/custom/modules.json']);
  });

  it('resolves trusted module registry path when enabled', () => {
    const value = resolveTrustedModuleRegistryPathFromEnv({
      MODULE_REGISTRY_TRUSTED_READ: 'true',
    }, workspacePath);

    expect(value).toBe('/app/workspace/purrsephone/modules/repl-registry.json');
  });

  it('returns undefined trusted module registry path when disabled', () => {
    const value = resolveTrustedModuleRegistryPathFromEnv({
      MODULE_REGISTRY_TRUSTED_READ: 'false',
    }, workspacePath);

    expect(value).toBeUndefined();
  });
});
