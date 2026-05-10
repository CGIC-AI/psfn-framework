import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { saveModelsConfig } from '../../system/config/models-config.js';
import { saveProvidersConfig } from '../../system/config/providers-config.js';
import { prepareAgentStartupContext } from './startup-context.js';

const ORIGINAL_ENV = { ...process.env };
const TEMP_DIRS: string[] = [];
const REQUIRED_OWNER_EXAMPLES = [
  'settings.json',
  'scheduler.json',
  'trust-policy.json',
  'capability-tier.json',
  'charge-policy.json',
  'backup.json',
] as const;

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
  for (const dir of TEMP_DIRS.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function copyOwnerExample(systemDataDir: string, ownerFile: typeof REQUIRED_OWNER_EXAMPLES[number]): void {
  writeFileSync(
    join(systemDataDir, ownerFile),
    readFileSync(join(process.cwd(), 'config', ownerFile.replace(/\.json$/, '.seed.json')), 'utf8'),
    'utf-8',
  );
}

describe('prepareAgentStartupContext', () => {
  it('hydrates owner-file model settings before freezing core runtime config', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'psfn-agent-startup-context-'));
    TEMP_DIRS.push(rootDir);
    const systemDataDir = join(rootDir, 'system-data');
    const companionDataDir = join(rootDir, 'companion-data');
    const workspaceDir = join(rootDir, 'workspace');
    mkdirSync(systemDataDir, { recursive: true });
    mkdirSync(companionDataDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: true });
    for (const ownerFile of REQUIRED_OWNER_EXAMPLES) {
      copyOwnerExample(systemDataDir, ownerFile);
    }

    saveModelsConfig(systemDataDir, {
      schemaVersion: 1,
      models: [
        {
          id: 'primary',
          rank: 50,
          identity: {
            provider: 'litellm',
            model: 'openrouter/z-ai/glm-5.1',
            source: {
              type: 'litellm_proxy',
              label: 'LiteLLM',
              baseUrl: 'https://inference.local.vega.nyc/v1',
            },
          },
          purposes: [
            { purpose: 'chat', primary: true },
            { purpose: 'summary', primary: true },
            { purpose: 'reasoning', primary: true },
            { purpose: 'moa', primary: true },
          ],
          capabilities: {
            maxOutputTokens: 65535,
            contextWindow: 202752,
            supportsVision: false,
            supportsReasoning: true,
          },
          tuning: {
            maxOutputTokens: 65535,
          },
        },
        {
          id: 'extraction',
          rank: 20,
          identity: {
            provider: 'openrouter',
            model: 'openrouter/deepseek/deepseek-v3.2-speciale',
            source: {
              type: 'openrouter',
              label: 'OpenRouter',
            },
          },
          purposes: [
            { purpose: 'background', primary: true },
            { purpose: 'memory', primary: true },
            { purpose: 'extraction', primary: true },
            { purpose: 'import_processing', primary: true },
          ],
          capabilities: {
            maxOutputTokens: 163840,
            contextWindow: 163840,
            supportsReasoning: true,
          },
          tuning: {
            maxOutputTokens: 163840,
          },
        },
        {
          id: 'vision',
          rank: 10,
          identity: {
            provider: 'openrouter',
            model: 'openrouter/google/gemini-3.1-flash-lite-preview',
            source: {
              type: 'openrouter',
              label: 'OpenRouter',
            },
          },
          purposes: [
            { purpose: 'vision', primary: true },
            { purpose: 'longContext', primary: true },
          ],
          capabilities: {
            maxOutputTokens: 65536,
            contextWindow: 1048576,
            supportsVision: true,
            supportsReasoning: true,
          },
          tuning: {
            maxOutputTokens: 65536,
          },
        },
      ],
    }, { defaultContextWindow: 128_000 });

    saveProvidersConfig(systemDataDir, {
      schemaVersion: 1,
      providers: [
        {
          id: 'litellm',
          type: 'litellm_proxy',
          enabled: true,
          label: 'LiteLLM',
          apiBaseUrl: 'https://inference.local.vega.nyc/v1',
          apiKeyRef: {
            kind: 'env',
            envName: 'LITELLM_API_KEY',
          },
        },
        {
          id: 'openrouter',
          type: 'openrouter',
          enabled: true,
          label: 'OpenRouter',
          apiBaseUrl: 'https://openrouter.ai/api/v1',
          modelsApiUrl: 'https://openrouter.ai/api/v1/models',
          apiKeyRef: {
            kind: 'env',
            envName: 'OPENROUTER_API_KEY',
          },
        },
      ],
    });

    process.env.DATA_DIR = systemDataDir;
    delete process.env.SYSTEM_DATA_DIR;
    delete process.env.COMPANION_DATA_DIR;
    process.env.WORKSPACE_PATH = workspaceDir;
    process.env.CHARACTER_CARD_PATH = join(systemDataDir, 'purrsephone.json');
    process.env.COMPANION_ID = 'test-companion';
    process.env.LITELLM_API_KEY = 'test-litellm-key';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';

    const context = prepareAgentStartupContext({
      env: process.env,
      log: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    try {
      expect(context.config.primaryModel).toBe('openrouter/z-ai/glm-5.1');
      expect(context.config.modelRoster.vision?.model).toBe('openrouter/google/gemini-3.1-flash-lite-preview');
      expect(context.coreConfig.primaryModel).toBe('openrouter/z-ai/glm-5.1');
      expect(context.coreConfig.modelRoster.vision?.model).toBe('openrouter/google/gemini-3.1-flash-lite-preview');
      expect(context.coreConfig.modelRoster.chat?.provider).toBe('litellm');
    } finally {
      context.stopDebugObserver();
    }
  });
});
