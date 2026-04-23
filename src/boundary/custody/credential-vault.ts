import { getEnvApiKey } from '@mariozechner/pi-ai';

const ENV_CREDENTIAL_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const DEFAULT_LITELLM_API_KEY_ENV = 'LITELLM_API_KEY';
const CREDENTIAL_VAULT_BACKEND_ENV = 'CREDENTIAL_VAULT_BACKEND';
const OPENBAO_KV_VERSION_DEFAULT = 2;

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
export type CredentialVaultBackend = 'env' | 'openbao';

export interface OpenBaoCredentialVaultConfig {
  address: string;
  token: string;
  mount: string;
  path: string;
  kvVersion: 1 | 2;
  namespace?: string;
}

export interface CredentialVaultFactoryOptions {
  fetchImpl?: typeof fetch;
}

export interface CredentialVaultPort {
  resolveOptional(reference: CredentialReference): string | undefined;
  resolveRequired(reference: CredentialReference, description: string): string;
  has(reference: CredentialReference): boolean;
}

export interface CredentialVaultConfigLike {
  credentialVault?: CredentialVaultPort;
  litellmApiKeyRef?: CredentialReference;
  providerRegistry?: {
    providers: ReadonlyArray<{
      type: string;
      enabled: boolean;
      apiKeyRef?: CredentialReference;
    }>;
  };
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

function resolveProviderCredentialReferences(
  provider: string,
  config: CredentialVaultConfigLike,
): readonly CredentialReference[] {
  const normalized = provider.trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  const configuredRef = config.providerRegistry?.providers.find(
    (entry) => entry.enabled && entry.type === normalized,
  )?.apiKeyRef;
  if (configuredRef) {
    return [configuredRef];
  }
  if (normalized === 'litellm' || normalized === 'litellm_proxy' || normalized === 'local_endpoint') {
    return [config.litellmApiKeyRef ?? envCredential(DEFAULT_LITELLM_API_KEY_ENV)];
  }
  return (PROVIDER_API_KEY_ENV_NAMES[normalized] ?? []).map((envName) => envCredential(envName));
}

export function envCredential(envName: string): EnvCredentialReference {
  return {
    kind: 'env',
    envName: normalizeEnvCredentialName(envName),
  };
}

export function createStaticCredentialVault(
  credentials: Readonly<Record<string, unknown>>,
): CredentialVaultPort {
  return {
    resolveOptional(reference) {
      const credentialName = envCredential(reference.envName).envName;
      return normalizeCredentialValue(credentials[credentialName]);
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

export function createEnvCredentialVault(
  env: NodeJS.ProcessEnv = process.env,
): CredentialVaultPort {
  return createStaticCredentialVault(env);
}

function normalizeCredentialVaultBackend(
  value: string | undefined,
): CredentialVaultBackend {
  const normalized = value?.trim().toLowerCase() ?? 'env';
  if (normalized === 'env' || normalized.length === 0) {
    return 'env';
  }
  if (normalized === 'openbao') {
    return 'openbao';
  }
  throw new Error(
    `Unsupported ${CREDENTIAL_VAULT_BACKEND_ENV} "${value}". Expected "env" or "openbao".`,
  );
}

function normalizeOpenBaoAddress(value: string | undefined): string {
  const normalized = normalizeCredentialValue(value);
  if (!normalized) {
    throw new Error('OPENBAO_ADDR is required when CREDENTIAL_VAULT_BACKEND=openbao');
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('Invalid OPENBAO_ADDR: expected a valid http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid OPENBAO_ADDR: expected a valid http(s) URL');
  }
  parsed.hash = '';
  return parsed.toString().replace(/\/+$/u, '');
}

function normalizeOpenBaoPathComponent(
  value: string | undefined,
  fieldName: 'OPENBAO_KV_MOUNT' | 'OPENBAO_KV_PATH',
): string {
  const normalized = normalizeCredentialValue(value);
  if (!normalized) {
    throw new Error(`${fieldName} is required when CREDENTIAL_VAULT_BACKEND=openbao`);
  }
  const trimmed = normalized.replace(/^\/+|\/+$/gu, '');
  if (!trimmed) {
    throw new Error(`${fieldName} must be a non-empty path`);
  }
  if (trimmed.split('/').some((segment) => segment.trim().length === 0)) {
    throw new Error(`${fieldName} must not contain empty path segments`);
  }
  return trimmed;
}

function normalizeOpenBaoKvVersion(value: string | undefined): 1 | 2 {
  if (value === undefined) {
    return OPENBAO_KV_VERSION_DEFAULT;
  }
  const normalized = value.trim();
  if (normalized === '1') {
    return 1;
  }
  if (normalized === '2' || normalized.length === 0) {
    return 2;
  }
  throw new Error('OPENBAO_KV_VERSION must be "1" or "2" when CREDENTIAL_VAULT_BACKEND=openbao');
}

function buildEncodedPath(path: string): string {
  return path
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

function buildOpenBaoSecretUrl(config: OpenBaoCredentialVaultConfig): string {
  const mount = buildEncodedPath(config.mount);
  const path = buildEncodedPath(config.path);
  if (config.kvVersion === 1) {
    return `${config.address}/v1/${mount}/${path}`;
  }
  return `${config.address}/v1/${mount}/data/${path}`;
}

function parseOpenBaoSecretRecord(
  payload: unknown,
  config: OpenBaoCredentialVaultConfig,
): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid OpenBao credential vault response: expected object payload');
  }
  const topLevel = payload as Record<string, unknown>;
  const rawData = topLevel.data;
  if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
    throw new Error('Invalid OpenBao credential vault response: missing data object');
  }
  if (config.kvVersion === 1) {
    return rawData as Record<string, unknown>;
  }
  const nested = (rawData as Record<string, unknown>).data;
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
    throw new Error('Invalid OpenBao credential vault response: missing data.data object');
  }
  return nested as Record<string, unknown>;
}

export function resolveCredentialVaultBackend(
  env: NodeJS.ProcessEnv = process.env,
): CredentialVaultBackend {
  return normalizeCredentialVaultBackend(env[CREDENTIAL_VAULT_BACKEND_ENV]);
}

export function resolveOpenBaoCredentialVaultConfig(
  env: NodeJS.ProcessEnv = process.env,
): OpenBaoCredentialVaultConfig {
  const token = normalizeCredentialValue(env.OPENBAO_TOKEN);
  if (!token) {
    throw new Error('OPENBAO_TOKEN is required when CREDENTIAL_VAULT_BACKEND=openbao');
  }
  const namespace = normalizeCredentialValue(env.OPENBAO_NAMESPACE);
  return {
    address: normalizeOpenBaoAddress(env.OPENBAO_ADDR),
    token,
    mount: normalizeOpenBaoPathComponent(env.OPENBAO_KV_MOUNT, 'OPENBAO_KV_MOUNT'),
    path: normalizeOpenBaoPathComponent(env.OPENBAO_KV_PATH, 'OPENBAO_KV_PATH'),
    kvVersion: normalizeOpenBaoKvVersion(env.OPENBAO_KV_VERSION),
    ...(namespace ? { namespace } : {}),
  };
}

export async function createOpenBaoCredentialVault(
  config: OpenBaoCredentialVaultConfig,
  options: CredentialVaultFactoryOptions = {},
): Promise<CredentialVaultPort> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(buildOpenBaoSecretUrl(config), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-Vault-Token': config.token,
      ...(config.namespace ? { 'X-Vault-Namespace': config.namespace } : {}),
    },
  });
  if (!response.ok) {
    const body = normalizeCredentialValue(await response.text());
    throw new Error(
      body
        ? `OpenBao credential vault request failed with ${response.status}: ${body}`
        : `OpenBao credential vault request failed with ${response.status}`,
    );
  }
  const payload = await response.json();
  return createStaticCredentialVault(parseOpenBaoSecretRecord(payload, config));
}

export async function createCredentialVaultFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: CredentialVaultFactoryOptions = {},
): Promise<CredentialVaultPort> {
  const backend = resolveCredentialVaultBackend(env);
  if (backend === 'env') {
    return createEnvCredentialVault(env);
  }
  return await createOpenBaoCredentialVault(
    resolveOpenBaoCredentialVaultConfig(env),
    options,
  );
}

export function resolveOptionalEnvCredential(
  vault: CredentialVaultPort | undefined,
  envName: string,
  fallbackEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return resolveOptionalCredentialReference(vault, envCredential(envName), fallbackEnv);
}

export function resolveOptionalCredentialReference(
  vault: CredentialVaultPort | undefined,
  reference: CredentialReference,
  fallbackEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
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
  for (const reference of resolveProviderCredentialReferences(provider, config)) {
    const value = resolveOptionalCredentialReference(config.credentialVault, reference, fallbackEnv);
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
