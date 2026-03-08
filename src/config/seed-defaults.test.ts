import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

  it('loads runtime defaults from settings.seed.json', () => {
    const defaults = loadRuntimeSettingsSeedDefaults();
    expect(defaults.deepgramModel).toBe('nova-3');
    expect(defaults.openRouterModelsApiUrl).toBe('https://openrouter.ai/api/v1/models');
    expect(defaults.embeddingProvider).toBe('ollama');
    expect(defaults.embeddingModel).toBe('snowflake-arctic-embed2');
    expect(defaults.embeddingDims).toBe(1024);
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
    writeFileSync(join(seedDir, 'settings.seed.json'), JSON.stringify({
      embeddingProvider: 'ollama',
      embeddingDims: 1024,
      embeddingOllamaUrl: 'http://localhost:11434',
      transformersModel: 'Xenova/all-MiniLM-L6-v2',
      embeddingApiModel: 'snowflake-arctic-embed2',
      embeddingApiDims: 1024,
      deepgramModel: 'nova-3',
      deepgramSttEndpoint: 'wss://api.deepgram.com/v1/listen',
      deepgramListenEndpoint: 'https://api.deepgram.com/v1/listen',
      elevenLabsModelId: 'eleven_turbo_v2_5',
      elevenLabsEndpointBase: 'https://api.elevenlabs.io/v1',
      openRouterModelsApiUrl: 'https://openrouter.ai/api/v1/models',
    }), 'utf-8');

    expect(() => loadRuntimeSettingsSeedDefaults(seedDir)).toThrow('embeddingModel');
  });
});
