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

  it('loads enabled modules through validate -> load -> activate lifecycle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'psfn-module-loader-'));
    const registryPath = join(root, 'registry.json');
    writeRegistry(registryPath, [
      baseRecord({
        source: [
          'export default {',
          '  name: "planner",',
          '  validate(ctx) {',
          '    if (!ctx.module || !ctx.module.name) throw new Error("missing module context");',
          '  },',
          '  activate(ctx) {',
          '    ctx.registerTool({',
          '      name: "mod_probe",',
          '      description: "module probe",',
          '      label: "mod_probe",',
          '      parameters: { type: "object", properties: {}, additionalProperties: false },',
          '      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),',
          '    });',
          '  },',
          '  health() { return { ok: true, details: "ready" }; },',
          '};',
        ].join('\n'),
      }),
    ]);

    const registerTool = vi.fn();
    const eventBus = new EventBus();
    const moduleInstalls: Array<{ id: string; name: string }> = [];
    const moduleHealth: Array<{ id: string; ok: boolean }> = [];
    const moduleUninstalls: Array<{ id: string; reason: string }> = [];
    eventBus.on('module.install', (event) => moduleInstalls.push({ id: event.id, name: event.name }));
    eventBus.on('module.health', (event) => moduleHealth.push({ id: event.id, ok: event.ok }));
    eventBus.on('module.uninstall', (event) => moduleUninstalls.push({ id: event.id, reason: event.reason }));

    const loader = new ModuleLoader({
      eventBus,
      registerTool,
      registryPath,
    });

    try {
      const summary = await loader.loadEnabledModules();
      expect(summary).toEqual({
        attempted: 1,
        loaded: 1,
        failed: 0,
      });
      expect(registerTool).toHaveBeenCalledTimes(1);
      expect(moduleInstalls).toEqual([{ id: 'mod-1', name: 'planner' }]);
      expect(moduleHealth).toEqual([{ id: 'mod-1', ok: true }]);
      expect(readRegistry(registryPath)[0].lastError).toBeUndefined();

      await loader.applyRegistryMutation({
        action: 'disable',
        previous: readRegistry(registryPath)[0],
        next: {
          ...readRegistry(registryPath)[0],
          enabled: false,
          updatedAt: 200,
          version: 2,
        },
      });
      expect(moduleUninstalls).toEqual([{ id: 'mod-1', reason: 'disable' }]);
    } finally {
      await loader.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists lastError for modules that fail validation/activation', async () => {
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
      expect(errors[0].error).toContain('invalid module');
      expect(readRegistry(registryPath)[0].lastError).toContain('invalid module');
    } finally {
      await loader.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
