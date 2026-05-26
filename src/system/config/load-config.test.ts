import { afterEach, describe, expect, it } from 'vitest';
import { loadAgentConfig, loadConfig } from './load-config.js';

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
  delete process.env.COMPANION_ID;
  delete process.env.CREDENTIAL_VAULT_BACKEND;
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
  delete process.env.DISCORD_TOKEN;
  delete process.env.DISCORD_BOT_ID;
  delete process.env.PERSISTENCE_BACKEND;
  delete process.env.POSTGRES_DATABASE_URL;
  delete process.env.OPENBAO_ADDR;
  delete process.env.OPENBAO_TOKEN;
  delete process.env.OPENBAO_KV_MOUNT;
  delete process.env.OPENBAO_KV_PATH;
  delete process.env.OPENBAO_KV_VERSION;
  delete process.env.OPENBAO_NAMESPACE;
  process.env.COMPANION_ID = 'test-companion';
}

afterEach(() => {
  restoreEnv();
});

describe('loadConfig path defaults', () => {
  it('uses data-dir-relative defaults when explicit paths are not set', () => {
    clearRuntimePathEnv();

    const config = loadConfig();
    expect(config.systemDataDir).toBe('./data');
    expect(config.companionDataDir).toBe('./companion');
    expect(config.workspacePath).toBe('./workspace');
    expect(config.dataDir).toBe('./data');
    expect(config.companionId).toBe('test-companion');
    expect(config.characterCardPath).toBe('./companion/companion.json');
    expect(config.databasePath).toBe('companion/state/companion.db');
  });

  it('requires explicit companion identity wiring', () => {
    clearRuntimePathEnv();
    delete process.env.COMPANION_ID;

    expect(() => loadConfig()).toThrow(
      'COMPANION_ID is required',
    );
  });

  it('derives card/database paths from DATA_DIR when only DATA_DIR is set', () => {
    clearRuntimePathEnv();
    process.env.DATA_DIR = './sandbox-data';

    const config = loadConfig();
    expect(config.systemDataDir).toBe('./sandbox-data');
    expect(config.companionDataDir).toBe('./sandbox-data');
    expect(config.workspacePath).toBe('./workspace');
    expect(config.dataDir).toBe('./sandbox-data');
    expect(config.characterCardPath).toBe('./sandbox-data/companion.json');
    expect(config.databasePath).toBe('sandbox-data/state/companion.db');
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
    expect(config.databasePath).toBe('sandbox-data/state/companion-prime.db');
  });

  it('supports explicit split system and companion roots', () => {
    clearRuntimePathEnv();
    process.env.SYSTEM_DATA_DIR = './system-data';
    process.env.COMPANION_DATA_DIR = './companion-data';

    const config = loadConfig();
    expect(config.systemDataDir).toBe('./system-data');
    expect(config.companionDataDir).toBe('./companion-data');
    expect(config.workspacePath).toBe('./workspace');
    expect(config.dataDir).toBe('./system-data');
    expect(config.characterCardPath).toBe('./companion-data/companion.json');
    expect(config.databasePath).toBe('companion-data/state/companion.db');
  });

  it('carries explicit personal workspace wiring into runtime config', () => {
    clearRuntimePathEnv();
    process.env.WORKSPACE_PATH = './personal-files';

    const config = loadConfig();
    expect(config.workspacePath).toBe('./personal-files');
  });

  it('defaults persistence backend to sqlite', () => {
    clearRuntimePathEnv();

    const config = loadConfig();

    expect(config.persistenceBackend).toBe('sqlite');
    expect(config.postgresDatabaseUrl).toBeUndefined();
  });

  it('loads postgres backend wiring when explicitly configured', () => {
    clearRuntimePathEnv();
    process.env.PERSISTENCE_BACKEND = 'postgres';
    process.env.POSTGRES_DATABASE_URL = 'postgres://postgres:secret@localhost:5432/psfn';

    const config = loadConfig();

    expect(config.persistenceBackend).toBe('postgres');
    expect(config.postgresDatabaseUrl).toBe('postgres://postgres:secret@localhost:5432/psfn');
  });

  it('fails closed when postgres backend is selected without a database url', () => {
    clearRuntimePathEnv();
    process.env.PERSISTENCE_BACKEND = 'postgres';

    expect(() => loadConfig()).toThrow(
      'POSTGRES_DATABASE_URL is required when PERSISTENCE_BACKEND=postgres',
    );
  });

  it('resolves isolated production-mode defaults when runtime layout mode is production', () => {
    clearRuntimePathEnv();
    process.env.PSFN_RUNTIME_LAYOUT_MODE = 'production';

    const config = loadConfig();
    expect(config.systemDataDir).toBe('./runtime/production/system-data');
    expect(config.companionDataDir).toBe('./runtime/production/companion-data');
    expect(config.workspacePath).toBe('./runtime/production/workspace');
    expect(config.dataDir).toBe('./runtime/production/system-data');
    expect(config.characterCardPath).toBe('./runtime/production/companion-data/companion.json');
    expect(config.databasePath).toBe('runtime/production/companion-data/state/companion.db');
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
    process.env.DEEPGRAM_STT_ENDPOINT = 'wss://deepgram.invalid/listen';
    process.env.DEEPGRAM_LISTEN_ENDPOINT = 'https://deepgram.invalid/listen';
    process.env.ELEVENLABS_MODEL_ID = 'env-eleven-model';
    process.env.ELEVENLABS_ENDPOINT_BASE = 'https://eleven.invalid/v1';
    process.env.OPENROUTER_MODELS_API_URL = 'https://openrouter.invalid/models';
    process.env.EMBEDDING_PROVIDER = 'api';
    process.env.EMBEDDING_MODEL = 'env-embed-model';
    process.env.EMBEDDING_DIMS = '2048';
    process.env.OLLAMA_URL = 'http://env-ollama.invalid:11434';
    process.env.TRANSFORMERS_MODEL = 'env/transformers-model';
    process.env.TRANSFORMERS_CACHE_DIR = '/tmp/env-hf-cache';
    process.env.EMBEDDING_API_URL = 'https://embed.invalid/v1/embeddings';
    process.env.EMBEDDING_API_MODEL = 'env-embed-api-model';
    process.env.EMBEDDING_API_DIMS = '3072';
    process.env.SESSION_MIRROR_ENABLED = 'false';
    process.env.SESSION_MIRROR_MAX_CHARS = '999';
    process.env.SESSION_MIRROR_ACTIVE_WINDOW_MS = '3000';
    process.env.SESSION_MIRROR_CHANNEL_OVERRIDES = 'discord=false';
    process.env.CONTINUITY_MESSAGE_LIMIT = '77';
    process.env.THINK_MAX_TOKENS = '999999';
    process.env.THINK_MAX_WALL_TIME_MS = '999999';
    process.env.THINK_MAX_SUB_QUERIES = '99';
    process.env.DISCORD_VOICE_ENABLED = 'true';
    process.env.DISCORD_VOICE_GUILD_ID = 'env-guild';
    process.env.DISCORD_VOICE_USER_ID = 'env-user';
    process.env.DISCORD_VOICE_READY_CUE_TEXT = 'env-ready';
    process.env.WYOMING_SHARD_DELEGATION_ENABLED = 'true';
    process.env.WYOMING_SHARD_DELEGATION_SITE_ALLOWLIST = 'site-a,site-b';
    process.env.WYOMING_SHARD_DELEGATION_SATELLITE_ALLOWLIST = 'sat-a';
    process.env.SHARD_TOOLSET_NURSERY = 'env-tool';
    process.env.SHARD_TOOLSET_AUTONOMOUS = 'env-auto';
    process.env.DISCORD_TRIGGER_REACTIONS = '🔥';
    process.env.TELEGRAM_ENABLED = 'true';
    process.env.OBSIDIAN_AUTO_PUBLISH = 'true';
    process.env.TTS_PROVIDER = 'echo';

    const config = loadConfig();
    expect(config.primaryModel).toBe('__owner_file_required__');
    expect(config.primaryProvider).toBe('__owner_file_required__');
    expect(config.primaryMaxTokens).toBe(1);
    expect(config.defaultContextWindow).toBe(128_000);
    expect(config.extractionModel).toBe('__owner_file_required__');
    expect(config.extractionProvider).toBe('__owner_file_required__');
    expect(config.extractionMaxTokens).toBe(1);
    expect(config.sessionMessageLimit).toBe(30);
    expect(config.continuityMessageLimit).toBe(10);
    expect(config.maintenanceIntervalMs).toBe(300_000);
    expect(config.retryMaxAttempts).toBe(3);
    expect(config.sessionMirrorEnabled).toBe(true);
    expect(config.sessionMirrorMaxChars).toBe(220);
    expect(config.sessionMirrorActiveWindowMs).toBe(1_800_000);
    expect(config.sessionMirrorChannelOverrides).toEqual({});
    expect(config.analysisWorkbenchMaxTokens).toBe(76_000);
    expect(config.analysisWorkbenchMaxWallTimeMs).toBe(300_000);
    expect(config.analysisWorkbenchMaxSubQueries).toBe(12);
    expect(config.deepgramModel).toBeUndefined();
    expect(config.deepgramSttEndpoint).toBeUndefined();
    expect(config.deepgramListenEndpoint).toBeUndefined();
    expect(config.elevenLabsModelId).toBeUndefined();
    expect(config.elevenLabsEndpointBase).toBeUndefined();
    expect(config.openRouterModelsApiUrl).toBeUndefined();
    expect(config.embeddingProvider).toBeUndefined();
    expect(config.embeddingModel).toBeUndefined();
    expect(config.embeddingDims).toBeUndefined();
    expect(config.embeddingOllamaUrl).toBeUndefined();
    expect(config.transformersModel).toBeUndefined();
    expect(config.transformersCacheDir).toBeUndefined();
    expect(config.textEmotionModel).toBeUndefined();
    expect(config.textEmotionCacheDir).toBeUndefined();
    expect(config.textEmotionDtype).toBeUndefined();
    expect(config.embeddingApiUrl).toBeUndefined();
    expect(config.embeddingApiModel).toBeUndefined();
    expect(config.embeddingApiDims).toBeUndefined();
    expect(config.voiceEnabled).toBe(false);
    expect(config.voiceTargetGuildId).toBe('');
    expect(config.voiceTargetUserId).toBe('');
    expect(config.voiceReadyCueText).toBe('');
    expect(config.discordTriggerReactions).toEqual(['👆']);
    expect(config.telegramEnabled).toBe(false);
    expect(config.wyomingShardRouting).toMatchObject({ enabled: false });
    expect(config.shardToolsets).toEqual({});
    expect(config.obsidianAutoPublish).toBe(false);
    expect(config.ttsProvider).toBeUndefined();
  });

  it('still reads secret and bootstrap env wiring', () => {
    clearRuntimePathEnv();
    process.env.DATA_DIR = './sandbox-data';
    process.env.DISCORD_TOKEN = 'discord-secret';
    process.env.DISCORD_BOT_ID = '123456789';
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

  it('defers secret-bearing config materialization when OpenBao is selected', () => {
    clearRuntimePathEnv();
    process.env.DATA_DIR = './sandbox-data';
    process.env.CREDENTIAL_VAULT_BACKEND = 'openbao';
    process.env.OPENBAO_ADDR = 'https://openbao.internal:8200';
    process.env.OPENBAO_TOKEN = 'openbao-token';
    process.env.OPENBAO_KV_MOUNT = 'kv';
    process.env.OPENBAO_KV_PATH = 'psfn/runtime';

    const config = loadConfig();

    expect(config.dataDir).toBe('./sandbox-data');
    expect(config.credentialVault).toBeUndefined();
    expect(config.discordToken).toBe('');
    expect(config.discordBotId).toBe('');
    expect(config.deepgramApiKey).toBeUndefined();
    expect(config.elevenLabsApiKey).toBeUndefined();
    expect(config.falApiKey).toBeUndefined();
  });

  it('keeps agent config free of secret-bearing startup fields', () => {
    clearRuntimePathEnv();
    process.env.DATA_DIR = './sandbox-data';
    process.env.DISCORD_TOKEN = 'discord-secret';
    process.env.DISCORD_BOT_ID = '123456789';
    process.env.DEEPGRAM_API_KEY = 'deepgram-secret';
    process.env.ELEVENLABS_API_KEY = 'eleven-secret';
    process.env.FAL_API_KEY = 'fal-secret';

    const config = loadAgentConfig() as Record<string, unknown>;

    expect(config.dataDir).toBe('./sandbox-data');
    expect(config.discordToken).toBeUndefined();
    expect(config.discordBotId).toBeUndefined();
    expect(config.credentialVault).toBeUndefined();
    expect(config.deepgramApiKey).toBeUndefined();
    expect(config.elevenLabsApiKey).toBeUndefined();
    expect(config.falApiKey).toBeUndefined();
  });

  it('fails closed when DISCORD_TOKEN is set without DISCORD_BOT_ID', () => {
    clearRuntimePathEnv();
    process.env.DISCORD_TOKEN = 'discord-secret';

    expect(() => loadConfig()).toThrow(
      'DISCORD_BOT_ID is required when DISCORD_TOKEN is configured',
    );
  });

  it('fails closed when DISCORD_BOT_ID is set without DISCORD_TOKEN', () => {
    clearRuntimePathEnv();
    process.env.DISCORD_BOT_ID = '123456789';

    expect(() => loadConfig()).toThrow(
      'DISCORD_TOKEN is required when DISCORD_BOT_ID is configured',
    );
  });
});
