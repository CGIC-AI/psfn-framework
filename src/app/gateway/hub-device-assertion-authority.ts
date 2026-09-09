import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  extractHubDeviceAssertionBlock,
  parseHubDeviceAssertionVerifierConfig,
} from '../../boundary/fleet-auth/hub-device-assertion-config.js';
import {
  verifyAndConsumeHubDeviceAssertion,
  type HubDeviceAssertionExpectedBinding,
  type HubDeviceAssertionReplayStore,
  type HubDeviceAssertionVerifierConfig,
  type HubDevicePrincipal,
} from '../../boundary/fleet-auth/hub-device-assertion.js';
import { InMemoryHubDeviceAssertionReplayStore } from '../../boundary/fleet-auth/hub-device-assertion-replay-memory.js';
import { GuestOnlyHubDeviceAttachmentStore } from '../../boundary/fleet-auth/hub-device-guest-attachments.js';
import type { HubDeviceHumanAttachmentPort } from '../../boundary/fleet-auth/hub-device-ingress.js';
import {
  resolveOptionalEnvCredential,
  type CredentialVaultPort,
} from '../../shared/contracts/credential-contracts.js';
import type { SatelliteRegistryConfig } from '../../shared/contracts/satellite-registry.js';
import type { SessionHmacKeyring } from '../../persistence/journals/journal/types.js';

/**
 * Standalone Hub device assertion authority.
 *
 * Fleet auth (SSO) is an optional sign-in method; the authority that admits
 * an enrolled Hub device (and with it world.body / world.travel) must be
 * provisionable from an owner file plus a key alone (psfn-framework-n66dn.2).
 * This module builds the same `hubDeviceAssertionVerifier` object the
 * fleet-auth persistence exposes, from:
 *
 *   - the verifier ring: `satellites.json` `hubDeviceAssertions`, or the JSON
 *     file named by `PSFN_HUB_DEVICE_ASSERTIONS_PATH` (a bare block, a
 *     `{ hubDeviceAssertions }` wrapper, or a satellites.json document);
 *   - replay protection: a process-local single-use fence
 *     (`InMemoryHubDeviceAssertionReplayStore`);
 *   - the audit pepper: `HUB_DEVICE_ASSERTION_AUDIT_PEPPER` (>= 32 chars),
 *     else derived from the gateway's active session HMAC key, which gateway
 *     mode already requires — nothing new is demanded of the operator.
 *
 * Precedence: fleet-auth.json ring > env file > satellites.json. A shadowed
 * ring is reported through `warn` so an operator sees which authority is live.
 */
export const HUB_DEVICE_ASSERTIONS_PATH_ENV = 'PSFN_HUB_DEVICE_ASSERTIONS_PATH';
export const HUB_DEVICE_ASSERTION_AUDIT_PEPPER_ENV = 'HUB_DEVICE_ASSERTION_AUDIT_PEPPER';
const AUDIT_PEPPER_DERIVATION_DOMAIN = 'psfn:hub-device-assertion-audit-pepper:v1';
const MIN_PEPPER_LENGTH = 32;

type HubDeviceAssertionAuthoritySource =
  | 'fleet-auth.json'
  | 'env-file'
  | 'satellites.json';

export interface StandaloneHubDeviceAssertionConfig {
  source: Exclude<HubDeviceAssertionAuthoritySource, 'fleet-auth.json'>;
  /** Absolute path of the file the ring was read from. */
  path: string;
  config: HubDeviceAssertionVerifierConfig;
}

export interface HubDeviceAssertionVerifierAuthority {
  source: HubDeviceAssertionAuthoritySource;
  verifyAndConsumeHubDeviceAssertion(
    token: string,
    expected: HubDeviceAssertionExpectedBinding,
  ): Promise<HubDevicePrincipal>;
  attachHubDeviceHuman(
    input: Parameters<HubDeviceHumanAttachmentPort['attach']>[0],
  ): ReturnType<HubDeviceHumanAttachmentPort['attach']>;
  fenceHubDeviceAttachment(
    input: Parameters<HubDeviceHumanAttachmentPort['fenceDevice']>[0],
  ): ReturnType<HubDeviceHumanAttachmentPort['fenceDevice']>;
}

