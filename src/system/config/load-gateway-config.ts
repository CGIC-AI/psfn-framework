// ── Gateway config entrypoint (psfn-framework-f77ca) ──
//
// `load-config.ts` is reached by the agent (app/agent/startup-context imports
// `loadAgentConfig` from it), so it may hold no value import of the
// secret-bearing custody module. Choosing the credential-vault backend and
// building the vault are gateway-only acts, so they live here, in the module
// only gateway-side entrypoints import.

import {
  createEnvCredentialVault,
  resolveCredentialVaultBackend,
} from '../../boundary/custody/credential-vault.js';
import { loadGatewayConfig } from './load-config.js';
import type { SubstrateConfig } from './runtime-config-contracts.js';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SubstrateConfig {
  // Only the `env` backend materializes secrets during config loading; an
  // OpenBao deployment resolves them later, in hydrateSecretBearingConfig.
  const materializeEnvBackedSecrets = resolveCredentialVaultBackend(env) === 'env';
  return loadGatewayConfig(env, {
    materializeEnvBackedSecrets,
    ...(materializeEnvBackedSecrets ? { credentialVault: createEnvCredentialVault(env) } : {}),
  });
}
