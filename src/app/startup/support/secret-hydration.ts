// ── Gateway secret hydration (psfn-framework-f77ca) ──
//
// The gateway is the only process that may construct a credential vault, so
// the one startup step that does — building the vault from the environment and
// materializing the secret-bearing substrate fields from it — lives here rather
// than in the shared bootstrap helpers. Keeping it separate is what allows
// `bootstrap-helpers.ts`, which the agent reaches through
// `resolveStartupPreflightBundle`, to stay free of any value import of
// boundary/custody/credential-vault (src/app/agent/agent-import-boundary.test.ts).
//
// Every consumer downstream reads the resolved plain values off the config, as
// the voice connector indexes already do (psfn-framework-mp1pf). The agent
// never runs this step, so a vault-only credential reads as not configured
// there — fail closed, never fail open.

import { createCredentialVaultFromEnvironment } from '../../../boundary/custody/credential-vault.js';
import { resolveInlineOrEnvCredential } from '../../../shared/contracts/credential-contracts.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { assertSecuritySensitiveStartupConfig } from './bootstrap-helpers.js';

export async function hydrateSecretBearingConfig(
  config: SubstrateConfig,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  config.credentialVault ??= await createCredentialVaultFromEnvironment(env, {
    fetchImpl: options.fetchImpl,
  });
  config.discordToken = resolveInlineOrEnvCredential(
    config.discordToken,
    config.credentialVault,
    'DISCORD_TOKEN',
    env,
  ) ?? '';
  config.discordBotId = resolveInlineOrEnvCredential(
    config.discordBotId,
    config.credentialVault,
    'DISCORD_BOT_ID',
    env,
  ) ?? '';
  config.deepgramApiKey = resolveInlineOrEnvCredential(
    config.deepgramApiKey,
    config.credentialVault,
    'DEEPGRAM_API_KEY',
    env,
  );
  config.elevenLabsApiKey = resolveInlineOrEnvCredential(
    config.elevenLabsApiKey,
    config.credentialVault,
    'ELEVENLABS_API_KEY',
    env,
  );
  config.falApiKey = resolveInlineOrEnvCredential(
    config.falApiKey,
    config.credentialVault,
    'FAL_API_KEY',
    env,
  );
  assertSecuritySensitiveStartupConfig(config);
}
