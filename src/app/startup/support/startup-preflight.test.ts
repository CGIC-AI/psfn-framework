import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { saveSettings } from '../../../system/settings.js';
import {
  loadSchedulerSeedDefaults,
  saveSchedulerConfig,
} from '../../../system/config/scheduler-config.js';
import {
  RUNTIME_MODE,
  resolveRuntimeModeContract,
  toRuntimeStatusMetadata,
} from '../../../system/lifecycle/runtime-mode.js';
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

  it('rejects disabled startup contracts through the shared preflight surface', () => {
    expect(() => resolveStartupLifecycleBundle({
      entrypoint: 'single' as any,
      env: {},
    })).toThrow('Unsupported runtime entrypoint "single"');
  });
});

describe('resolveStartupPreflightBundle', () => {
  const tempDirs: string[] = [];
  const requiredOwnerFiles = [
    'models.json',
    'providers.json',
    'trust-policy.json',
    'capability-tier.json',
    'charge-policy.json',
  ] as const;

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function copyOwnerExample(systemDataDir: string, ownerFile: typeof requiredOwnerFiles[number]): void {
    writeFileSync(
      join(systemDataDir, ownerFile),
      readFileSync(
        join(process.cwd(), 'config', ownerFile.replace(/\.json$/, '.seed.json')),
        'utf8',
      ),
      'utf-8',
    );
  }

  it('warns on ignored JSON-owned env keys and returns hydrated startup state', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-preflight-'));
    const systemDataDir = join(rootDir, 'system-data');
    const companionDataDir = join(rootDir, 'companion-data');
    const legacyDataDir = join(rootDir, 'legacy-data-empty');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(companionDataDir, { recursive: true });
    mkdirSync(legacyDataDir, { recursive: true });
    tempDirs.push(rootDir);
    for (const ownerFile of requiredOwnerFiles) {
      copyOwnerExample(systemDataDir, ownerFile);
    }

    saveSettings(systemDataDir, {
      sessionMessageLimit: 41,
      memoryRetrievalLimit: 12,
    });
    saveSchedulerConfig(systemDataDir, {
      ...loadSchedulerSeedDefaults(),
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

  it('requires explicit WORKSPACE_PATH for production startup preflight', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-startup-preflight-production-'));
    const systemDataDir = join(rootDir, 'system-data');
    const companionDataDir = join(rootDir, 'companion-data');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(companionDataDir, { recursive: true });
    tempDirs.push(rootDir);
    for (const ownerFile of requiredOwnerFiles) {
      copyOwnerExample(systemDataDir, ownerFile);
    }
    saveSettings(systemDataDir, {});
    saveSchedulerConfig(systemDataDir, loadSchedulerSeedDefaults());

    const config = makeStartupHydrationConfig(systemDataDir, companionDataDir);
    const env = {
      CONFIG_DIR: './config',
      PSFN_RUNTIME_LAYOUT_MODE: 'production',
      SYSTEM_DATA_DIR: systemDataDir,
      COMPANION_DATA_DIR: companionDataDir,
    };

    expect(() => resolveStartupPreflightBundle(config, {
      entrypoint: RUNTIME_MODE.GATEWAY_AGENT,
      env,
      logger: { warn: vi.fn() },
    })).toThrow(
      'WORKSPACE_PATH is required for production runtime startup. Set WORKSPACE_PATH to the explicit personal files root.',
    );
  });
});
