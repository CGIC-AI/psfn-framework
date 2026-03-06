import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from './types.js';

const ORIGINAL_ENV = { ...process.env };

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

function clearRuntimePathEnv(): void {
  delete process.env.DATA_DIR;
  delete process.env.SYSTEM_DATA_DIR;
  delete process.env.COMPANION_DATA_DIR;
  delete process.env.DATABASE_PATH;
  delete process.env.DATABASE_BASENAME;
  delete process.env.CHARACTER_CARD_PATH;
  delete process.env.PSFN_RUNTIME_LAYOUT_MODE;
  delete process.env.PSFN_RUNTIME_ROOT;
  delete process.env.WORKSPACE_PATH;
  delete process.env.PSFN_LOGS_DIR;
  delete process.env.PSFN_TEMP_DIR;
  delete process.env.BACKUP_ROOT_DIR;
}

afterEach(() => {
  restoreEnv();
});

describe('loadConfig path defaults', () => {
  it('uses data-dir-relative defaults when explicit paths are not set', () => {
    clearRuntimePathEnv();

    const config = loadConfig();
    expect(config.systemDataDir).toBe('./data');
    expect(config.companionDataDir).toBe('./data');
    expect(config.dataDir).toBe('./data');
    expect(config.characterCardPath).toBe('./data/character.json');
    expect(config.databasePath).toBe('./data/companion.db');
  });

  it('derives card/database paths from DATA_DIR when only DATA_DIR is set', () => {
    clearRuntimePathEnv();
    process.env.DATA_DIR = './sandbox-data';

    const config = loadConfig();
    expect(config.systemDataDir).toBe('./sandbox-data');
    expect(config.companionDataDir).toBe('./sandbox-data');
    expect(config.dataDir).toBe('./sandbox-data');
    expect(config.characterCardPath).toBe('./sandbox-data/character.json');
    expect(config.databasePath).toBe('./sandbox-data/companion.db');
  });

  it('respects explicit CHARACTER_CARD_PATH and DATABASE_PATH overrides', () => {
    clearRuntimePathEnv();
    process.env.DATA_DIR = './sandbox-data';
    process.env.CHARACTER_CARD_PATH = './cards/main.json';
    process.env.DATABASE_PATH = './db/main.db';

    const config = loadConfig();
    expect(config.systemDataDir).toBe('./sandbox-data');
    expect(config.companionDataDir).toBe('./sandbox-data');
    expect(config.dataDir).toBe('./sandbox-data');
    expect(config.characterCardPath).toBe('./cards/main.json');
    expect(config.databasePath).toBe('./db/main.db');
  });

  it('derives database path from DATABASE_BASENAME when DATABASE_PATH is not set', () => {
    clearRuntimePathEnv();
    process.env.DATA_DIR = './sandbox-data';
    process.env.DATABASE_BASENAME = 'Companion Prime';

    const config = loadConfig();
    expect(config.databasePath).toBe('./sandbox-data/companion-prime.db');
  });

  it('supports explicit split system and companion roots', () => {
    clearRuntimePathEnv();
    process.env.SYSTEM_DATA_DIR = './system-data';
    process.env.COMPANION_DATA_DIR = './companion-data';

    const config = loadConfig();
    expect(config.systemDataDir).toBe('./system-data');
    expect(config.companionDataDir).toBe('./companion-data');
    expect(config.dataDir).toBe('./system-data');
    expect(config.characterCardPath).toBe('./companion-data/character.json');
    expect(config.databasePath).toBe('./companion-data/companion.db');
  });

  it('resolves isolated production-mode defaults when runtime layout mode is production', () => {
    clearRuntimePathEnv();
    process.env.PSFN_RUNTIME_LAYOUT_MODE = 'production';

    const config = loadConfig();
    expect(config.systemDataDir).toBe('./runtime/production/system-data');
    expect(config.companionDataDir).toBe('./runtime/production/companion-data');
    expect(config.dataDir).toBe('./runtime/production/system-data');
    expect(config.characterCardPath).toBe('./runtime/production/companion-data/character.json');
    expect(config.databasePath).toBe('./runtime/production/companion-data/companion.db');
  });

  it('rejects shared DATA_DIR fallback when runtime layout mode resolves to production', () => {
    clearRuntimePathEnv();
    process.env.NODE_ENV = 'production';
    process.env.DATA_DIR = './shared-data';

    expect(() => loadConfig()).toThrow('DATA_DIR shared-root mode is forbidden');
  });

  it('rejects partial split-root configuration', () => {
    clearRuntimePathEnv();
    process.env.SYSTEM_DATA_DIR = './system-data';

    expect(() => loadConfig()).toThrow(
      'SYSTEM_DATA_DIR and COMPANION_DATA_DIR must both be set together',
    );
  });

  it('ignores JSON-backed config env vars and keeps canonical defaults until JSON config is loaded', () => {
    clearRuntimePathEnv();
    process.env.PRIMARY_MODEL = 'env-primary';
    process.env.PRIMARY_PROVIDER = 'env-provider';
    process.env.PRIMARY_MAX_TOKENS = '999';
    process.env.DEFAULT_CONTEXT_WINDOW = '4096';
    process.env.EXTRACTION_MODEL = 'env-extraction';
    process.env.EXTRACTION_PROVIDER = 'env-extraction-provider';
    process.env.EXTRACTION_MAX_TOKENS = '111';
    process.env.SESSION_MESSAGE_LIMIT = '77';
    process.env.MAINTENANCE_INTERVAL_MS = '1234';
    process.env.RETRY_MAX_ATTEMPTS = '9';
    process.env.DEEPGRAM_MODEL = 'env-deepgram';
    process.env.DISCORD_TRIGGER_REACTIONS = '🔥';
    process.env.TELEGRAM_ENABLED = 'true';
    process.env.OBSIDIAN_AUTO_PUBLISH = 'true';
    process.env.TTS_PROVIDER = 'echo';

    const config = loadConfig();
    expect(config.primaryModel).toBe('z-ai/glm-5');
    expect(config.primaryProvider).toBe('openrouter');
    expect(config.primaryMaxTokens).toBe(16_384);
    expect(config.defaultContextWindow).toBe(128_000);
    expect(config.extractionModel).toBe('deepseek/deepseek-v3.2');
    expect(config.extractionProvider).toBe('openrouter');
    expect(config.extractionMaxTokens).toBe(8_192);
    expect(config.sessionMessageLimit).toBe(30);
    expect(config.maintenanceIntervalMs).toBe(300_000);
    expect(config.retryMaxAttempts).toBe(3);
    expect(config.deepgramModel).toBe('nova-3');
    expect(config.discordTriggerReactions).toEqual(['👆']);
    expect(config.telegramEnabled).toBe(false);
    expect(config.obsidianAutoPublish).toBe(false);
    expect(config.ttsProvider).toBeUndefined();
  });

  it('still reads secret and bootstrap env wiring', () => {
    clearRuntimePathEnv();
    process.env.DATA_DIR = './sandbox-data';
    process.env.DISCORD_TOKEN = 'discord-secret';
    process.env.DEEPGRAM_API_KEY = 'deepgram-secret';
    process.env.ELEVENLABS_API_KEY = 'eleven-secret';
    process.env.GATEWAY_TLS_CA_PATH = './certs/dev-ca.pem';

    const config = loadConfig();
    expect(config.dataDir).toBe('./sandbox-data');
    expect(config.discordToken).toBe('discord-secret');
    expect(config.deepgramApiKey).toBe('deepgram-secret');
    expect(config.elevenLabsApiKey).toBe('eleven-secret');
    expect(config.gatewayTlsCaPath).toBe('./certs/dev-ca.pem');
  });
});
