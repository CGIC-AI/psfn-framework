// ── Cert-manager sidecar configuration ──
//
// The sidecar is standalone: its knobs live in its own `cert-manager.json`
// inside the sidecar state dir (default `<system-data>/cert-manager/`), NOT
// in the runtime settings-contract owner map. The bearer token is a secret
// and therefore stays in the environment (`CERT_MANAGER_TOKEN`), matching
// the repo's env-scope rules.
//
// Parsing is strict and fail-closed: unknown keys, wrong types, and
// out-of-range values are startup errors, never silently defaulted.

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveRuntimePathLayout } from '../../persistence/layout.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';

export const CERT_MANAGER_CONFIG_FILENAME = 'cert-manager.json';
export const DEFAULT_CERT_MANAGER_PORT = 10070;
export const DEFAULT_CERT_MANAGER_HOST = '127.0.0.1';
export const DEFAULT_CA_COMMON_NAME = 'PSFN Private CA';
export const DEFAULT_CA_VALIDITY_DAYS = 3650; // ~10y
export const DEFAULT_SERVER_CERT_DAYS = 90;
export const DEFAULT_CLIENT_CERT_DAYS = 90;
export const DEFAULT_RENEW_BEFORE_DAYS = 30;
export const DEFAULT_RENEW_CHECK_INTERVAL_MINUTES = 60;

export interface CertManagerListenConfig {
  host: string;
  port: number;
  /** Explicit opt-in required to bind anything other than loopback. */
  allowNonLoopback: boolean;
}

export interface CertManagerCaConfig {
  commonName: string;
  validityDays: number;
}

export interface CertManagerDefaultsConfig {
  serverCertDays: number;
  clientCertDays: number;
  renewBeforeDays: number;
  renewCheckIntervalMinutes: number;
}

export interface CertManagerConfig {
  version: 1;
  listen: CertManagerListenConfig;
  ca: CertManagerCaConfig;
  defaults: CertManagerDefaultsConfig;
}

export function defaultCertManagerConfig(): CertManagerConfig {
  return {
    version: 1,
    listen: {
      host: DEFAULT_CERT_MANAGER_HOST,
      port: DEFAULT_CERT_MANAGER_PORT,
      allowNonLoopback: false,
    },
    ca: {
      commonName: DEFAULT_CA_COMMON_NAME,
      validityDays: DEFAULT_CA_VALIDITY_DAYS,
    },
    defaults: {
      serverCertDays: DEFAULT_SERVER_CERT_DAYS,
      clientCertDays: DEFAULT_CLIENT_CERT_DAYS,
      renewBeforeDays: DEFAULT_RENEW_BEFORE_DAYS,
      renewCheckIntervalMinutes: DEFAULT_RENEW_CHECK_INTERVAL_MINUTES,
    },
  };
}

/**
 * Resolve the sidecar state directory. `CERT_MANAGER_STATE_DIR` wins;
 * otherwise the sidecar follows the runtime path discipline in
 * `src/persistence/layout.ts` and nests under the system-data root, which is
 * the system-owned side of the two-root topology (never companion-data).
 */
export function resolveCertManagerStateDir(env: NodeJS.ProcessEnv): string {
  const explicit = env.CERT_MANAGER_STATE_DIR?.trim();
  if (explicit) return resolve(explicit);
  const layout = resolveRuntimePathLayout({
    mode: env.PSFN_RUNTIME_LAYOUT_MODE,
    nodeEnv: env.NODE_ENV,
    runtimeRootDir: env.PSFN_RUNTIME_ROOT,
    systemDataDir: env.SYSTEM_DATA_DIR,
    companionDataDir: env.COMPANION_DATA_DIR,
    legacyDataDir: env.DATA_DIR,
  });
  return resolve(join(layout.systemDataDir, 'cert-manager'));
}

export function certManagerConfigPath(stateDir: string): string {
  return join(stateDir, CERT_MANAGER_CONFIG_FILENAME);
}

