import { describe, expect, it } from 'vitest';
import { sanitizeCoreSubstrateConfig, type SubstrateConfig } from './runtime-config-contracts.js';

describe('sanitizeCoreSubstrateConfig', () => {
  it('strips secret-bearing fields before config crosses into core', () => {
    const config: SubstrateConfig = {
      primaryModel: 'deepseek/deepseek-v3.2',
      primaryProvider: 'openrouter',
      extractionModel: 'deepseek/deepseek-v3.2',
      extractionProvider: 'openrouter',
      primaryMaxTokens: 16384,
      extractionMaxTokens: 8192,
      characterCardPath: '/tmp/card.md',
      dataDir: '/tmp/data',
      databasePath: '/tmp/data/companion.db',
      extractionInterval: 5,
      maintenanceIntervalMs: 300_000,
      defaultContextWindow: 128_000,
      extractionThresholdPct: 30,
      compactionThresholdPct: 70,
      modelRoster: {},
      discordToken: 'discord-secret',
      discordBotId: 'bot-id',
      credentialVault: { resolve: () => undefined },
      litellmApiKeyRef: { env: 'LITELLM_API_KEY' },
      openRouterApiKeyRef: { env: 'OPENROUTER_API_KEY' },
      deepgramApiKey: 'deepgram-secret',
      elevenLabsApiKey: 'eleven-secret',
      falApiKey: 'fal-secret',
    };

    const sanitized = sanitizeCoreSubstrateConfig(config) as Record<string, unknown>;

    expect(sanitized.primaryModel).toBe('deepseek/deepseek-v3.2');
    expect(sanitized.credentialVault).toBeUndefined();
    expect(sanitized.discordToken).toBeUndefined();
    expect(sanitized.discordBotId).toBeUndefined();
    expect(sanitized.litellmApiKeyRef).toBeUndefined();
    expect(sanitized.openRouterApiKeyRef).toBeUndefined();
    expect(sanitized.deepgramApiKey).toBeUndefined();
    expect(sanitized.elevenLabsApiKey).toBeUndefined();
    expect(sanitized.falApiKey).toBeUndefined();
  });
});
