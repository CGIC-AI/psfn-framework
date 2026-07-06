import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadModelSeedDefaults, loadRuntimeSettingsSeedDefaults } from './seed-defaults.js';

describe('seed defaults', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (!root) continue;
      rmSync(root, { recursive: true, force: true });
    }
  });

  function makeSeedDir(prefix: string): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    tempRoots.push(root);
    const seedDir = join(root, 'config');
    mkdirSync(seedDir, { recursive: true });
    return seedDir;
  }

  it('loads model defaults from models.seed.json', () => {
    const defaults = loadModelSeedDefaults();
    expect(defaults.primary).toEqual({
      provider: 'openrouter',
      model: 'z-ai/glm-5',
      maxOutputTokens: 16_384,
      contextWindow: 128_000,
    });
    expect(defaults.extraction).toEqual({
      provider: 'openrouter',
      model: 'deepseek/deepseek-v3.2',
      maxOutputTokens: 8_192,
      contextWindow: 128_000,
    });
  });

  it('keeps the explicit nano chat fallback in models.seed.json', () => {
    const seed = JSON.parse(readFileSync('config/models.seed.json', 'utf-8')) as {
      models: Array<{
        id: string;
        identity: { provider: string; model: string; source?: { type?: string } };
        purposes?: Array<{ purpose: string; primary?: boolean }>;
      }>;
    };
    const fallback = seed.models.find(entry => entry.id === 'gpt-5.4-nano');

    expect(fallback).toMatchObject({
      identity: {
        provider: 'openrouter',
        model: 'openai/gpt-5.4-nano',
        source: { type: 'openrouter' },
      },
    });
    expect(fallback?.purposes).toContainEqual({ purpose: 'chat', primary: false });
  });

  it('loads runtime defaults from settings.seed.json', () => {
    const defaults = loadRuntimeSettingsSeedDefaults();
    expect(defaults.analysisWorkbenchMaxTokens).toBe(76_000);
    expect(defaults.analysisWorkbenchMaxWallTimeMs).toBe(300_000);
    expect(defaults.analysisWorkbenchMaxSubQueries).toBe(24);
    expect(defaults.deepgramModel).toBe('nova-3');
    expect(defaults.openRouterModelsApiUrl).toBe('https://openrouter.ai/api/v1/models');
    expect(defaults.embeddingProvider).toBe('transformers');
    expect(defaults.embeddingModel).toBe('Xenova/all-MiniLM-L6-v2');
    expect(defaults.embeddingDims).toBe(384);
    expect(defaults.textEmotionModel).toBe('SamLowe/roberta-base-go_emotions-onnx');
    expect(defaults.textEmotionDtype).toBe('fp32');
    expect(defaults.textEmotionCacheDir).toBe('models/transformers');
    expect(defaults.embeddingApiModel).toBe('snowflake-arctic-embed2');
  });

  it('fails closed when required runtime embedding defaults are missing', () => {
    const seedDir = makeSeedDir('psfn-seed-defaults-');
    writeFileSync(join(seedDir, 'models.seed.json'), JSON.stringify({
      schemaVersion: 1,
      models: [
        {
          id: 'primary',
          identity: { provider: 'openrouter', model: 'openai/gpt-4.1-mini' },
          capabilities: { maxOutputTokens: 4096, contextWindow: 128000 },
        },
        {
          id: 'extraction',
          identity: { provider: 'openrouter', model: 'deepseek/deepseek-v3.2' },
          capabilities: { maxOutputTokens: 2048, contextWindow: 128000 },
        },
      ],
    }), 'utf-8');
    const settingsSeed = JSON.parse(readFileSync('config/settings.seed.json', 'utf-8')) as Record<string, unknown>;
    delete settingsSeed.embeddingModel;
    writeFileSync(join(seedDir, 'settings.seed.json'), JSON.stringify(settingsSeed), 'utf-8');

    expect(() => loadRuntimeSettingsSeedDefaults(seedDir)).toThrow('embeddingModel');
  });

  it('preserves seed positive integer field-path wording', () => {
    const seedDir = makeSeedDir('psfn-seed-defaults-invalid-positive-integer-');
    writeFileSync(join(seedDir, 'models.seed.json'), readFileSync('config/models.seed.json', 'utf-8'), 'utf-8');
    const settingsSeed = JSON.parse(readFileSync('config/settings.seed.json', 'utf-8')) as Record<string, unknown>;
    settingsSeed.embeddingDims = 0;
    writeFileSync(join(seedDir, 'settings.seed.json'), JSON.stringify(settingsSeed), 'utf-8');

    expect(() => loadRuntimeSettingsSeedDefaults(seedDir)).toThrow(
      `${join(seedDir, 'settings.seed.json')}.embeddingDims must be a positive integer`,
    );
  });
});
