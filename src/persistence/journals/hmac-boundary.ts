import type { CredentialVaultPort } from '../../boundary/custody/credential-vault.js';
import { assertStrongCredential, parseStrongSessionHmacRotationKeys } from '../../shared/security/credentials.js';
import { resolveOptionalEnvCredential } from '../../boundary/custody/credential-vault.js';
import {
  buildSessionHmacKeyring,
  type SessionHmacKeyring,
  type SessionHmacKeyringInput,
} from './journal-utils.js';
import {
  createKeyringIntegrityProvider,
  type SessionIntegrityProvider,
} from '../sessions/store-primitives.js';

export const GATEWAY_SESSION_HMAC_KEYS_ENV = 'GATEWAY_SESSION_HMAC_KEYS';
export const GATEWAY_SESSION_HMAC_KEY_ENV = 'GATEWAY_SESSION_HMAC_KEY';
export const GATEWAY_SESSION_HMAC_ACTIVE_VERSION_ENV = 'GATEWAY_SESSION_HMAC_ACTIVE_VERSION';

export interface SessionHmacBoundaryOptions {
  env?: NodeJS.ProcessEnv;
  credentialVault?: CredentialVaultPort;
}

export interface SessionHmacBoundaryService {
  resolveKeyring(): SessionHmacKeyring | null;
  requireKeyring(message: string): SessionHmacKeyring;
  resolveIntegrityProvider(): SessionIntegrityProvider | null;
  requireIntegrityProvider(message: string): SessionIntegrityProvider;
}

function resolveSessionHmacKeyringInput(
  options: SessionHmacBoundaryOptions,
): SessionHmacKeyringInput {
  const env = options.env ?? process.env;
  return {
    serializedKeys: resolveOptionalEnvCredential(
      options.credentialVault,
      GATEWAY_SESSION_HMAC_KEYS_ENV,
      env,
    ),
    singleKey: resolveOptionalEnvCredential(
      options.credentialVault,
      GATEWAY_SESSION_HMAC_KEY_ENV,
      env,
    ),
    activeVersion: resolveOptionalEnvCredential(
      options.credentialVault,
      GATEWAY_SESSION_HMAC_ACTIVE_VERSION_ENV,
      env,
    ),
  };
}

export function createSessionHmacBoundaryService(
  options: SessionHmacBoundaryOptions = {},
): SessionHmacBoundaryService {
  return {
    resolveKeyring() {
      const input = resolveSessionHmacKeyringInput(options);
      if (input.singleKey !== undefined) assertStrongCredential(input.singleKey, GATEWAY_SESSION_HMAC_KEY_ENV);
      if (input.serializedKeys !== undefined) {
        parseStrongSessionHmacRotationKeys(input.serializedKeys);
      }
      const keyring = buildSessionHmacKeyring(input);
      for (const value of Object.values(keyring?.keys ?? {})) {
        assertStrongCredential(value, 'GATEWAY_SESSION_HMAC_KEY(S)');
      }
      return keyring;
    },
    requireKeyring(message) {
      const keyring = this.resolveKeyring();
      if (keyring) {
        return keyring;
      }
      throw new Error(message);
    },
    resolveIntegrityProvider() {
      return createKeyringIntegrityProvider(this.resolveKeyring());
    },
    requireIntegrityProvider(message) {
      const provider = this.resolveIntegrityProvider();
      if (provider) {
        return provider;
      }
      throw new Error(message);
    },
  };
}
