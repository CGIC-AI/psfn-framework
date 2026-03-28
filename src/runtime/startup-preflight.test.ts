import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SubstrateConfig } from '../types.js';
import { saveSettings } from '../settings.js';
import { saveSchedulerConfig } from '../config/scheduler-config.js';
import {
  RUNTIME_MODE,
  resolveRuntimeModeContract,
  toRuntimeStatusMetadata,
} from '../lifecycle/runtime-mode.js';
import {
  resolveStartupLifecycleBundle,
  resolveStartupPreflightBundle,
} from './startup-preflight.js';

function makeStartupHydrationConfig(
  systemDataDir: string,
  companionDataDir: string,
): SubstrateConfig {
  return {
    primaryModel: 'openrouter/deepseek/deepseek-v3.2',
    primaryProvider: 'openrouter',
    extractionModel: 'openrouter/deepseek/deepseek-v3.2',
    extractionProvider: 'openrouter',
    primaryMaxTokens: 8192,
    extractionMaxTokens: 4096,
    discordToken: '',
    discordBotId: '',
    characterCardPath: join(companionDataDir, 'character.json'),
    systemDataDir,
    companionDataDir,
    dataDir: systemDataDir,
    databasePath: join(companionDataDir, 'companion.db'),
    sessionMessageLimit: 30,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    modelRoster: {
      chat: {
        model: 'openrouter/deepseek/deepseek-v3.2',
        provider: 'openrouter',
        maxTokens: 8192,
        contextWindow: 128_000,
      },
      background: {
        model: 'openrouter/deepseek/deepseek-v3.2',
        provider: 'openrouter',
        maxTokens: 4096,
      },
    },
  };
}

describe('resolveStartupLifecycleBundle', () => {
  it.each([
    RUNTIME_MODE.SPLIT,
    RUNTIME_MODE.GATEWAY_AGENT,
  ])('matches runtime-mode contract semantics for %s entrypoints', (entrypoint) => {
    const bundle = resolveStartupLifecycleBundle({
      entrypoint,
      env: {
        PSFN_RUNTIME_MODE: entrypoint,
      },
    });
    const contract = resolveRuntimeModeContract({
      entrypoint,
      runtimeModeEnv: entrypoint,
    });

    expect(bundle.lifecycleRuntimeContract).toEqual(contract);
    expect(bundle.runtimeStatusMeta).toEqual(toRuntimeStatusMetadata(contract));
  });

  it('rejects monolithic startup contracts through the shared preflight surface', () => {
    expect(() => resolveStartupLifecycleBundle({
      entrypoint: RUNTIME_MODE.SINGLE,
      env: {},
    })).toThrow('Monolithic runtime mode has been removed');
  });
});

describe('resolveStartupPreflightBundle', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns on ignored JSON-owned env keys and returns hydrated startup state', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-preflight-'));
    const systemDataDir = join(rootDir, 'system-data');
    const companionDataDir = join(rootDir, 'companion-data');
    const legacyDataDir = join(rootDir, 'legacy-data-empty');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(companionDataDir, { recursive: true });
    mkdirSync(legacyDataDir, { recursive: true });
    tempDirs.push(rootDir);

    saveSettings(systemDataDir, {
      sessionMessageLimit: 41,
      memoryRetrievalLimit: 12,
    });
    saveSchedulerConfig(systemDataDir, {
      tickIntervalMs: 2_000,
      heartbeatIntervalMs: 8_000,
      salienceDecayIntervalMs: 123_000,
    });

    const config = makeStartupHydrationConfig(systemDataDir, companionDataDir);
    const logger = { warn: vi.fn() };
    const env = {
      ...process.env,
      CONFIG_DIR: './config',
      PSFN_RUNTIME_LAYOUT_MODE: 'continuous',
      DATA_DIR: legacyDataDir,
      PRIMARY_MODEL: 'env-owned-model-should-be-ignored',
      EXTRACTION_INTERVAL: '12',
    };

    const bundle = resolveStartupPreflightBundle(config, {
      entrypoint: RUNTIME_MODE.GATEWAY_AGENT,
      env,
      logger,
    });

    expect(bundle.ignoredMutableEnvKeys).toEqual(['PRIMARY_MODEL', 'EXTRACTION_INTERVAL']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'Ignoring JSON-owned config env vars; move runtime config into system-data JSON files and keep .env for secrets/bootstrap wiring only',
      { keys: ['PRIMARY_MODEL', 'EXTRACTION_INTERVAL'] },
    );
    expect(bundle.lifecycleRuntimeContract).toEqual(resolveRuntimeModeContract({
      entrypoint: RUNTIME_MODE.GATEWAY_AGENT,
      runtimeModeEnv: undefined,
      restartCommandEnv: undefined,
    }));
    expect(bundle.runtimeStatusMeta).toEqual(toRuntimeStatusMetadata(bundle.lifecycleRuntimeContract));
    expect(bundle.startupHydration.systemDataDir).toBe(systemDataDir);
    expect(bundle.startupHydration.companionDataDir).toBe(companionDataDir);
    expect(bundle.startupHydration.pathSnapshot.systemDataDir).toBe(systemDataDir);
    expect(bundle.startupHydration.pathSnapshot.companionDataDir).toBe(companionDataDir);
    expect(bundle.startupHydration.schedulerConfig.salienceDecayIntervalMs).toBe(123_000);
    expect(config.sessionMessageLimit).toBe(30);
    expect(config.memoryRetrievalLimit).toBe(15);
    expect(config.maintenanceIntervalMs).toBe(123_000);
  });
});