export function loadStandaloneHubDeviceAssertionConfig(options: {
  systemDataDir: string;
  satelliteRegistry: SatelliteRegistryConfig;
  env?: NodeJS.ProcessEnv;
  warn?: (message: string, details?: Record<string, unknown>) => void;
}): StandaloneHubDeviceAssertionConfig | undefined {
  const env = options.env ?? process.env;
  const warn = options.warn ?? (() => undefined);
  const envPath = env[HUB_DEVICE_ASSERTIONS_PATH_ENV]?.trim();
  const fromRegistry = options.satelliteRegistry.hubDeviceAssertions;
  const registryPath = resolve(options.systemDataDir, 'satellites.json');
  if (envPath) {
    const path = resolve(envPath);
    if (!existsSync(path)) {
      throw new Error(`${HUB_DEVICE_ASSERTIONS_PATH_ENV} names a file that does not exist: ${path}`);
    }
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
      throw new Error(
        `${HUB_DEVICE_ASSERTIONS_PATH_ENV} file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const block = extractHubDeviceAssertionBlock(document);
    if (block === undefined) {
      throw new Error(
        `${HUB_DEVICE_ASSERTIONS_PATH_ENV} file must contain a hubDeviceAssertions verifier block`,
      );
    }
    const config = parseHubDeviceAssertionVerifierConfig(block, {
      field: `${HUB_DEVICE_ASSERTIONS_PATH_ENV}.hubDeviceAssertions`,
    });
    if (fromRegistry) {
      warn('satellites.json hubDeviceAssertions is shadowed by the standalone verifier file', {
        envPath: path,
        registryPath,
      });
    }
    return { source: 'env-file', path, config };
  }
  if (fromRegistry) {
    return { source: 'satellites.json', path: registryPath, config: fromRegistry };
  }
  return undefined;
}

/**
 * Resolve the pepper that keys the content-free audit digests. An explicit
 * `HUB_DEVICE_ASSERTION_AUDIT_PEPPER` wins; otherwise the pepper is derived
 * from the gateway's active session HMAC key under a fixed domain string, so
 * a deployment that already runs a gateway needs no additional secret.
 */
export function resolveHubDeviceAssertionAuditPepper(options: {
  env?: NodeJS.ProcessEnv;
  credentialVault?: CredentialVaultPort;
  sessionHmacKeyring?: SessionHmacKeyring;
}): string {
  const env = options.env ?? process.env;
  const explicit = resolveOptionalEnvCredential(
    options.credentialVault,
    HUB_DEVICE_ASSERTION_AUDIT_PEPPER_ENV,
    env,
  );
  if (explicit !== undefined) {
    if (explicit.length < MIN_PEPPER_LENGTH) {
      throw new Error(
        `${HUB_DEVICE_ASSERTION_AUDIT_PEPPER_ENV} must be at least ${MIN_PEPPER_LENGTH} characters`,
      );
    }
    return explicit;
  }
  const keyring = options.sessionHmacKeyring;
  const activeKey = keyring?.keys[keyring.activeVersion];
  if (!activeKey) {
    throw new Error(
      'Hub device assertion audit pepper requires '
      + `${HUB_DEVICE_ASSERTION_AUDIT_PEPPER_ENV} or the gateway session HMAC keyring`,
    );
  }
  return createHmac('sha256', activeKey)
    .update(AUDIT_PEPPER_DERIVATION_DOMAIN)
    .update('\0')
    .update(keyring!.activeVersion)
    .digest('hex');
}

export function createStandaloneHubDeviceAssertionAuthority(options: {
  standalone: StandaloneHubDeviceAssertionConfig;
  sessionPepper: string;
  replayStore?: HubDeviceAssertionReplayStore;
  attachments?: HubDeviceHumanAttachmentPort;
  now?: () => number;
}): HubDeviceAssertionVerifierAuthority {
  if (options.sessionPepper.length < MIN_PEPPER_LENGTH) {
    throw new Error('Hub device assertion audit pepper must be at least 32 characters');
  }
  const now = options.now ?? (() => Date.now());
  const replayStore = options.replayStore
    ?? new InMemoryHubDeviceAssertionReplayStore({ now });
  const attachments = options.attachments
    ?? new GuestOnlyHubDeviceAttachmentStore({ now });
  const config = options.standalone.config;
  return {
    source: options.standalone.source,
    verifyAndConsumeHubDeviceAssertion: (token, expected) => verifyAndConsumeHubDeviceAssertion({
      token,
      expected,
      config,
      replayStore,
      sessionPepper: options.sessionPepper,
      nowSeconds: Math.floor(now() / 1000),
    }),
    attachHubDeviceHuman: input => attachments.attach(input),
    fenceHubDeviceAttachment: input => attachments.fenceDevice(input),
  };
}

/**
 * Pick the verifier the gateway passes to the API surface. Fleet auth, when
 * present, keeps its Postgres-backed verifier (the kube-test enrollment path);
 * any standalone ring is then reported as shadowed rather than silently
 * ignored. Without fleet auth the standalone authority is the verifier.
 */
export function resolveGatewayHubDeviceAssertionVerifier(options: {
  fleetAuthVerifier?: Pick<
    HubDeviceAssertionVerifierAuthority,
    'verifyAndConsumeHubDeviceAssertion' | 'attachHubDeviceHuman' | 'fenceHubDeviceAttachment'
  >;
  standalone?: StandaloneHubDeviceAssertionConfig;
  sessionPepper: () => string;
  warn: (message: string, details?: Record<string, unknown>) => void;
  info: (message: string, details?: Record<string, unknown>) => void;
}): HubDeviceAssertionVerifierAuthority | undefined {
  if (options.fleetAuthVerifier) {
    if (options.standalone) {
      options.warn(
        'Hub device assertion ring in the standalone owner file is shadowed by fleet-auth.json',
        { shadowedSource: options.standalone.source, shadowedPath: options.standalone.path },
      );
    }
    return {
      source: 'fleet-auth.json',
      verifyAndConsumeHubDeviceAssertion: (token, expected) => options.fleetAuthVerifier!
        .verifyAndConsumeHubDeviceAssertion(token, expected),
      attachHubDeviceHuman: input => options.fleetAuthVerifier!.attachHubDeviceHuman(input),
      fenceHubDeviceAttachment: input => options.fleetAuthVerifier!.fenceHubDeviceAttachment(input),
    };
  }
  if (!options.standalone) return undefined;
  const authority = createStandaloneHubDeviceAssertionAuthority({
    standalone: options.standalone,
    sessionPepper: options.sessionPepper(),
  });
  options.info('Hub device assertion verifier ready without fleet auth', {
    source: options.standalone.source,
    path: options.standalone.path,
    issuer: options.standalone.config.issuer,
    audience: options.standalone.config.audience,
    keyIds: options.standalone.config.keys.map(key => `${key.kid}:${key.status}`).join(','),
  });
  return authority;
}
