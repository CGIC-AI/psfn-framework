import { describe, it, expect } from 'vitest';
import { delimiter as pathDelimiter } from 'node:path';
import {
  resolveAllowedReadPathsFromEnv,
  resolveFullCodebaseReadRootFromEnv,
  resolveTrustedModuleRegistryPathFromEnv,
} from './policy-config.js';

describe('resolveAllowedReadPathsFromEnv', () => {
  const workspacePath = '/app/workspace';

  it('returns undefined when no allowlisted paths are configured', () => {
    expect(resolveAllowedReadPathsFromEnv({}, workspacePath)).toBeUndefined();
  });

  it('parses ALLOWED_READ_PATHS and trims empties', () => {
    const value = resolveAllowedReadPathsFromEnv({
      ALLOWED_READ_PATHS: [' /app/identity ', '', '/app/shared '].join(pathDelimiter),
    }, workspacePath);

    expect(value).toEqual(['/app/identity', '/app/shared']);
  });

  it('adds module registry path when MODULE_REGISTRY_TRUSTED_READ=true', () => {
    const value = resolveAllowedReadPathsFromEnv({
      MODULE_REGISTRY_TRUSTED_READ: 'true',
      MODULE_REGISTRY_PATH: 'companion/modules/repl-registry.json',
    }, workspacePath);

    expect(value).toEqual(['/app/workspace/companion/modules/repl-registry.json']);
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
      MODULE_REGISTRY_PATH: 'companion/modules/repl-registry.json',
    }, workspacePath);

    expect(value).toBe('/app/workspace/companion/modules/repl-registry.json');
  });

  it('accepts canonical truthy env variants for trusted module registry reads', () => {
    const withOne = resolveTrustedModuleRegistryPathFromEnv({
      MODULE_REGISTRY_TRUSTED_READ: '1',
      MODULE_REGISTRY_PATH: 'companion/modules/repl-registry.json',
    }, workspacePath);
    expect(withOne).toBe('/app/workspace/companion/modules/repl-registry.json');

    const withYes = resolveTrustedModuleRegistryPathFromEnv({
      MODULE_REGISTRY_TRUSTED_READ: 'YES',
      MODULE_REGISTRY_PATH: 'companion/modules/repl-registry.json',
    }, workspacePath);
    expect(withYes).toBe('/app/workspace/companion/modules/repl-registry.json');

    const withOn = resolveTrustedModuleRegistryPathFromEnv({
      MODULE_REGISTRY_TRUSTED_READ: 'on',
      MODULE_REGISTRY_PATH: 'companion/modules/repl-registry.json',
    }, workspacePath);
    expect(withOn).toBe('/app/workspace/companion/modules/repl-registry.json');
  });

  it('throws when trusted read is enabled without MODULE_REGISTRY_PATH', () => {
    expect(() => resolveTrustedModuleRegistryPathFromEnv({
      MODULE_REGISTRY_TRUSTED_READ: 'true',
    }, workspacePath)).toThrow('MODULE_REGISTRY_TRUSTED_READ=true requires MODULE_REGISTRY_PATH');
  });

  it('returns undefined trusted module registry path when disabled', () => {
    const value = resolveTrustedModuleRegistryPathFromEnv({
      MODULE_REGISTRY_TRUSTED_READ: 'false',
    }, workspacePath);

    expect(value).toBeUndefined();
  });
});

describe('resolveFullCodebaseReadRootFromEnv', () => {
  const codebaseRoot = '/app';

  it('returns undefined for non-yolo runtime mode', () => {
    expect(resolveFullCodebaseReadRootFromEnv({
      PSFN_RUNTIME_MODE: 'split',
    }, codebaseRoot)).toBeUndefined();
  });

  it('returns codebase root for yolo runtime mode', () => {
    expect(resolveFullCodebaseReadRootFromEnv({
      PSFN_RUNTIME_MODE: 'YOLO',
    }, codebaseRoot)).toBe('/app');
  });
});
