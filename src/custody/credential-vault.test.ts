import { describe, expect, it } from 'vitest';
import {
  buildProviderCredentialEnv,
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
      litellmApiKeyEnv: 'CUSTOM_LITELLM_TOKEN',
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
});
