import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadModelsConfig } from '../../system/config/models-config.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { reloadGatewayModels } from './models-owner-file-reload.js';

describe('gateway models.json reload (psfn-framework-awhls, psfn-framework-hye2n)', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function seededRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'gateway-models-reload-'));
    roots.push(root);
    copyFileSync(join(process.cwd(), 'config', 'models.seed.json'), join(root, 'models.json'));
    return root;
  }

  it('applies the reloaded registry to the live gateway config, then re-resolves the screeners', () => {
    const root = seededRoot();
    const config = { dataDir: root, defaultContextWindow: 128_000 } as SubstrateConfig;
    const reloaded = loadModelsConfig(root, { defaultContextWindow: 128_000 });
    const calls: string[] = [];
    const intakeScreening = {
      refreshScreenerModels: vi.fn(() => {
        // The screeners must see the new registry, so they re-resolve after it lands.
        calls.push(`screeners:${config.modelRegistry?.models.length ?? 0}`);
        return { applied: 1 };
      }),
    };
    reloadGatewayModels({
      config,
      configStore: { loadModels: () => reloaded } as never,
      intakeScreening,
    });
    expect(config.modelRegistry?.models.map(model => model.id))
      .toEqual(reloaded.modelRegistry.models.map(model => model.id));
    expect(calls).toEqual([`screeners:${reloaded.modelRegistry.models.length}`]);
  });

  it('refuses an unreadable models.json without touching the screeners', () => {
    const config = { dataDir: seededRoot(), defaultContextWindow: 128_000 } as SubstrateConfig;
    const intakeScreening = { refreshScreenerModels: vi.fn(() => ({ applied: 0 })) };
    expect(() => reloadGatewayModels({
      config,
      configStore: { loadModels: () => { throw new Error('models.json: unexpected token'); } } as never,
      intakeScreening,
    })).toThrow(/models\.json disk reload failed: models\.json: unexpected token/);
    expect(intakeScreening.refreshScreenerModels).not.toHaveBeenCalled();
  });
});
