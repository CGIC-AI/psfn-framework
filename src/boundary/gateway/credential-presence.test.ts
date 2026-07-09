import { describe, expect, it } from 'vitest';
import type { RuntimeChannelsConfig } from '../../channels/backplane/config.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { resolveGatewayCredentialPresence } from './credential-presence.js';

function channels(): RuntimeChannelsConfig {
  return {
    discord: {
      heartbeatChannelId: '',
      allowedBotUserIds: [],
      groupMemory: { channelOverrides: {} },
      accounts: [{
        accountId: 'one',
        companionId: 'comp-a',
        tokenEnvVar: 'DISCORD_ONE',
        token: 'discord-secret',
        heartbeatChannelId: '',
        allowedBotUserIds: [],
        groupMemory: { channelOverrides: {} },
      }],
    },
    telegram: {
      enabled: true,
      token: 'telegram-secret',
      allowedUsers: [],
      mode: 'polling',
      pollIntervalMs: 1_000,
      webhook: { url: '', secret: '', host: '127.0.0.1', port: 8080, path: '/telegram' },
    },
    api: {},
    psfnAmica: { enabled: false },
    contextEnvelope: { channels: {} },
  } as RuntimeChannelsConfig;
}

describe('resolveGatewayCredentialPresence', () => {
  it('returns booleans only while retaining every Garden status signal', () => {
    const result = resolveGatewayCredentialPresence({
      config: {
        litellmBaseUrl: 'http://litellm.test/v1',
        falApiKey: 'fal-secret',
      } as SubstrateConfig,
      channelsConfig: channels(),
      providerEnv: { LITELLM_API_KEY: 'litellm-secret' },
      env: {
        LOCAL_API_KEY: 'local-secret',
        ADMIN_TOKEN: 'admin-secret',
        OPENROUTER_API_KEY: 'openrouter-secret',
        IMPORT_PROCESSING_LOCAL_API_KEY: 'import-secret',
      },
    });

    expect(result).toEqual({
      discordToken: true,
      apiKey: true,
      adminToken: true,
      openrouterApiKey: true,
      litellmBaseUrl: true,
      litellmApiKey: true,
      importProcessingLocalApiKey: true,
      falApiKey: true,
      telegramBotToken: true,
    });
    expect(JSON.stringify(result)).not.toMatch(/secret/u);
  });
});
