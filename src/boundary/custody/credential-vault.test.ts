import { describe, expect, it } from 'vitest';
import {
  buildProviderCredentialEnv,
  createCredentialVaultFromEnvironment,
  createEnvCredentialVault,
  envCredential,
  resolveHuggingFaceToken,
  resolveInlineOrEnvCredential,
  resolveProviderApiKey,
} from './credential-vault.js';

describe('credential vault', () => {
  it('resolves env-backed credentials through the vault port', () => {
    const vault = createEnvCredentialVault({
      OPENROUTER_API_KEY: 'openrouter-secret',
    });

    expect(vault.resolveOptional(envCredential('OPENROUTER_API_KEY'))).toBe('openrouter-secret');
    expect(vault.has(envCredential('OPENROUTER_API_KEY'))).toBe(true);
    expect(vault.has(envCredential('OPENAI_API_KEY'))).toBe(false);
    expect(vault.resolveRequired(envCredential('OPENROUTER_API_KEY'), 'OpenRouter API key')).toBe('openrouter-secret');
  });

  it('resolves provider credentials through configured env handles', () => {
    const vault = createEnvCredentialVault({
      CUSTOM_LITELLM_TOKEN: 'litellm-secret',
      ANTHROPIC_API_KEY: 'anthropic-secret',
    });

    expect(resolveProviderApiKey('litellm_proxy', {
      credentialVault: vault,
      litellmApiKeyRef: envCredential('CUSTOM_LITELLM_TOKEN'),
    })).toBe('litellm-secret');
    expect(resolveProviderApiKey('anthropic', {
      credentialVault: vault,
    })).toBe('anthropic-secret');
  });

  it('prefers inline credentials but falls back to vault-backed env credentials', () => {
    const vault = createEnvCredentialVault({
      DEEPGRAM_API_KEY: 'deepgram-secret',
    });

    expect(resolveInlineOrEnvCredential('', vault, 'DEEPGRAM_API_KEY')).toBe('deepgram-secret');
    expect(resolveInlineOrEnvCredential('inline-secret', vault, 'DEEPGRAM_API_KEY')).toBe('inline-secret');
  });

  it('resolves hugging face tokens and builds provider env snapshots from the vault', () => {
    const vault = createEnvCredentialVault({
      HF_ACCESS_TOKEN: 'hf-secret',
      EMBEDDING_API_KEY: 'embedding-secret',
      OPENAI_API_KEY: 'openai-secret',
    });

    expect(resolveHuggingFaceToken({ credentialVault: vault })).toBe('hf-secret');
    expect(buildProviderCredentialEnv({ credentialVault: vault })).toEqual({
      EMBEDDING_API_KEY: 'embedding-secret',
      OPENAI_API_KEY: 'openai-secret',
      LITELLM_API_KEY: undefined,
      HF_TOKEN: undefined,
      HF_ACCESS_TOKEN: 'hf-secret',
      HUGGINGFACE_HUB_TOKEN: undefined,
      TRANSFORMERS_HF_TOKEN: undefined,
    });
  });

  it('creates an OpenBao-backed vault from env-owned wiring', async () => {
    const vault = await createCredentialVaultFromEnvironment({
      CREDENTIAL_VAULT_BACKEND: 'openbao',
      OPENBAO_ADDR: 'https://openbao.internal:8200',
      OPENBAO_TOKEN: 'openbao-token',
      OPENBAO_KV_MOUNT: 'kv',
      OPENBAO_KV_PATH: 'psfn/runtime',
    }, {
      fetchImpl: async (input, init) => {
        expect(String(input)).toBe('https://openbao.internal:8200/v1/kv/data/psfn/runtime');
        expect(init?.headers).toMatchObject({
          Accept: 'application/json',
          'X-Vault-Token': 'openbao-token',
        });
        return new Response(JSON.stringify({
          data: {
            data: {
              OPENAI_API_KEY: 'openbao-openai-key',
              DEEPGRAM_API_KEY: 'openbao-deepgram-key',
            },
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    expect(vault.resolveRequired(envCredential('OPENAI_API_KEY'), 'OpenAI API key')).toBe('openbao-openai-key');
    expect(vault.resolveOptional(envCredential('DEEPGRAM_API_KEY'))).toBe('openbao-deepgram-key');
    expect(vault.has(envCredential('ELEVENLABS_API_KEY'))).toBe(false);
  });

  it('fails closed when OpenBao wiring is invalid', async () => {
    await expect(createCredentialVaultFromEnvironment({
      CREDENTIAL_VAULT_BACKEND: 'openbao',
      OPENBAO_TOKEN: 'openbao-token',
      OPENBAO_KV_MOUNT: 'kv',
      OPENBAO_KV_PATH: 'psfn/runtime',
    })).rejects.toThrow(
      'OPENBAO_ADDR is required when CREDENTIAL_VAULT_BACKEND=openbao',
    );
  });
});