function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown key(s): ${unknown.join(', ')} (allowed: ${allowed.join(', ')})`);
  }
}

function parsePositiveInt(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(`${label} must be a positive integer <= ${max} (got ${JSON.stringify(value)})`);
  }
  return value;
}

function parseNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function parseBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

export function parseCertManagerConfig(raw: unknown, sourceLabel: string): CertManagerConfig {
  const root = assertPlainObject(raw, sourceLabel);
  assertKnownKeys(root, ['version', 'listen', 'ca', 'defaults'], sourceLabel);
  if (root.version !== 1) {
    throw new Error(`${sourceLabel}: version must be 1 (got ${JSON.stringify(root.version)})`);
  }

  const listenRaw = assertPlainObject(root.listen, `${sourceLabel}.listen`);
  assertKnownKeys(listenRaw, ['host', 'port', 'allowNonLoopback'], `${sourceLabel}.listen`);
  const listen: CertManagerListenConfig = {
    host: parseNonEmptyString(listenRaw.host, `${sourceLabel}.listen.host`),
    port: parsePositiveInt(listenRaw.port, `${sourceLabel}.listen.port`, 65535),
    allowNonLoopback: parseBoolean(listenRaw.allowNonLoopback, `${sourceLabel}.listen.allowNonLoopback`),
  };

  const caRaw = assertPlainObject(root.ca, `${sourceLabel}.ca`);
  assertKnownKeys(caRaw, ['commonName', 'validityDays'], `${sourceLabel}.ca`);
  const ca: CertManagerCaConfig = {
    commonName: parseNonEmptyString(caRaw.commonName, `${sourceLabel}.ca.commonName`),
    validityDays: parsePositiveInt(caRaw.validityDays, `${sourceLabel}.ca.validityDays`, 36_500),
  };

  const defaultsRaw = assertPlainObject(root.defaults, `${sourceLabel}.defaults`);
  assertKnownKeys(
    defaultsRaw,
    ['serverCertDays', 'clientCertDays', 'renewBeforeDays', 'renewCheckIntervalMinutes'],
    `${sourceLabel}.defaults`,
  );
  const defaults: CertManagerDefaultsConfig = {
    serverCertDays: parsePositiveInt(defaultsRaw.serverCertDays, `${sourceLabel}.defaults.serverCertDays`, 36_500),
    clientCertDays: parsePositiveInt(defaultsRaw.clientCertDays, `${sourceLabel}.defaults.clientCertDays`, 36_500),
    renewBeforeDays: parsePositiveInt(defaultsRaw.renewBeforeDays, `${sourceLabel}.defaults.renewBeforeDays`, 36_500),
    renewCheckIntervalMinutes: parsePositiveInt(
      defaultsRaw.renewCheckIntervalMinutes,
      `${sourceLabel}.defaults.renewCheckIntervalMinutes`,
      7 * 24 * 60,
    ),
  };
  if (defaults.renewBeforeDays >= defaults.serverCertDays || defaults.renewBeforeDays >= defaults.clientCertDays) {
    throw new Error(
      `${sourceLabel}: defaults.renewBeforeDays (${defaults.renewBeforeDays}) must be smaller than ` +
      `serverCertDays (${defaults.serverCertDays}) and clientCertDays (${defaults.clientCertDays}), ` +
      'otherwise every issued certificate is immediately due for renewal',
    );
  }

  return { version: 1, listen, ca, defaults };
}

export function loadCertManagerConfig(stateDir: string): CertManagerConfig {
  const path = certManagerConfigPath(stateDir);
  if (!existsSync(path)) {
    throw new Error(
      `Cert-manager config not found at ${path}; run \`npm run cert-manager -- init\` first`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    throw new Error(`Cert-manager config at ${path} is not valid JSON: ${String(error)}`);
  }
  return parseCertManagerConfig(parsed, path);
}

export function writeCertManagerConfig(stateDir: string, config: CertManagerConfig): void {
  // Round-trip through the parser so we can never persist an invalid file.
  const validated = parseCertManagerConfig(config, 'cert-manager config');
  writeJsonAtomic(certManagerConfigPath(stateDir), validated);
}

const MIN_TOKEN_LENGTH = 32;

/**
 * Fail-closed bearer-token policy, mirroring the Garden admin startup guard
 * (`src/operator/garden/auth-policy.ts`): no token, no server. There is no
 * insecure escape hatch here — the sidecar mints credentials and must never
 * run unauthenticated, even on loopback.
 */
export function parseCertManagerToken(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) {
    throw new Error(
      'CERT_MANAGER_TOKEN is required; refusing to start the cert-manager sidecar without authentication',
    );
  }
  if (trimmed.length < MIN_TOKEN_LENGTH) {
    throw new Error(`CERT_MANAGER_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  return trimmed;
}
