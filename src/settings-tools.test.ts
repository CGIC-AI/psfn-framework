import { describe, it, expect } from 'vitest';
import { createSettingsGetTool } from './settings-tools.js';
import type { SubstrateConfig } from './types.js';

function makeConfig(): SubstrateConfig {
  return {
    primaryModel: 'z-ai/glm-5',
    primaryProvider: 'openrouter',
    extractionModel: 'deepseek/deepseek-v3.2',
    extractionProvider: 'openrouter',
    discordToken: 'secret-token',
    discordBotId: '123',
    characterCardPath: '',
    dataDir: './data',
    databasePath: '',
    sessionMessageLimit: 30,
    memoryRetrievalLimit: 15,
    extractionInterval: 5,
    primaryMaxTokens: 16384,
    extractionMaxTokens: 8192,
    maintenanceIntervalMs: 300_000,
    defaultContextWindow: 128_000,
    memoryBudgetPct: 20,
    extractionThresholdPct: 30,
    compactionThresholdPct: 70,
    compactionEmotionalSalienceThresholdPct: 75,
    modelRoster: {
      chat: {
        model: 'z-ai/glm-5',
        provider: 'openrouter',
        maxTokens: 16384,
        contextWindow: 128_000,
      },
      background: {
        model: 'deepseek/deepseek-v3.2',
        provider: 'openrouter',
        maxTokens: 8192,
      },
    },
    thinkMaxSubQueries: 9,
    retryMaxAttempts: 3,
    retryBaseDelayMs: 2000,
  };
}

function readText(result: { content: Array<{ text?: string }> }): string {
  return result.content[0]?.text ?? '';
}

describe('createSettingsGetTool', () => {
  it('returns a single key value', async () => {
    const tool = createSettingsGetTool(makeConfig());
    const result = await tool.execute('call-1', { key: 'thinkMaxSubQueries' });
    const payload = JSON.parse(readText(result));

    expect(payload.mode).toBe('single');
    expect(payload.key).toBe('thinkMaxSubQueries');
    expect(payload.value).toBe(9);
    expect(result.details.isError).toBeUndefined();
  });

  it('returns discoverable key list mode', async () => {
    const tool = createSettingsGetTool(makeConfig());
    const result = await tool.execute('call-2', { list: true });
    const payload = JSON.parse(readText(result));

    expect(payload.mode).toBe('list');
    expect(payload.keys).toContain('primaryModel');
    expect(payload.keys).not.toContain('discordToken');
  });

  it('returns subset for keys mode', async () => {
    const tool = createSettingsGetTool(makeConfig());
    const result = await tool.execute('call-3', {
      keys: ['primaryModel', 'retryMaxAttempts'],
    });
    const payload = JSON.parse(readText(result));

    expect(payload.mode).toBe('subset');
    expect(payload.settings.primaryModel).toBe('z-ai/glm-5');
    expect(payload.settings.retryMaxAttempts).toBe(3);
    expect(payload.settings.discordToken).toBeUndefined();
  });

  it('returns clear error for unknown keys', async () => {
    const tool = createSettingsGetTool(makeConfig());
    const result = await tool.execute('call-4', { key: 'discordToken' });

    expect(readText(result)).toContain('Unknown setting key');
    expect(result.details.isError).toBe(true);
  });
});
