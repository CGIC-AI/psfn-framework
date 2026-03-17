import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadModelsConfig } from '../../../config/models-config.js';
import { loadSettings } from '../../../settings.js';
import type { SubstrateConfig } from '../../../types.js';
import { AdminSettingsDataService } from './settings-service.js';

let tempDir: string | null = null;

function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'psfn-settings-service-'));
  return tempDir;
}

function buildConfig(
  root: string,
  hooks?: {
    refreshModels?: () => void;
    refreshCapabilities?: () => void;
  },
): SubstrateConfig {
  const defaultContextWindow = 128_000;
  const models = loadModelsConfig(root, { defaultContextWindow });
  loadSettings(root);

  return {
    primaryModel: models.primaryModel,
    primaryProvider: models.primaryProvider,
    extractionModel: models.extractionModel,
    extractionProvider: models.extractionProvider,
    primaryMaxTokens: models.primaryMaxTokens,
    extractionMaxTokens: models.extractionMaxTokens,
    discordToken: '',
    discordBotId: 'settings-service-test-bot',
    characterCardPath: join(root, 'character.json'),
    dataDir: root,
    databasePath: join(root, 'companion.db'),
    sessionHistoryBudgetPct: 6,
    memoryRetrievalBudgetPct: 2,
    sessionMessageLimit: 30,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    capabilityTier: 'nursery',
    modelRoster: models.modelRoster,
    modelCatalog: models.modelCatalog,
    modelRoleAssignments: models.modelRoleAssignments,
    modelRegistry: models.modelRegistry,
    runtimeHooks: hooks,
  };
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('AdminSettingsDataService', () => {
  it('round-trips model-control runtime settings with persistence and reload guarantees', async () => {
    const root = makeTempDir();
    const refreshModelsSpy = vi.fn();
    const refreshCapabilitiesSpy = vi.fn();
    const config = buildConfig(root, {
      refreshModels: refreshModelsSpy,
      refreshCapabilities: refreshCapabilitiesSpy,
    });
    const service = new AdminSettingsDataService({ config });

    const modelsBefore = loadModelsConfig(root, { defaultContextWindow: config.defaultContextWindow });
    const runtimeModelControls = {
      thinkMaxTokens: 70000,
      thinkMaxWallTimeMs: 125000,
      thinkMaxSubQueries: 9,
      openRouterProviderOrder: ['parasail', 'openai'],
      uiThemeId: 'generic-dark',
    };

    const result = service.updateSettings(JSON.stringify(runtimeModelControls));

    expect(result).toEqual({
      ok: true,
      message: 'Settings updated',
    });
    expect(refreshModelsSpy).toHaveBeenCalledTimes(0);
    expect(refreshCapabilitiesSpy).toHaveBeenCalledTimes(0);

    const settingsData = await service.getSettingsData();
    expect(settingsData.config).toEqual(expect.objectContaining(runtimeModelControls));

    const reloadedModels = loadModelsConfig(root, { defaultContextWindow: config.defaultContextWindow });
    expect(settingsData.editors.models).toEqual(modelsBefore);
    expect(reloadedModels).toEqual(modelsBefore);

    const persistedSettings = loadSettings(root);
    expect(persistedSettings).toEqual(expect.objectContaining(runtimeModelControls));
  });

  it('returns field-level errors for malformed and out-of-range model-control payloads and fails closed', () => {
    const root = makeTempDir();
    const config = buildConfig(root);
    const service = new AdminSettingsDataService({ config });

    const modelsBefore = loadModelsConfig(root, { defaultContextWindow: config.defaultContextWindow });
    const settingsBefore = loadSettings(root);
    const result = service.updateSettings(JSON.stringify({
      thinkMaxTokens: 999,
      thinkMaxWallTimeMs: 1000,
      thinkMaxSubQueries: 0,
      uiThemeId: '',
      modelCatalog: {
        primary: {
          routing: {
            providerOrder: ['openrouter', 123],
          },
        },
      },
    }));

    expect(result.ok).toBe(false);
    expect(result.message).toContain('modelCatalog is owned by models.json');
    expect(result.validationErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'thinkMaxTokens',
        message: 'thinkMaxTokens must be 1000-1000000',
        code: 'out_of_range',
      }),
      expect.objectContaining({
        field: 'thinkMaxWallTimeMs',
        message: 'thinkMaxWallTimeMs must be 5000-600000',
        code: 'out_of_range',
      }),
      expect.objectContaining({
        field: 'thinkMaxSubQueries',
        message: 'thinkMaxSubQueries must be 1-100',
        code: 'out_of_range',
      }),
      expect.objectContaining({
        field: 'uiThemeId',
        message: 'uiThemeId cannot be empty',
        code: 'required',
      }),
      expect.objectContaining({
        field: 'modelCatalog',
        message: 'modelCatalog is owned by models.json; edit that canonical config instead',
        code: 'wrong_owner',
      }),
      expect.objectContaining({
        field: 'modelCatalog.primary.routing.providerOrder',
        message: 'modelCatalog.primary.routing.providerOrder must be an array of strings',
        code: 'invalid_type',
      }),
    ]));

    const modelsAfter = loadModelsConfig(root, { defaultContextWindow: config.defaultContextWindow });
    expect(modelsAfter).toEqual(modelsBefore);
    const settingsAfter = loadSettings(root);
    expect(settingsAfter.thinkMaxTokens).toBe(settingsBefore.thinkMaxTokens);
    expect(settingsAfter.thinkMaxWallTimeMs).toBe(settingsBefore.thinkMaxWallTimeMs);
    expect(settingsAfter.thinkMaxSubQueries).toBe(settingsBefore.thinkMaxSubQueries);
  });

  it('applies live context controls through the canonical admin settings mutation path', () => {
    const root = makeTempDir();
    const config = buildConfig(root);
    const service = new AdminSettingsDataService({ config });

    const result = service.updateSettings(JSON.stringify({
      extractionThresholdPct: 34,
      compactionThresholdPct: 76,
    }));

    expect(result).toEqual({
      ok: true,
      message: 'Settings updated',
    });
    expect(config.extractionThresholdPct).toBe(34);
    expect(config.compactionThresholdPct).toBe(76);

    const persistedSettings = loadSettings(root);
    expect(persistedSettings.extractionThresholdPct).toBe(34);
    expect(persistedSettings.compactionThresholdPct).toBe(76);
  });

  it('rejects removed runtime settings instead of silently persisting dead knobs', () => {
    const root = makeTempDir();
    const config = buildConfig(root);
    const service = new AdminSettingsDataService({ config });
    const settingsBefore = loadSettings(root);

    const result = service.updateSettings(JSON.stringify({
      memoryBudgetPct: 24,
      defaultContextWindow: 196_000,
      discordEnabled: true,
      discordHeartbeatChannel: '1234567890',
    }));

    expect(result.ok).toBe(false);
    expect(result.message).toContain('memoryBudgetPct has been removed');
    expect(result.message).toContain('defaultContextWindow has been removed');
    expect(result.message).toContain('discordEnabled has been removed');
    expect(result.message).toContain('discordHeartbeatChannel has been removed');
    expect(result.validationErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: 'memoryBudgetPct',
        code: 'removed_field',
      }),
      expect.objectContaining({
        field: 'defaultContextWindow',
        code: 'removed_field',
      }),
      expect.objectContaining({
        field: 'discordEnabled',
        code: 'removed_field',
      }),
      expect.objectContaining({
        field: 'discordHeartbeatChannel',
        code: 'removed_field',
      }),
    ]));

    const settingsAfter = loadSettings(root);
    expect((settingsAfter as Record<string, unknown>).memoryBudgetPct).toBeUndefined();
    expect((settingsAfter as Record<string, unknown>).defaultContextWindow).toBeUndefined();
    expect((settingsAfter as Record<string, unknown>).discordEnabled).toBeUndefined();
    expect((settingsAfter as Record<string, unknown>).discordHeartbeatChannel).toBeUndefined();
    expect(settingsAfter).toEqual(settingsBefore);
  });
});
