import type { RuntimeChannelsConfig } from '../../channels/backplane/config.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import { resolveOptionalEnvCredential } from '../custody/credential-vault.js';
import type { GatewayCredentialPresenceResult } from './protocol.js';

function isSet(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Build a value-free credential inventory inside the secret-owning gateway. */
export function resolveGatewayCredentialPresence(input: {
  config: SubstrateConfig;
  channelsConfig: RuntimeChannelsConfig;
  providerEnv: NodeJS.ProcessEnv;
  env: NodeJS.ProcessEnv;
}): GatewayCredentialPresenceResult {
  const { config, channelsConfig, providerEnv, env } = input;
  return {
    discordToken: isSet(config.discordToken)
      || (channelsConfig.discord.accounts ?? []).some(account => isSet(account.token)),
    apiKey: isSet(config.localApiKey)
      || isSet(resolveOptionalEnvCredential(config.credentialVault, 'LOCAL_API_KEY', env)),
    adminToken: isSet(config.adminAuthToken)
      || isSet(resolveOptionalEnvCredential(config.credentialVault, 'ADMIN_TOKEN', env)),
    openrouterApiKey: isSet(
      resolveOptionalEnvCredential(config.credentialVault, 'OPENROUTER_API_KEY', env),
    ),
    litellmBaseUrl: isSet(config.litellmBaseUrl),
    litellmApiKey: isSet(providerEnv.LITELLM_API_KEY),
    importProcessingLocalApiKey: isSet(
      resolveOptionalEnvCredential(config.credentialVault, 'IMPORT_PROCESSING_LOCAL_API_KEY', env),
    ),
    falApiKey: isSet(config.falApiKey)
      || isSet(resolveOptionalEnvCredential(config.credentialVault, 'FAL_API_KEY', env)),
    telegramBotToken: isSet(channelsConfig.telegram.token),
  };
}
