import { describe, expect, it } from 'vitest';
import { createEnvCredentialVault } from '../../boundary/custody/credential-vault.js';
import { createSessionHmacBoundaryService } from './hmac-boundary.js';

describe('createSessionHmacBoundaryService', () => {
  it('resolves the session HMAC keyring through the credential vault', () => {
    const service = createSessionHmacBoundaryService({
      credentialVault: createEnvCredentialVault({
        GATEWAY_SESSION_HMAC_KEYS: 'v1:first-key-8162bacf3d49075e031cb6f8,v2:second-key-97102acb8e6543dfb6071e29',
        GATEWAY_SESSION_HMAC_ACTIVE_VERSION: 'v2',
      }),
    });

    expect(service.resolveKeyring()).toEqual({
      activeVersion: 'v2',
      keys: {
        v1: 'first-key-8162bacf3d49075e031cb6f8',
        v2: 'second-key-97102acb8e6543dfb6071e29',
      },
    });
  });

  it('creates an integrity provider when a keyring is available', () => {
    const service = createSessionHmacBoundaryService({
      env: {
        GATEWAY_SESSION_HMAC_KEY: 'single-key-4fb71093ae62c85d810af672',
      },
    });

    const provider = service.resolveIntegrityProvider();
    expect(provider).not.toBeNull();
    expect(service.requireIntegrityProvider('missing provider')).not.toBeNull();
  });

  it('fails closed when a caller requires a keyring and none is configured', () => {
    const service = createSessionHmacBoundaryService({
      env: {},
    });

    expect(service.resolveKeyring()).toBeNull();
    expect(() => service.requireKeyring('Session HMAC keyring is required')).toThrow(
      'Session HMAC keyring is required',
    );
  });
});
