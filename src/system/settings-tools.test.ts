import { describe, it, expect } from 'vitest';
import {
  createPromotedToolsAddTool,
  createSettingsGetTool,
  createPromotedToolsListTool,
  createPromotedToolsRemoveTool,
  createPromotedToolsSwapTool,
} from './settings-tools.js';
import type { SubstrateConfig } from './config/runtime-config-contracts.js';

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

describe('settings_get tool', () => {
  it('returns a single key value', async () => {
    const result = await createSettingsGetTool(makeConfig()).execute('call-single', {
      key: 'thinkMaxSubQueries',
    });
    const payload = JSON.parse(readText(result));

    expect(payload.mode).toBe('single');
    expect(payload.key).toBe('thinkMaxSubQueries');
    expect(payload.value).toBe(9);
    expect(result.details.isError).toBeUndefined();
  });

  it('returns discoverable key list mode', async () => {
    const result = await createSettingsGetTool(makeConfig()).execute('call-list', { list: true });
    const payload = JSON.parse(readText(result));

    expect(payload.mode).toBe('list');
    expect(payload.keys).toContain('primaryModel');
    expect(payload.keys).not.toContain('discordToken');
  });

  it('returns subset for keys mode', async () => {
    const result = await createSettingsGetTool(makeConfig()).execute('call-subset', {
      keys: ['primaryModel', 'retryMaxAttempts'],
    });
    const payload = JSON.parse(readText(result));

    expect(payload.mode).toBe('subset');
    expect(payload.settings.primaryModel).toBe('z-ai/glm-5');
    expect(payload.settings.retryMaxAttempts).toBe(3);
    expect(payload.settings.discordToken).toBeUndefined();
  });

  it('returns clear error for unknown keys', async () => {
    const result = await createSettingsGetTool(makeConfig()).execute('call-error', {
      key: 'discordToken',
    });

    expect(readText(result)).toContain('Unknown setting key');
    expect(result.details.isError).toBe(true);
  });
});

describe('promoted tools settings helpers', () => {
  it('returns promoted tool list payload', async () => {
    const listTool = createPromotedToolsListTool({
      getPromotedExtendedToolsLimit: () => 4,
      getPromotedExtendedTools: () => ['repo_status', 'session_list'],
      setPromotedExtendedTools: () => ['repo_status', 'session_list'],
      persistPromotedExtendedTools: () => null,
      addPromotedExtendedTool: () => {
        throw new Error('not used');
      },
      removePromotedExtendedTool: () => {
        throw new Error('not used');
      },
      swapPromotedExtendedTools: () => {
        throw new Error('not used');
      },
    });

    const result = await listTool.execute('call-list', {});
    const payload = JSON.parse(readText(result));
    expect(payload.action).toBe('list');
    expect(payload.maxSlots).toBe(4);
    expect(payload.promotedTools).toEqual(['repo_status', 'session_list']);
  });

  it('marks promoted add errors in tool response details', async () => {
    const addTool = createPromotedToolsAddTool({
      getPromotedExtendedToolsLimit: () => 4,
      getPromotedExtendedTools: () => ['repo_status'],
      setPromotedExtendedTools: () => ['repo_status'],
      persistPromotedExtendedTools: () => null,
      addPromotedExtendedTool: () => ({
        ok: false,
        changed: false,
        promotedTools: ['repo_status'],
        message: 'denied',
        errorCode: 'capability_denied',
        requiredTokens: ['git.write'],
        missingTokens: ['git.write'],
      }),
      removePromotedExtendedTool: () => {
        throw new Error('not used');
      },
      swapPromotedExtendedTools: () => {
        throw new Error('not used');
      },
    });

    const result = await addTool.execute('call-add', { tool: 'repo_commit' });
    const payload = JSON.parse(readText(result));
    expect(payload.action).toBe('add');
    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('capability_denied');
    expect(result.details.isError).toBe(true);
  });

  it('routes remove and swap requests to manager', async () => {
    const removed: string[] = [];
    const swapped: Array<[number, number]> = [];
    const manager = {
      getPromotedExtendedToolsLimit: () => 4,
      getPromotedExtendedTools: () => ['repo_status', 'session_list'],
      setPromotedExtendedTools: (next: readonly string[]) => [...next],
      persistPromotedExtendedTools: () => null,
      addPromotedExtendedTool: () => ({
        ok: true,
        changed: true,
        promotedTools: ['repo_status'],
        message: 'added',
      }),
      removePromotedExtendedTool: (toolName: string) => {
        removed.push(toolName);
        return {
          ok: true,
          changed: true,
          promotedTools: ['session_list'],
          message: 'removed',
        };
      },
      swapPromotedExtendedTools: (fromSlot: number, toSlot: number) => {
        swapped.push([fromSlot, toSlot]);
        return {
          ok: true,
          changed: true,
          promotedTools: ['session_list', 'repo_status'],
          message: 'swapped',
        };
      },
    };

    const removeTool = createPromotedToolsRemoveTool(manager);
    const removeResult = await removeTool.execute('call-remove', { tool: 'repo_status', reason: 'prefer direct lookup' });
    const removePayload = JSON.parse(readText(removeResult));
    expect(removePayload.action).toBe('remove');
    expect(removed).toEqual(['repo_status']);

    const swapTool = createPromotedToolsSwapTool(manager);
    const swapResult = await swapTool.execute('call-swap', { fromSlot: 1, toSlot: 2, reason: 'reorder for shorter prefix' });
    const swapPayload = JSON.parse(readText(swapResult));
    expect(swapPayload.action).toBe('swap');
    expect(swapped).toEqual([[1, 2]]);
  });
});
