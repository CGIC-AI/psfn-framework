// ── Credential resolution seam (psfn-framework-f77ca) ──
//
// This module is the secret-free half of credential custody: reference shapes,
// the vault *port* every consumer depends on, and the resolvers that read a
// credential through an injected port (falling back to the process environment
// when no port is wired).
//
// It deliberately holds no vault *construction*: no env/static vault factory,
// no OpenBao client, no credential-vault backend selection, and no provider
// API-key tables. Those live in `boundary/custody/credential-vault.ts`, which
// only the gateway may import by value — the agent process must never pull the
// secret-bearing custody surface into its static import closure
// (src/app/agent/agent-import-boundary.test.ts).
//
// The split follows the mp1pf precedent: shared code names credentials and
// resolves them through whatever port it is handed. The gateway hands it a real
// vault; the agent hands it nothing, so a vault-only credential reads as "not
// configured" — fail closed, never fail open.

const ENV_CREDENTIAL_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

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

/**
 * The injected credential-resolution port. Implementations live behind the
 * gateway custody boundary; shared and agent-side code only ever consumes this
 * interface.
 */
export interface CredentialVaultPort {
  resolveOptional(reference: CredentialReference): string | undefined;
  resolveRequired(reference: CredentialReference, description: string): string;
  has(reference: CredentialReference): boolean;
}

export function normalizeCredentialValue(value: unknown): string | undefined {
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

export function envCredential(envName: string): EnvCredentialReference {
  return {
    kind: 'env',
    envName: normalizeEnvCredentialName(envName),
  };
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

export function resolveOptionalEnvCredential(
  vault: CredentialVaultPort | undefined,
  envName: string,
  fallbackEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return resolveOptionalCredentialReference(vault, envCredential(envName), fallbackEnv);
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

export function resolveHuggingFaceToken(
  config: { credentialVault?: CredentialVaultPort } = {},
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
