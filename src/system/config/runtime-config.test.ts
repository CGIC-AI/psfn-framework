import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './load-config.js';
import { hydrateJsonBackedRuntimeConfig } from './runtime-config.js';
import { makeTestFatiguePolicyConfig } from '../../test-support/charge-policy.js';

const ORIGINAL_ENV = { ...process.env };
const TEMP_DIRS: string[] = [];

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv();
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    if (!dir) continue;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('hydrateJsonBackedRuntimeConfig', () => {
  function copyOwnerExample(dataDir: string, ownerFile: string): void {
    const exampleFile = ownerFile.replace(/\.json$/, '.seed.json');
    writeFileSync(
      join(dataDir, ownerFile),
      readFileSync(join(process.cwd(), 'config', exampleFile), 'utf8'),
      'utf8',
    );
  }

  // The companions.json manifest is mandatory. A one-entry manifest is the
  // single-companion topology (multiCompanion=false), which loadConfig treats
  // identically to the old single-companion behavior.
  function writeSingleCompanionManifest(dataDir: string): void {
    writeFileSync(
      join(dataDir, 'companions.json'),
      `${JSON.stringify({
        companions: [{
          companionId: '11111111-1111-4111-8111-111111111111',
          companionDataDir: 'companion',
          characterCardPath: 'companion/companion.json',
          postgresSchema: 'public',
        }],
      })}\n`,
      'utf8',
    );
  }

  it('still validates the scheduler owner even though no scheduler field is projected onto config', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-runtime-config-scheduler-validation-'));
    TEMP_DIRS.push(dataDir);
    for (const ownerFile of [
      'settings.json',
      'models.json',
      'providers.json',
      'scheduler.json',
      'capability-tier.json',
      'charge-policy.json',
    ]) {
      copyOwnerExample(dataDir, ownerFile);
    }
    writeSingleCompanionManifest(dataDir);
    const schedulerPath = join(dataDir, 'scheduler.json');
    const scheduler = JSON.parse(readFileSync(schedulerPath, 'utf8')) as Record<string, unknown>;
    scheduler.backgroundMaintenance = {
      ...(scheduler.backgroundMaintenance as Record<string, unknown>),
      intervalMs: 9 * 60 * 60_000,
    };
    writeFileSync(schedulerPath, `${JSON.stringify(scheduler, null, 2)}\n`, 'utf8');
    process.env.DATA_DIR = dataDir;
    process.env.COMPANION_ID = '11111111-1111-4111-8111-111111111111';
    process.env.POSTGRES_DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/test';
    process.env.CONFIG_DIR = 'config';

    expect(() => hydrateJsonBackedRuntimeConfig(loadConfig(), { seedDir: 'config' })).toThrow(
      /backgroundMaintenance\.intervalMs.*phase-lock/s,
    );
  });

  it('prefers owner-file models and runtime settings over ignored env defaults', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'psfn-runtime-config-'));
    TEMP_DIRS.push(dataDir);
    for (const ownerFile of [
      'providers.json',
      'scheduler.json',
      'capability-tier.json',
      'trust-policy.json',
    ]) {
      copyOwnerExample(dataDir, ownerFile);
    }
    writeSingleCompanionManifest(dataDir);

    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
      analysisWorkbenchMaxTokens: 180000,
      analysisWorkbenchMaxWallTimeMs: 180000,
      analysisWorkbenchMaxSubQueries: 24,
      imageProvider: 'fal',
      imageFalCreateModel: 'fal-ai/nano-banana-2',
      imageFalEditModel: 'xai/grok-imagine-image/quality/edit',
      imageSelfieEditModel: 'fal-ai/nano-banana-2/edit',
      modelPurposeSelection: { chat: 'extraction' },
    }), 'utf8');
    writeFileSync(join(dataDir, 'models.json'), JSON.stringify({
      schemaVersion: 1,
      models: [
        {
          id: 'primary',
          rank: 100,
          identity: {
            provider: 'openrouter',
            model: 'google/gemini-3-flash-preview',
            source: { type: 'openrouter' },
          },
          purposes: [
            { purpose: 'chat', primary: true },
            { purpose: 'summary', primary: true },
            { purpose: 'reasoning', primary: true },
            { purpose: 'longContext', primary: true },
            { purpose: 'vision', primary: true },
            { purpose: 'moa', primary: true },
          ],
          capabilities: {
            maxOutputTokens: 12288,
            contextWindow: 1048576,
          },
          tuning: {
            maxOutputTokens: 12288,
          },
        },
        {
          id: 'extraction',
          rank: 80,
          identity: {
            provider: 'openrouter',
            model: 'deepseek/deepseek-v3.2',
            source: { type: 'openrouter' },
          },
          purposes: [
            { purpose: 'background', primary: true },
            { purpose: 'memory', primary: true },
            { purpose: 'extraction', primary: true },
            { purpose: 'import_processing', primary: true },
          ],
          capabilities: {
            maxOutputTokens: 8192,
            contextWindow: 128000,
          },
          tuning: {
            maxOutputTokens: 8192,
          },
        },
      ],
    }), 'utf8');
    writeFileSync(join(dataDir, 'charge-policy.json'), JSON.stringify({
      schemaVersion: 1,
      runChargeQuotaByLane: {
        interactive: 20,
        companion_social: 12,
        background: 8,
        maintenance: 0,
        subagent: 4,
        shard: 9,
      },
      surfaceCosts: {
        ownerFileInspection: 0,
        localFilesystem: 0,
        memoryRead: 0,
        memoryWrite: 0,
        localEmbedding: 0,
        externalEmbedding: 0,
        localImageGeneration: 0,
        paidImageGeneration: 5,
        analysisWorkbenchExtensionBand: 4,
        subagentLaunch: 1,
        shardLaunch: 7,
        externalModelConsult: 1,
        moaRoundBase: 1,
        companionSocialContinuation: 1,
      },
      surfaceRationales: {
        paidImageGeneration: 'External image generation spends paid provider credits.',
        analysisWorkbenchExtensionBand: 'Extended analysis workbench loops reserve scarce deep-analysis budget after the first pass.',
        subagentLaunch: 'Spawning a subagent reserves a separate runtime budget.',
        shardLaunch: 'Launching a shard consumes worker coordination overhead.',
        externalModelConsult: 'Consulting an external model uses a paid API boundary.',
        moaRoundBase: 'Each MOA round carries coordination overhead even before model spend.',
        companionSocialContinuation: 'Autonomous companion continuation spends relationship-sensitive social budget.',
      },
      moa: {
        perRoundMultiplierByReferenceModelClass: {
          local: 1,
          subscription: 1,
          cheap_cloud: 1,
          premium_cloud: 2,
        },
      },
      referenceModelClassPricing: {
        local: 0,
        subscription: 0,
        cheap_cloud: 1,
        premium_cloud: 4,
      },
      referenceModelClassPricingRationales: {
        cheap_cloud: 'Cheap cloud models are lightly priced to keep them available for routine use.',
        premium_cloud: 'Premium cloud models are intentionally more expensive to reserve for high-value calls.',
      },
      icpCostBreaker: {
        enabled: false,
      },
      fatigue: makeTestFatiguePolicyConfig(),
    }), 'utf8');

    process.env.DATA_DIR = dataDir;
    process.env.COMPANION_ID = '11111111-1111-4111-8111-111111111111';
    process.env.POSTGRES_DATABASE_URL = 'postgresql://test:test@127.0.0.1:5432/test';
    process.env.CONFIG_DIR = 'config';
    process.env.PRIMARY_MODEL = 'env-primary-should-be-ignored';
    process.env.THINK_MAX_TOKENS = '999999';
    process.env.THINK_MAX_WALL_TIME_MS = '999999';
    process.env.THINK_MAX_SUB_QUERIES = '99';

    const config = hydrateJsonBackedRuntimeConfig(loadConfig(), { seedDir: 'config' });

    expect(config.primaryModel).toBe('google/gemini-3-flash-preview');
    expect(config.primaryProvider).toBe('openrouter');
    expect(config.primaryMaxTokens).toBe(12288);
    expect(config.analysisWorkbenchMaxTokens).toBe(180000);
    expect(config.analysisWorkbenchMaxWallTimeMs).toBe(180000);
    expect(config.analysisWorkbenchMaxSubQueries).toBe(24);
    expect(config.imageProvider).toBe('fal');
    expect(config.imageFalCreateModel).toBe('fal-ai/nano-banana-2');
    expect(config.imageFalEditModel).toBe('xai/grok-imagine-image/quality/edit');
    expect(config.imageSelfieEditModel).toBe('fal-ai/nano-banana-2/edit');
    // 23pp: selection referencing a valid models.json slot survives hydration.
    expect(config.modelPurposeSelection).toEqual({ chat: 'extraction' });
    expect(config.chargePolicy?.surfaceCosts.shardLaunch).toBe(7);

    // 23pp fail-closed: a selection referencing an unknown models.json slot
    // stops hydration with an actionable message.
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({
      modelPurposeSelection: { vision: 'no-such-slot' },
    }), 'utf8');
    expect(() => hydrateJsonBackedRuntimeConfig(loadConfig(), { seedDir: 'config' })).toThrow(
      /modelPurposeSelection\.vision.*"no-such-slot".*primary, extraction/s,
    );
  });
});
