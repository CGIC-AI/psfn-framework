import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../event-bus.js';
import { ModuleLoader } from './loader.js';
import type { ModuleRecord } from './types.js';

function writeRegistry(path: string, records: ModuleRecord[]): void {
  writeFileSync(path, JSON.stringify(records, null, 2), 'utf-8');
}

function readRegistry(path: string): ModuleRecord[] {
  return JSON.parse(readFileSync(path, 'utf-8')) as ModuleRecord[];
}

function baseRecord(overrides: Partial<ModuleRecord> = {}): ModuleRecord {
  return {
    id: 'mod-1',
    name: 'planner',
    source: 'export default {};',
    enabled: true,
    installedAt: 100,
    updatedAt: 100,
    version: 1,
    ...overrides,
  };
}

describe('ModuleLoader', () => {
  it('creates registry file on loadEnabledModules if missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-module-loader-enoent-'));
    const registryPath = join(root, 'nested', 'modules', 'registry.json');

    const registerTool = vi.fn();
    const eventBus = new EventBus();
    const loader = new ModuleLoader({
      eventBus,
      registerTool,
      registryPath,
    });

    try {
      expect(existsSync(registryPath)).toBe(false);
      const summary = await loader.loadEnabledModules();
      expect(existsSync(registryPath)).toBe(true);
      expect(summary).toEqual({
        attempted: 0,
        loaded: 0,
        failed: 0,
      });

      // Verify the created file is valid JSON
      const content = readFileSync(registryPath, 'utf-8');
      expect(JSON.parse(content)).toEqual([]);
    } finally {
      await loader.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses to execute registry-backed module source in process', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-module-loader-'));
    const registryPath = join(root, 'registry.json');
    writeRegistry(registryPath, [
      baseRecord({
        source: [
          'globalThis.__psfnModuleLoaderSpy = true;',
          'export default {',
          '  name: "planner",',
          '  validate(ctx) {',
          '    if (!ctx.module || !ctx.module.name) throw new Error("missing module context");',
          '  },',
          '};',
        ].join('\n'),
      }),
    ]);

    const registerTool = vi.fn();
    const eventBus = new EventBus();
    const errors: Array<{ id: string; error: string }> = [];
    eventBus.on('module.error', (event) => errors.push({ id: event.id, error: event.error }));

    const loader = new ModuleLoader({
      eventBus,
      registerTool,
      registryPath,
    });

    try {
      const summary = await loader.loadEnabledModules();
      expect(summary).toEqual({
        attempted: 1,
        loaded: 0,
        failed: 1,
      });
      expect(registerTool).not.toHaveBeenCalled();
      expect((globalThis as { __psfnModuleLoaderSpy?: boolean }).__psfnModuleLoaderSpy).toBeUndefined();
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toContain('registry-backed module source execution is disabled');
      expect(readRegistry(registryPath)[0].lastError).toContain('registry-backed module source execution is disabled');
    } finally {
      delete (globalThis as { __psfnModuleLoaderSpy?: boolean }).__psfnModuleLoaderSpy;
      await loader.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists lastError for blocked module source execution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-module-loader-fail-'));
    const registryPath = join(root, 'registry.json');
    writeRegistry(registryPath, [
      baseRecord({
        source: 'export default { validate() { throw new Error("invalid module"); } };',
      }),
    ]);

    const registerTool = vi.fn();
    const eventBus = new EventBus();
    const errors: Array<{ id: string; error: string }> = [];
    eventBus.on('module.error', (event) => errors.push({ id: event.id, error: event.error }));

    const loader = new ModuleLoader({
      eventBus,
      registerTool,
      registryPath,
    });

    try {
      const summary = await loader.loadEnabledModules();
      expect(summary).toEqual({
        attempted: 1,
        loaded: 0,
        failed: 1,
      });
      expect(registerTool).not.toHaveBeenCalled();
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toContain('registry-backed module source execution is disabled');
      expect(readRegistry(registryPath)[0].lastError).toContain('registry-backed module source execution is disabled');
    } finally {
      await loader.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
