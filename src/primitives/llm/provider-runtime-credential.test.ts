import { describe, expect, it } from 'vitest';
import { envCredential, createStaticCredentialVault } from '../../boundary/custody/credential-vault.js';
import {
  PiProviderRuntime,
  resolveConfiguredProviderCredential,
} from './provider-runtime.js';
import type { CanonicalProviderRegistry } from '../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';

type RuntimeCredentialConfig = Pick<
  SubstrateConfig,
  'providerRegistry' | 'credentialVault' | 'openRouterApiKeyRef'
>;

function registry(providers: CanonicalProviderRegistry['providers']): CanonicalProviderRegistry {
  return { schemaVersion: 1, providers };
}

describe('resolveConfiguredProviderCredential', () => {
  it('resolves a configured provider apiKeyRef solely through the credential vault', () => {
    const config: RuntimeCredentialConfig = {
      providerRegistry: registry([
        {
          id: 'shared-router',
          type: 'generic_openai',
          enabled: true,
          apiKeyRef: envCredential('SHARED_ROUTER_API_KEY'),
        },
      ]),
      credentialVault: createStaticCredentialVault({ SHARED_ROUTER_API_KEY: 'router-secret' }),
    };

    expect(resolveConfiguredProviderCredential('shared-router', config)).toBe('router-secret');
  });

  it('resolves OpenRouter through the dedicated openRouterApiKeyRef', () => {
    const config: RuntimeCredentialConfig = {
      providerRegistry: registry([
        {
          id: 'openrouter',
          type: 'openrouter',
          enabled: true,
          apiKeyRef: envCredential('OPENROUTER_API_KEY'),
        },
      ]),
      openRouterApiKeyRef: envCredential('OPENROUTER_API_KEY'),
      credentialVault: createStaticCredentialVault({ OPENROUTER_API_KEY: 'or-secret' }),
    };

    expect(resolveConfiguredProviderCredential('openrouter', config)).toBe('or-secret');
  });

  it('fails closed (undefined) when a configured provider has no resolvable reference', () => {
    // LITELLM_API_KEY is present in process.env, but the resolver must not fall
    // back to it: a provider without a configured apiKeyRef yields no secret.
    const prior = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = 'leaked-env-key';
    try {
      const config: RuntimeCredentialConfig = {
        providerRegistry: registry([
          { id: 'shared-router', type: 'generic_openai', enabled: true },
        ]),
        credentialVault: createStaticCredentialVault({}),
      };

      expect(resolveConfiguredProviderCredential('shared-router', config)).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = prior;
    }
  });

  it('fails closed (undefined) for an unknown provider with no env fallback', () => {
    const prior = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'leaked-env-key';
    try {
      const config: RuntimeCredentialConfig = {
        providerRegistry: registry([
          { id: 'openrouter', type: 'openrouter', enabled: true },
        ]),
        credentialVault: createStaticCredentialVault({}),
      };

      // No configured anthropic entry, no ANTHROPIC env fallback.
      expect(resolveConfiguredProviderCredential('anthropic', config)).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prior;
    }
  });

  it('ignores disabled provider entries when resolving credentials', () => {
    const config: RuntimeCredentialConfig = {
      providerRegistry: registry([
        {
          id: 'shared-router',
          type: 'generic_openai',
          enabled: false,
          apiKeyRef: envCredential('SHARED_ROUTER_API_KEY'),
        },
      ]),
      credentialVault: createStaticCredentialVault({ SHARED_ROUTER_API_KEY: 'router-secret' }),
    };

    expect(resolveConfiguredProviderCredential('shared-router', config)).toBeUndefined();
  });

  it('is exposed on the PiProviderRuntime for the gateway LLM path', () => {
    const runtime = new PiProviderRuntime(undefined, {
      providerRegistry: registry([
        {
          id: 'shared-router',
          type: 'generic_openai',
          enabled: true,
          apiBaseUrl: 'https://router.example.test/v1',
          apiKeyRef: envCredential('SHARED_ROUTER_API_KEY'),
        },
      ]),
      credentialVault: createStaticCredentialVault({ SHARED_ROUTER_API_KEY: 'router-secret' }),
    });

    expect(runtime.resolveProviderApiKey('shared-router')).toBe('router-secret');
    expect(runtime.resolveProviderApiKey('unknown')).toBeUndefined();
  });
});
