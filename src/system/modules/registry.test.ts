import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureRegistryFile,
  isModuleRecord,
  parseModuleRegistry,
  readModuleRegistry,
  resolveModuleRegistryPath,
  resolveModuleRegistryPathFromWorkspace,
  writeModuleRegistry,
} from './registry.js';

const ORIGINAL_MODULE_REGISTRY_PATH = process.env.MODULE_REGISTRY_PATH;

afterEach(() => {
  if (ORIGINAL_MODULE_REGISTRY_PATH === undefined) {
    delete process.env.MODULE_REGISTRY_PATH;
  } else {
    process.env.MODULE_REGISTRY_PATH = ORIGINAL_MODULE_REGISTRY_PATH;
  }
});

describe('ensureRegistryFile', () => {
  it('creates file with empty array when path does not exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-reg-ensure-'));
    const registryPath = join(root, 'nested', 'deep', 'registry.json');

    try {
      expect(existsSync(registryPath)).toBe(false);
      ensureRegistryFile(registryPath);
      expect(existsSync(registryPath)).toBe(true);
      const content = readFileSync(registryPath, 'utf-8');
      expect(JSON.parse(content)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is a no-op when file already exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-reg-ensure-exist-'));
    const registryPath = join(root, 'registry.json');
    writeFileSync(registryPath, '[{"id":"mod-1"}]', 'utf-8');

    try {
      ensureRegistryFile(registryPath);
      const content = readFileSync(registryPath, 'utf-8');
      expect(content).toBe('[{"id":"mod-1"}]');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates parent directories recursively', () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-reg-ensure-dirs-'));
    const registryPath = join(root, 'a', 'b', 'c', 'registry.json');

    try {
      ensureRegistryFile(registryPath);
      expect(existsSync(registryPath)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('readModuleRegistry', () => {
  it('returns empty array on ENOENT', async () => {
    const result = await readModuleRegistry('/tmp/does-not-exist-psfn-test.json');
    expect(result).toEqual([]);
  });

  it('parses valid registry file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-reg-read-'));
    const registryPath = join(root, 'registry.json');
    const record = {
      id: 'mod-1',
      name: 'test',
      source: 'export default {};',
      enabled: true,
      installedAt: 100,
      updatedAt: 100,
      version: 1,
    };
    writeFileSync(registryPath, JSON.stringify([record]), 'utf-8');

    try {
      const result = await readModuleRegistry(registryPath);
      expect(result).toEqual([record]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('writeModuleRegistry', () => {
  it('creates parent directories and writes records', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-reg-write-'));
    const registryPath = join(root, 'sub', 'registry.json');

    try {
      await writeModuleRegistry(registryPath, []);
      expect(existsSync(registryPath)).toBe(true);
      expect(JSON.parse(readFileSync(registryPath, 'utf-8'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('parseModuleRegistry', () => {
  it('filters out invalid entries', () => {
    const result = parseModuleRegistry(JSON.stringify([
      { id: 'mod-1', name: 'good', source: 'x', enabled: true, installedAt: 1, updatedAt: 1, version: 1 },
      { id: 'mod-2' }, // missing fields
      'not-an-object',
    ]));
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('mod-1');
  });

  it('returns empty array for non-array JSON', () => {
    expect(parseModuleRegistry('{"not":"array"}')).toEqual([]);
  });
});

describe('isModuleRecord', () => {
  it('validates complete records', () => {
    expect(isModuleRecord({
      id: 'mod-1',
      name: 'test',
      source: 'x',
      enabled: true,
      installedAt: 1,
      updatedAt: 1,
      version: 1,
    })).toBe(true);
  });

  it('rejects incomplete records', () => {
    expect(isModuleRecord({ id: 'mod-1' })).toBe(false);
    expect(isModuleRecord(null)).toBe(false);
    expect(isModuleRecord('string')).toBe(false);
  });
});

describe('resolveModuleRegistryPath', () => {
  it('resolves absolute paths unchanged', () => {
    expect(resolveModuleRegistryPath('/abs/path.json')).toBe('/abs/path.json');
  });

  it('resolves relative paths against cwd', () => {
    const result = resolveModuleRegistryPath('rel/path.json', '/home/test');
    expect(result).toBe('/home/test/rel/path.json');
  });

  it('falls back to the canonical module registry path when no override is provided', () => {
    delete process.env.MODULE_REGISTRY_PATH;
    expect(resolveModuleRegistryPath(undefined, '/home/test')).toBe('/home/test/modules/repl-registry.json');
  });
});

describe('resolveModuleRegistryPathFromWorkspace', () => {
  it('resolves relative paths against workspace root', () => {
    const result = resolveModuleRegistryPathFromWorkspace('/workspace/root', 'rel/path.json');
    expect(result).toBe('/workspace/root/rel/path.json');
  });

  it('returns absolute paths unchanged', () => {
    const result = resolveModuleRegistryPathFromWorkspace('/workspace/root', '/abs/modules.json');
    expect(result).toBe('/abs/modules.json');
  });

  it('falls back to the canonical module registry path when no override is provided', () => {
    delete process.env.MODULE_REGISTRY_PATH;
    expect(resolveModuleRegistryPathFromWorkspace('/workspace/root')).toBe('/workspace/root/modules/repl-registry.json');
  });
});
