import { getEnvApiKey } from '@mariozechner/pi-ai';

const ENV_CREDENTIAL_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const DEFAULT_LITELLM_API_KEY_ENV = 'LITELLM_API_KEY';

const PROVIDER_API_KEY_ENV_NAMES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  anthropic: ['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  generic_openai: ['OPENAI_API_KEY'],
  google: ['GEMINI_API_KEY'],
  litellm: [DEFAULT_LITELLM_API_KEY_ENV],
  litellm_proxy: [DEFAULT_LITELLM_API_KEY_ENV],
  mistral: ['MISTRAL_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
});

const HUGGING_FACE_TOKEN_ENV_NAMES = Object.freeze([
  'HF_TOKEN',
  'HF_ACCESS_TOKEN',
  'HUGGINGFACE_HUB_TOKEN',
  'TRANSFORMERS_HF_TOKEN',
]);

export interface EnvCredentialReference {
  kind: 'env';
  envName: string;
}

export type CredentialReference = EnvCredentialReference;

export interface CredentialVaultPort {
  resolveOptional(reference: CredentialReference): string | undefined;
  resolveRequired(reference: CredentialReference, description: string): string;
  has(reference: CredentialReference): boolean;
}

export interface CredentialVaultConfigLike {
  credentialVault?: CredentialVaultPort;
  litellmApiKeyEnv?: string;
}

function normalizeCredentialValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeEnvCredentialName(envName: string): string {
  const normalized = normalizeCredentialValue(envName);
  if (!normalized || !ENV_CREDENTIAL_NAME_PATTERN.test(normalized)) {
    throw new Error(`Invalid credential env name "${envName}"`);
  }
  return normalized;
}

function resolveProviderCredentialEnvNames(
  provider: string,
  config: CredentialVaultConfigLike,
): readonly string[] {
  const normalized = provider.trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  if (normalized === 'litellm' || normalized === 'litellm_proxy' || normalized === 'local_endpoint') {
    return [normalizeCredentialValue(config.litellmApiKeyEnv) ?? DEFAULT_LITELLM_API_KEY_ENV];
  }
  return PROVIDER_API_KEY_ENV_NAMES[normalized] ?? [];
}

export function envCredential(envName: string): EnvCredentialReference {
  return {
    kind: 'env',
    envName: normalizeEnvCredentialName(envName),
  };
}

export function createEnvCredentialVault(
  env: NodeJS.ProcessEnv = process.env,
): CredentialVaultPort {
  return {
    resolveOptional(reference) {
      return normalizeCredentialValue(env[envCredential(reference.envName).envName]);
    },
    resolveRequired(reference, description) {
      const value = this.resolveOptional(reference);
      if (value) {
        return value;
      }
      throw new Error(`${description} is not configured`);
    },
    has(reference) {
      return this.resolveOptional(reference) !== undefined;
    },
  };
}

export function resolveOptionalEnvCredential(
  vault: CredentialVaultPort | undefined,
  envName: string,
  fallbackEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const reference = envCredential(envName);
  if (vault) {
    return vault.resolveOptional(reference);
  }
  return normalizeCredentialValue(fallbackEnv[reference.envName]);
}

export function resolveInlineOrEnvCredential(
  currentValue: unknown,
  vault: CredentialVaultPort | undefined,
  envName: string,
  fallbackEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const inlineValue = normalizeCredentialValue(currentValue);
  if (inlineValue) {
    return inlineValue;
  }
  return resolveOptionalEnvCredential(vault, envName, fallbackEnv);
}

export function resolveProviderApiKey(
  provider: string,
  config: CredentialVaultConfigLike = {},
  fallbackEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const envName of resolveProviderCredentialEnvNames(provider, config)) {
    const value = resolveOptionalEnvCredential(config.credentialVault, envName, fallbackEnv);
    if (value) {
      return value;
    }
  }
  return getEnvApiKey(provider) ?? undefined;
}

export function resolveHuggingFaceToken(
  config: Pick<CredentialVaultConfigLike, 'credentialVault'> = {},
  fallbackEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const envName of HUGGING_FACE_TOKEN_ENV_NAMES) {
    const value = resolveOptionalEnvCredential(config.credentialVault, envName, fallbackEnv);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function buildProviderCredentialEnv(
  config: CredentialVaultConfigLike = {},
  fallbackEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    EMBEDDING_API_KEY: resolveOptionalEnvCredential(config.credentialVault, 'EMBEDDING_API_KEY', fallbackEnv),
    OPENAI_API_KEY: resolveOptionalEnvCredential(config.credentialVault, 'OPENAI_API_KEY', fallbackEnv),
    LITELLM_API_KEY: resolveProviderApiKey('litellm_proxy', config, fallbackEnv),
    HF_TOKEN: resolveOptionalEnvCredential(config.credentialVault, 'HF_TOKEN', fallbackEnv),
    HF_ACCESS_TOKEN: resolveOptionalEnvCredential(config.credentialVault, 'HF_ACCESS_TOKEN', fallbackEnv),
    HUGGINGFACE_HUB_TOKEN: resolveOptionalEnvCredential(config.credentialVault, 'HUGGINGFACE_HUB_TOKEN', fallbackEnv),
    TRANSFORMERS_HF_TOKEN: resolveOptionalEnvCredential(config.credentialVault, 'TRANSFORMERS_HF_TOKEN', fallbackEnv),
  };
}
