#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { parseEnv } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici';
import {
  assertCompletedPersistedTurn,
  composeApiPrincipalId,
  findMatchingPersistedTurnInText,
} from './compose-verification.js';
import {
  ensureNativeK3dGarden,
  reconcileNativeGardenEdge,
} from './helm-native-garden.js';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const CHART_DIR = join(REPO_ROOT, 'deploy', 'helm', 'psfn');
const CERT_MANAGER_VERSION = 'v1.20.3';
const AUTH_CONTEXT = 'substrate-gateway-companion-auth-v1';
const CHAT_TIMEOUT_MS = 180_000;
const COMMAND_TIMEOUT_MS = 1_800_000;
const EDGE_TIMEOUT_MS = COMMAND_TIMEOUT_MS / 180;
const REQUIRED_SYSTEM_FILES = [
  'settings.json',
  'models.json',
  'providers.json',
  'companions.json',
  'trust-policy.json',
  'intake-policy.json',
  'backup.json',
  'mcp-servers.json',
  'automata-policy.json',
  'places.json',
  'runtime-prompt-layers.json',
] as const;
const REQUIRED_COMPANION_FILES = [
  'companion.json',
  'scheduler.json',
  'capability-tier.json',
  'charge-policy.json',
  'skills.json',
  'partner-affect-shadow.json',
] as const;

interface HelmContext {
  env: NodeJS.ProcessEnv;
  kubeContext: string;
  namespace: string;
  release: string;
  systemDataDir: string;
  companionDataDir: string;
  companionId: string;
  providerEnvName: string;
  providerApiKey: string;
  image: ImageReference;
  ownerConfigMap: string;
  appSecret: string;
  postgresSecret: string;
  apiPort: number;
  gardenPort: number;
  apiBase: string;
  gardenBase: string;
  k3dCluster?: string;
  nativeGarden: boolean;
  publishTailnet: boolean;
  tailnetHost?: string;
  connectionStatePath: string;
  connectionLogPath: string;
}

export interface ImageReference {
  repository: string;
  tag?: string;
  digest?: string;
  full: string;
}

interface ConnectionState {
  kubeContext: string;
  namespace: string;
  release: string;
  apiPid: number;
  gardenPid?: number;
  nativeGarden: boolean;
  apiPort: number;
  gardenPort: number;
}

interface RuntimeSecrets {
  apiKey: string;
  adminToken: string;
  hmacKey: string;
  backupKey: string;
  postgresPassword: string;
  companionPassword: string;
  sharedPassword: string;
}

function fail(message: string): never {
  throw new Error(message);
}

function run(
  command: string,
  args: string[],
  options: { input?: string; capture?: boolean; allowFailure?: boolean; env?: NodeJS.ProcessEnv } = {},
) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    env: options.env ?? process.env,
    input: options.input,
    encoding: 'utf8',
    stdio: options.capture || options.input !== undefined
      ? ['pipe', 'pipe', 'pipe']
      : 'inherit',
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    const detail = [result.stderr, result.stdout].map(value => value?.trim()).filter(Boolean).join('\n');
    fail(`${command} ${args[0] ?? ''} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function requiredTool(command: string): void {
  const args = command === 'kubectl' ? ['version', '--client'] : ['version'];
  const result = run(command, args, { capture: true, allowFailure: true });
  if (result.status !== 0) fail(`${command} is required for the public Helm lifecycle.`);
}

function positivePort(raw: string | undefined, fallback: number, name: string): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    fail(`${name} must be an integer from 1 to 65535.`);
  }
  return value;
}

function enabledFlag(raw: string | undefined, name: string): boolean {
  if (raw === undefined || raw.trim() === '' || raw.trim() === '0') return false;
  if (raw.trim() === '1') return true;
  fail(`${name} must be exactly 0 or 1.`);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    fail(`Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireRegularFiles(root: string, names: readonly string[]): void {
  for (const name of names) {
    const path = join(root, name);
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      fail(`Required generated owner file is missing: ${path}; run npm run onboard and choose Kubernetes.`);
    }
  }
}

export function parsePinnedImageReference(raw: string): ImageReference {
  const full = raw.trim();
  if (!full) fail('PSFN_IMAGE is empty.');
  const digestIndex = full.lastIndexOf('@');
  if (digestIndex >= 0) {
    const repository = full.slice(0, digestIndex);
    const digest = full.slice(digestIndex + 1);
    if (!repository || !/^sha256:[0-9a-f]{64}$/u.test(digest)) {
      fail('PSFN_IMAGE digest references must end in @sha256:<64 lowercase hex>.');
    }
    return { repository, digest, full };
  }
  const slash = full.lastIndexOf('/');
  const colon = full.lastIndexOf(':');
  if (colon <= slash) fail('PSFN_IMAGE must use an exact tag or digest.');
  const repository = full.slice(0, colon);
  const tag = full.slice(colon + 1);
  if (!repository || !tag || ['latest', 'main', 'main-latest'].includes(tag.toLowerCase())) {
    fail('PSFN_IMAGE must use a pinned tag, never latest/main/main-latest.');
  }
  return { repository, tag, full };
}

export function resolveDeploymentImageReference(
  env: NodeJS.ProcessEnv,
  head: string,
): ImageReference {
  const configured = env.PSFN_IMAGE?.trim();
  if (configured) return parsePinnedImageReference(configured);
  const localBuild = env.PSFN_HELM_LOCAL_BUILD?.trim() === '1'
    || Boolean(env.PSFN_K3D_CLUSTER?.trim());
  if (!localBuild) {
    fail('PSFN_IMAGE is required unless PSFN_K3D_CLUSTER or PSFN_HELM_LOCAL_BUILD=1 selects a local image build.');
  }
  return parsePinnedImageReference(`psfn-framework:s11-${head.slice(0, 12)}`);
}

export function resolveSingleCompanionOwnerContract(
  systemDataDir: string,
): { companionId: string; providerEnvName: string } {
  const manifest = record(readJson(join(systemDataDir, 'companions.json')));
  const companions = Array.isArray(manifest?.companions) ? manifest.companions : [];
  const companion = companions.length === 1 ? record(companions[0]) : undefined;
  const companionId = typeof companion?.companionId === 'string' ? companion.companionId : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(companionId)) {
    fail('The public Helm lifecycle currently requires exactly one valid companions.json entry.');
  }
  if (companion?.postgresSchema !== 'companion_main' || companion?.postgresRole !== 'companion_main_runtime') {
    fail('The public Helm lifecycle requires the onboarding companion_main/companion_main_runtime tenancy contract.');
  }
  const providers = record(readJson(join(systemDataDir, 'providers.json')));
  const enabledProviders = Array.isArray(providers?.providers)
    ? providers.providers.map(record).filter(provider => provider?.enabled !== false)
    : [];
  if (enabledProviders.length !== 1) {
    fail('The public Helm lifecycle currently requires exactly one enabled provider.');
  }
  const apiKeyRef = record(enabledProviders[0]?.apiKeyRef);
  const providerEnvName = typeof apiKeyRef?.envName === 'string' ? apiKeyRef.envName : '';
  if (apiKeyRef?.kind !== 'env' || !/^[A-Z][A-Z0-9_]*$/u.test(providerEnvName)) {
    fail('providers.json must reference one uppercase environment variable for its API key.');
  }
  return { companionId, providerEnvName };
}

function gitHead(): string {
  const result = run('git', ['rev-parse', 'HEAD'], { capture: true });
  const head = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(head)) fail('Cannot resolve the exact source revision.');
  return head;
}

function loadEnvironment(): NodeJS.ProcessEnv {
  const envPath = join(REPO_ROOT, '.env');
  const fileEnv = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
  return { ...fileEnv, ...process.env };
}

export function loadHelmContext(): HelmContext {
  const env = loadEnvironment();
  const kubeContext = env.PSFN_KUBE_CONTEXT?.trim();
  if (!kubeContext) {
    fail('PSFN_KUBE_CONTEXT is required; the public lifecycle never guesses a live cluster.');
  }
  const namespace = env.PSFN_HELM_NAMESPACE?.trim() || 'psfn';
  const release = env.PSFN_HELM_RELEASE?.trim() || 'psfn';
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u.test(namespace)
    || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/u.test(release)) {
    fail('PSFN_HELM_NAMESPACE and PSFN_HELM_RELEASE must be Kubernetes DNS labels.');
  }
  const systemDataDir = resolve(REPO_ROOT, env.SYSTEM_DATA_DIR?.trim() || 'data/system-data');
  const companionBase = resolve(REPO_ROOT, env.COMPANION_DATA_DIR?.trim() || 'data/companion-data');
  const companionDataDir = companionBase.endsWith('/main') ? companionBase : join(companionBase, 'main');
  requireRegularFiles(systemDataDir, REQUIRED_SYSTEM_FILES);
  requireRegularFiles(companionDataDir, REQUIRED_COMPANION_FILES);
  const owners = resolveSingleCompanionOwnerContract(systemDataDir);
  const providerApiKey = env[owners.providerEnvName]?.trim();
  if (!providerApiKey) {
    fail(`Export ${owners.providerEnvName} before helm:up; provider credentials never enter Helm values.`);
  }
  const head = gitHead();
  const image = resolveDeploymentImageReference(env, head);
  const apiPort = positivePort(env.PSFN_API_PORT, 10054, 'PSFN_API_PORT');
  const gardenPort = positivePort(env.PSFN_GARDEN_PORT, 10053, 'PSFN_GARDEN_PORT');
  const k3dCluster = env.PSFN_K3D_CLUSTER?.trim();
  const nativeGarden = enabledFlag(env.PSFN_K3D_NATIVE_GARDEN, 'PSFN_K3D_NATIVE_GARDEN');
  const publishTailnet = enabledFlag(env.PSFN_TAILSCALE_SERVE, 'PSFN_TAILSCALE_SERVE');
  const tailnetHost = env.PSFN_TAILNET_HOST?.trim().toLowerCase();
  if (nativeGarden && !k3dCluster) {
    fail('PSFN_K3D_NATIVE_GARDEN=1 requires PSFN_K3D_CLUSTER.');
  }
  if (publishTailnet && (!nativeGarden || !tailnetHost?.endsWith('.ts.net'))) {
    fail('PSFN_TAILSCALE_SERVE=1 requires native k3d Garden and the connected PSFN_TAILNET_HOST (*.ts.net).');
  }
  const identity = createHash('sha256')
    .update(`${kubeContext}\0${namespace}\0${release}`)
    .digest('hex')
    .slice(0, 16);
  return {
    env,
    kubeContext,
    namespace,
    release,
    systemDataDir,
    companionDataDir,
    companionId: owners.companionId,
    providerEnvName: owners.providerEnvName,
    providerApiKey,
    image,
    ownerConfigMap: `${release}-owner-files`,
    appSecret: `${release}-runtime-secrets`,
    postgresSecret: `${release}-postgres-secrets`,
    apiPort,
    gardenPort,
    apiBase: `http://127.0.0.1:${apiPort}`,
    gardenBase: `${nativeGarden ? 'https' : 'http'}://127.0.0.1:${gardenPort}`,
    ...(k3dCluster ? { k3dCluster } : {}),
    nativeGarden,
    publishTailnet,
    ...(tailnetHost ? { tailnetHost } : {}),
    connectionStatePath: `/tmp/psfn-helm-${identity}.json`,
    connectionLogPath: `/tmp/psfn-helm-${identity}.log`,
  };
}

function kubeArgs(context: HelmContext, args: string[]): string[] {
  return ['--context', context.kubeContext, '-n', context.namespace, ...args];
}

function kubectl(context: HelmContext, args: string[], options: Parameters<typeof run>[2] = {}) {
  return run('kubectl', kubeArgs(context, args), options);
}

function applyKubernetesObject(context: HelmContext, value: unknown): void {
  kubectl(context, ['apply', '-f', '-'], { input: `${JSON.stringify(value)}\n`, capture: true });
}

function ensureNamespace(context: HelmContext): void {
  const result = run('kubectl', [
    '--context', context.kubeContext,
    'create', 'namespace', context.namespace,
    '--dry-run=client', '-o', 'json',
  ], { capture: true });
  run('kubectl', ['--context', context.kubeContext, 'apply', '-f', '-'], {
    input: result.stdout,
    capture: true,
  });
}

function ownerFileData(context: HelmContext): Record<string, string> {
  return Object.fromEntries([
    ...REQUIRED_SYSTEM_FILES.map(name => [name, readFileSync(join(context.systemDataDir, name), 'utf8')]),
    ...REQUIRED_COMPANION_FILES.map(name => [name, readFileSync(join(context.companionDataDir, name), 'utf8')]),
  ]);
}

function stageOwnerFiles(context: HelmContext): void {
  applyKubernetesObject(context, {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: {
      name: context.ownerConfigMap,
      namespace: context.namespace,
      labels: { 'app.kubernetes.io/managed-by': 'psfn-helm-lifecycle' },
    },
    immutable: false,
    data: ownerFileData(context),
  });
}

function decodeSecretData(value: unknown): Record<string, string> | undefined {
  const object = record(value);
  const data = record(object?.data);
  if (!data) return undefined;
  return Object.fromEntries(Object.entries(data).flatMap(([key, encoded]) => (
    typeof encoded === 'string' ? [[key, Buffer.from(encoded, 'base64').toString('utf8')]] : []
  )));
}

function existingSecret(context: HelmContext, name: string): Record<string, string> | undefined {
  const result = kubectl(context, ['get', 'secret', name, '-o', 'json'], {
    capture: true,
    allowFailure: true,
  });
  return result.status === 0 ? decodeSecretData(JSON.parse(result.stdout) as unknown) : undefined;
}

function retained(existing: Record<string, string> | undefined, key: string): string {
  return existing?.[key]?.trim() || randomBytes(32).toString('hex');
}

function deriveRoleProof(hmacKey: string, role: string, companionId: string): string {
  return `v1.${createHmac('sha256', hmacKey)
    .update(`${AUTH_CONTEXT}\0${role}\0${companionId}`, 'utf8')
    .digest('hex')}`;
}

function resolveSecrets(context: HelmContext): RuntimeSecrets {
  const app = existingSecret(context, context.appSecret);
  const postgres = existingSecret(context, context.postgresSecret);
  return {
    apiKey: retained(app, 'API_KEY'),
    adminToken: retained(app, 'ADMIN_TOKEN'),
    hmacKey: retained(app, 'GATEWAY_SESSION_HMAC_KEY'),
    backupKey: retained(app, 'PSFN_BACKUP_ENCRYPTION_KEY'),
    postgresPassword: retained(postgres, 'postgres-password'),
    companionPassword: retained(postgres, 'companion-database-password'),
    sharedPassword: retained(postgres, 'shared-migration-database-password'),
  };
}

function stageSecrets(context: HelmContext): void {
  const secrets = resolveSecrets(context);
  const postgresHost = `${context.release}-postgres`;
  const adminUrl = `postgresql://postgres:${secrets.postgresPassword}@${postgresHost}:5432/psfn`;
  const companionUrl = `postgresql://companion_main_runtime:${secrets.companionPassword}@${postgresHost}:5432/psfn`;
  const sharedUrl = `postgresql://shared_schema_migration:${secrets.sharedPassword}@${postgresHost}:5432/psfn`;
  applyKubernetesObject(context, {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: context.appSecret,
      namespace: context.namespace,
      labels: { 'app.kubernetes.io/managed-by': 'psfn-helm-lifecycle' },
    },
    type: 'Opaque',
    stringData: {
      API_KEY: secrets.apiKey,
      ADMIN_TOKEN: secrets.adminToken,
      GATEWAY_SESSION_HMAC_KEY: secrets.hmacKey,
      GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN: deriveRoleProof(
        secrets.hmacKey,
        'internal_session_integrity',
        context.companionId,
      ),
      GATEWAY_COMPANION_AUTH_TOKEN: deriveRoleProof(secrets.hmacKey, 'agent', context.companionId),
      PSFN_BACKUP_ENCRYPTION_KEY: secrets.backupKey,
      'provider-api-key': context.providerApiKey,
    },
  });
  applyKubernetesObject(context, {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: context.postgresSecret,
      namespace: context.namespace,
      labels: { 'app.kubernetes.io/managed-by': 'psfn-helm-lifecycle' },
    },
    type: 'Opaque',
    stringData: {
      'postgres-password': secrets.postgresPassword,
      'postgres-admin-database-url': adminUrl,
      'postgres-database-url': companionUrl,
      'shared-migration-database-url': sharedUrl,
      'companion-database-password': secrets.companionPassword,
      'shared-migration-database-password': secrets.sharedPassword,
    },
  });
}

function ensureCertManager(context: HelmContext): void {
  run('helm', [
    'repo', 'add', 'jetstack', 'https://charts.jetstack.io', '--force-update',
  ]);
  run('helm', ['repo', 'update', 'jetstack']);
  run('helm', [
    'upgrade', '--install', 'cert-manager', 'jetstack/cert-manager',
    '--kube-context', context.kubeContext,
    '--namespace', 'cert-manager',
    '--create-namespace',
    '--version', CERT_MANAGER_VERSION,
    '--set', 'crds.enabled=true',
    '--wait',
    '--timeout', '10m',
  ]);
}

function prepareImage(context: HelmContext): void {
  const k3dCluster = context.k3dCluster;
  const localBuild = context.env.PSFN_HELM_LOCAL_BUILD?.trim() === '1' || Boolean(k3dCluster);
  if (!localBuild) return;
  if (context.image.digest) fail('Local Helm image builds require a pinned tag, not a digest reference.');
  run('docker', [
    'build',
    '--build-arg', `PSFN_GIT_COMMIT=${gitHead()}`,
    '--file', 'docker/Dockerfile.agent',
    '--tag', context.image.full,
    '.',
  ]);
  if (k3dCluster) {
    if (context.kubeContext !== `k3d-${k3dCluster}`) {
      fail('PSFN_K3D_CLUSTER must name the exact cluster selected by PSFN_KUBE_CONTEXT.');
    }
    run('k3d', ['image', 'import', '--cluster', k3dCluster, context.image.full]);
  }
}

function previousGitCommit(context: HelmContext): string {
  const result = run('helm', [
    'get', 'values', context.release,
    '--kube-context', context.kubeContext,
    '--namespace', context.namespace,
    '--output', 'json',
  ], { capture: true, allowFailure: true });
  if (result.status !== 0) return '';
  try {
    const values = record(JSON.parse(result.stdout) as unknown);
    const image = record(values?.psfnAppImage);
    return typeof image?.gitCommit === 'string' ? image.gitCommit : '';
  } catch {
    return '';
  }
}

function helmSetArgs(context: HelmContext): string[] {
  const head = gitHead();
  const strings: Array<[string, string]> = [
    ['psfnAppImage.repository', context.image.repository],
    ['psfnAppImage.tag', context.image.tag ?? ''],
    ['psfnAppImage.digest', context.image.digest ?? ''],
    ['psfnAppImage.gitCommit', head],
    ['psfnAppImage.previousGitCommit', previousGitCommit(context)],
    ['runtime.companionId', context.companionId],
    ['runtime.companionDataDir', '/runtime/companion-data/main'],
    ['runtime.characterCardPath', '/runtime/companion-data/main/companion.json'],
    ['runtime.workspacePath', `/runtime/workspaces/personal/${context.companionId}`],
    ['runtime.postgresSchema', 'companion_main'],
    ['ownerFiles.existingConfigMap', context.ownerConfigMap],
    ['provider.envName', context.providerEnvName],
    ['secrets.existingSecret', context.appSecret],
    ['secrets.keys.providerApiKey', 'provider-api-key'],
    ['postgres.auth.username', 'postgres'],
    ['postgres.auth.existingSecret', context.postgresSecret],
    ['postgres.restoreVerify.roles.companionSchemaOwners[0]', 'companion_main_runtime'],
    ['ingress.garden.host', context.nativeGarden ? '' : 'psfn-garden.local'],
  ];
  const booleans: Array<[string, boolean]> = [
    ['fleet.enabled', false],
    ['fleetAuth.enabled', false],
    ['runtimeBootstrap.enabled', true],
    ['secrets.create', false],
    ['redis.enabled', false],
    ['emosim.enabled', false],
    ['modelPrefetch.enabled', true],
    ['ingress.enabled', context.nativeGarden],
    ['ingress.gateway.enabled', false],
    ['ingress.garden.enabled', context.nativeGarden],
    ['hostPorts.gatewayApi.enabled', false],
    ['hostPorts.garden.enabled', false],
  ];
  return [
    ...strings.flatMap(([name, value]) => ['--set-string', `${name}=${value}`]),
    ...booleans.flatMap(([name, value]) => ['--set', `${name}=${String(value)}`]),
  ];
}

function deploy(context: HelmContext): void {
  if (context.nativeGarden) {
    requiredTool('k3d');
    const outcome = ensureNativeK3dGarden({
      clusterName: context.k3dCluster as string,
      cwd: REPO_ROOT,
      gardenPort: context.gardenPort,
      kubeContext: context.kubeContext,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    console.log(`${outcome === 'created' ? 'Created' : 'Using'} native k3d Garden binding on ${context.gardenBase}.`);
  }
  requiredTool('kubectl');
  requiredTool('helm');
  ensureCertManager(context);
  ensureNamespace(context);
  stageOwnerFiles(context);
  stageSecrets(context);
  prepareImage(context);
  run('helm', [
    'upgrade', '--install', context.release, CHART_DIR,
    '--kube-context', context.kubeContext,
    '--namespace', context.namespace,
    '--atomic',
    '--wait',
    '--wait-for-jobs',
    '--timeout', '30m',
    ...helmSetArgs(context),
  ]);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readConnection(context: HelmContext): ConnectionState | undefined {
  if (!existsSync(context.connectionStatePath)) return undefined;
  try {
    const value = JSON.parse(readFileSync(context.connectionStatePath, 'utf8')) as ConnectionState;
    if (value.kubeContext !== context.kubeContext
      || value.namespace !== context.namespace
      || value.release !== context.release) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function writeConnection(context: HelmContext, state: ConnectionState): void {
  const nextPath = `${context.connectionStatePath}.next`;
  writeFileSync(nextPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(nextPath, context.connectionStatePath);
}

async function assertPortAvailable(port: number, name: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`${name} port ${port} is already occupied`)));
    server.listen(port, '127.0.0.1', () => server.close(() => resolvePromise()));
  });
}

async function waitForPortAvailable(port: number, name: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  do {
    try {
      await assertPortAvailable(port, name);
      return;
    } catch {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
    }
  } while (Date.now() <= deadline);
  await assertPortAvailable(port, name);
}

function stopConnection(context: HelmContext): void {
  const state = readConnection(context);
  if (state) {
    for (const pid of [state.apiPid, state.gardenPid]) {
      if (typeof pid === 'number' && isProcessAlive(pid)) process.kill(pid, 'SIGTERM');
    }
  }
  if (existsSync(context.connectionStatePath)) unlinkSync(context.connectionStatePath);
}

function connectionProcessesReady(context: HelmContext, state: ConnectionState): boolean {
  if (!isProcessAlive(state.apiPid) || state.nativeGarden !== context.nativeGarden) return false;
  return context.nativeGarden
    || (typeof state.gardenPid === 'number' && isProcessAlive(state.gardenPid));
}

async function requestGarden(
  context: HelmContext,
  path: string,
  init: UndiciRequestInit = {},
  timeoutMs = 10_000,
): Promise<{ status: number; ok: boolean; text: string; setCookie?: string }> {
  const dispatcher = context.nativeGarden
    ? new Agent({ connect: { rejectUnauthorized: false } })
    : undefined;
  try {
    const response = await undiciFetch(`${context.gardenBase}${path}`, {
      ...init,
      ...(dispatcher ? { dispatcher } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    const setCookie = response.headers.get('set-cookie');
    return {
      status: response.status,
      ok: response.ok,
      text,
      ...(setCookie ? { setCookie } : {}),
    };
  } finally {
    if (dispatcher) await dispatcher.close();
  }
}

async function startConnection(context: HelmContext): Promise<void> {
  const existing = readConnection(context);
  if (existing && connectionProcessesReady(context, existing)
    && existing.apiPort === context.apiPort && existing.gardenPort === context.gardenPort) {
    try {
      const [api, garden] = await Promise.all([
        fetch(`${context.apiBase}/health`, { signal: AbortSignal.timeout(2_000) }),
        requestGarden(context, '/health', {}, 2_000),
      ]);
      if (api.status < 500 && garden.ok) return;
    } catch { /* stale port-forward after a workload restart */ }
  }
  stopConnection(context);
  await waitForPortAvailable(context.apiPort, 'Gateway');
  if (!context.nativeGarden) await waitForPortAvailable(context.gardenPort, 'Garden');
  const logFd = openSync(context.connectionLogPath, 'a');
  const start = (service: string, localPort: number, remotePort: number) => {
    const child = spawn('kubectl', kubeArgs(context, [
      'port-forward', `service/${service}`,
      '--address', '127.0.0.1',
      `${localPort}:${remotePort}`,
    ]), {
      cwd: REPO_ROOT,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    if (!child.pid) fail(`Failed to start port-forward for ${service}.`);
    child.unref();
    return child.pid;
  };
  const apiPid = start(`${context.release}-gateway`, context.apiPort, 10053);
  const gardenPid = context.nativeGarden
    ? undefined
    : start(`${context.release}-garden`, context.gardenPort, 10054);
  closeSync(logFd);
  writeConnection(context, {
    kubeContext: context.kubeContext,
    namespace: context.namespace,
    release: context.release,
    apiPid,
    ...(gardenPid ? { gardenPid } : {}),
    nativeGarden: context.nativeGarden,
    apiPort: context.apiPort,
    gardenPort: context.gardenPort,
  });
  const deadline = Date.now() + 30_000;
  do {
    if (!isProcessAlive(apiPid) || (gardenPid !== undefined && !isProcessAlive(gardenPid))) {
      stopConnection(context);
      fail(`Kubernetes port-forward exited; inspect ${context.connectionLogPath}.`);
    }
    try {
      const [api, garden] = await Promise.all([
        fetch(`${context.apiBase}/health`, { signal: AbortSignal.timeout(2_000) }),
        requestGarden(context, '/health', {}, 2_000),
      ]);
      if (api.status < 500 && garden.ok) return;
    } catch { /* port-forward startup */ }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
  } while (Date.now() <= deadline);
  stopConnection(context);
  fail(`Kubernetes services did not become reachable; inspect ${context.connectionLogPath}.`);
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { response, body };
}

function reconcileGardenEdge(context: HelmContext, configureServe: boolean): void {
  if (!context.nativeGarden) return;
  const tailnetHost = reconcileNativeGardenEdge({
    configureServe,
    cwd: REPO_ROOT,
    env: context.env,
    gardenPort: context.gardenPort,
    publishTailnet: context.publishTailnet,
    ...(context.tailnetHost ? { tailnetHost: context.tailnetHost } : {}),
    timeoutMs: EDGE_TIMEOUT_MS,
  });
  console.log(`Garden:  ${context.gardenBase}/login (native k3d ingress)`);
  if (tailnetHost) console.log(`Garden:  https://${tailnetHost}/login (Tailscale HTTPS)`);
}

function appSecrets(context: HelmContext): Record<string, string> {
  const secret = existingSecret(context, context.appSecret);
  if (!secret?.API_KEY || !secret.ADMIN_TOKEN) fail('Runtime Secret is missing API_KEY or ADMIN_TOKEN.');
  return secret;
}

async function doctor(context: HelmContext): Promise<void> {
  const status = run('helm', [
    'status', context.release,
    '--kube-context', context.kubeContext,
    '--namespace', context.namespace,
    '--output', 'json',
  ], { capture: true });
  const releaseStatus = record(record(JSON.parse(status.stdout) as unknown)?.info)?.status;
  if (releaseStatus !== 'deployed') fail(`Helm release status is ${String(releaseStatus)}, not deployed.`);
  const workloads = kubectl(context, [
    'get',
    `deployment/${context.release}-gateway`,
    `deployment/${context.release}-agent`,
    `deployment/${context.release}-garden`,
    `deployment/${context.release}-operator-alert-sink`,
    `statefulset/${context.release}-postgres`,
    '-o', 'json',
  ], { capture: true });
  const items = record(JSON.parse(workloads.stdout) as unknown)?.items;
  if (!Array.isArray(items)) fail('Kubernetes did not return workload status.');
  const expected = new Set(['gateway', 'agent', 'garden', 'operator-alert-sink', 'postgres']);
  for (const item of items) {
    const object = record(item);
    const metadata = record(object?.metadata);
    const name = typeof metadata?.name === 'string' ? metadata.name : '';
    const component = name.startsWith(`${context.release}-`)
      ? name.slice(context.release.length + 1)
      : '';
    if (!expected.has(component)) continue;
    const spec = record(object?.spec);
    const statusValue = record(object?.status);
    const desired = typeof spec?.replicas === 'number' ? spec.replicas : 1;
    const ready = typeof statusValue?.readyReplicas === 'number' ? statusValue.readyReplicas : 0;
    if (desired !== 1 || ready !== 1) fail(`${component} is not exactly 1/1 ready.`);
    expected.delete(component);
  }
  if (expected.size > 0) fail(`Required Kubernetes workloads are missing: ${[...expected].join(', ')}`);
  await startConnection(context);
  reconcileGardenEdge(context, false);
  const secrets = appSecrets(context);
  const gateway = await fetchJson(`${context.apiBase}/health`, {
    headers: { Authorization: `Bearer ${secrets.API_KEY}` },
  });
  const subsystems = record(record(gateway.body)?.subsystems);
  for (const name of ['memory', 'embeddings', 'scheduler']) {
    if (record(subsystems?.[name])?.status !== 'healthy') fail(`Gateway subsystem ${name} is not healthy.`);
  }
  const gardenHealth = await requestGarden(context, '/health');
  let gardenHealthBody: unknown;
  try { gardenHealthBody = JSON.parse(gardenHealth.text) as unknown; } catch { gardenHealthBody = gardenHealth.text; }
  if (!gardenHealth.ok || record(gardenHealthBody)?.status !== 'ok') {
    fail(`Garden health failed (HTTP ${gardenHealth.status}).`);
  }
  const login = await requestGarden(context, '/login', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: secrets.ADMIN_TOKEN }),
  });
  const cookie = login.setCookie?.split(';', 1)[0];
  if (login.status !== 302 || !cookie?.includes('psfn_token=')) {
    fail(`Garden rejected the runtime Secret token (HTTP ${login.status}).`);
  }
  const dashboard = await requestGarden(context, '/', {
    headers: { Cookie: cookie },
    redirect: 'manual',
  });
  const body = dashboard.text;
  if (!dashboard.ok || !body.toLowerCase().includes('<!doctype html')) {
    fail(`Garden authenticated UI failed (HTTP ${dashboard.status}).`);
  }
  console.log('PASS: Helm release, Postgres, gateway, agent, and Garden are ready.');
  console.log('PASS: Gateway runtime subsystems and Garden authenticated UI are functional.');
  console.log(`Gateway: ${context.apiBase}`);
  console.log(`Garden:  ${context.gardenBase}/login`);
}

function rollout(context: HelmContext): void {
  for (const component of ['gateway', 'agent', 'garden']) {
    kubectl(context, ['rollout', 'restart', `deployment/${context.release}-${component}`]);
  }
  for (const component of ['gateway', 'agent', 'garden']) {
    kubectl(context, [
      'rollout', 'status', `deployment/${context.release}-${component}`,
      '--timeout', '10m',
    ]);
  }
}

function persistedTurnText(context: HelmContext, path: string): string {
  const result = kubectl(context, [
    'exec', `deployment/${context.release}-agent`, '-c', 'agent', '--',
    'node', '--input-type=module', '-e',
    "import {readFileSync} from 'node:fs'; process.stdout.write(readFileSync(process.argv[1], 'utf8'));",
    path,
  ], { capture: true });
  return result.stdout;
}

async function verify(context: HelmContext): Promise<void> {
  await doctor(context);
  const secrets = appSecrets(context);
  const proofId = randomUUID();
  const sessionId = `helm-verify-${proofId}`;
  const message = `PSFN Helm persistence proof ${proofId}. Reply with a brief acknowledgement.`;
  const response = await fetch(`${context.apiBase}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${secrets.API_KEY}`,
      'Content-Type': 'application/json',
      'X-Session-Id': sessionId,
    },
    body: JSON.stringify({
      model: 'companion',
      messages: [{ role: 'user', content: message }],
      response_style: 'concise',
      stream: false,
    }),
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
  });
  const rawBody = await response.text();
  let body: unknown;
  try { body = JSON.parse(rawBody); } catch { body = undefined; }
  const choices = record(body)?.choices;
  const first = Array.isArray(choices) ? record(choices[0]) : undefined;
  const assistant = record(first?.message)?.content;
  if (!response.ok || typeof assistant !== 'string' || !assistant.trim()) {
    fail(`Helm chat failed (HTTP ${response.status}): ${rawBody.slice(0, 300)}`);
  }
  const channelId = `api:${composeApiPrincipalId(secrets.API_KEY)}:${sessionId}`;
  const turnPath = `/runtime/companion-data/main/state/sessions/_turn_records/${encodeURIComponent(channelId)}.jsonl`;
  assertCompletedPersistedTurn(
    findMatchingPersistedTurnInText(persistedTurnText(context, turnPath), message),
    message,
    assistant.trim(),
  );
  console.log('PASS: real provider chat matches the canonical PVC-backed TurnRecord.');
  rollout(context);
  await startConnection(context);
  assertCompletedPersistedTurn(
    findMatchingPersistedTurnInText(persistedTurnText(context, turnPath), message),
    message,
    assistant.trim(),
  );
  await doctor(context);
  console.log('PASS: the same TurnRecord and authenticated surfaces survived a complete workload restart.');
}

function status(context: HelmContext): void {
  run('helm', [
    'status', context.release,
    '--kube-context', context.kubeContext,
    '--namespace', context.namespace,
  ]);
  kubectl(context, ['get', 'pods,pvc']);
  const connection = readConnection(context);
  console.log(`Local connection: ${connection && connectionProcessesReady(context, connection) ? 'running' : 'stopped'}`);
}

function logs(context: HelmContext): void {
  kubectl(context, [
    'logs',
    '-l', `app.kubernetes.io/instance=${context.release}`,
    '--all-containers=true',
    '--prefix=true',
    '--tail=200',
    '--follow',
  ]);
}

function scaleDown(context: HelmContext): void {
  stopConnection(context);
  kubectl(context, [
    'scale', 'deployment',
    '-l', `app.kubernetes.io/instance=${context.release}`,
    '--replicas=0',
  ]);
  kubectl(context, [
    'scale', 'statefulset',
    '-l', `app.kubernetes.io/instance=${context.release}`,
    '--replicas=0',
  ]);
  console.log('Stopped Kubernetes workloads. PVCs, owner files, memories, and Postgres data were preserved.');
}

function token(context: HelmContext): void {
  const value = existingSecret(context, context.appSecret)?.ADMIN_TOKEN;
  if (!value) fail('The runtime ADMIN_TOKEN is unavailable.');
  process.stdout.write(`${value}\n`);
}

function usage(): void {
  console.log(`Usage: npm run helm:<command>

Required environment:
  PSFN_KUBE_CONTEXT   exact kubectl context; never inferred
  <provider env>      the key named by generated providers.json

Commands:
  up          build/import or deploy the pinned image, then validate the complete release
  update      atomic upgrade of the current checkout; Helm rolls back a failed rollout
  status      show Helm, pod, PVC, and local connection state
  connect     reconcile native Garden ingress (local k3d) and expose the API on loopback
  disconnect  stop only supervised port-forwards; native Garden ingress remains available
  doctor      validate workloads, runtime health, and authenticated Garden UI
  verify      real provider chat + PVC TurnRecord + restart/recovery proof
  restart     restart gateway, agent, and Garden and wait for readiness
  logs        follow all release container logs
  token       print the Garden ADMIN_TOKEN on explicit request
  down        scale workloads to zero while preserving every persistent object`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || command === '-h' || command === '--help') {
    usage();
    return;
  }
  const context = loadHelmContext();
  switch (command) {
    case 'up':
    case 'update':
      deploy(context);
      // kubectl port-forward selects one backing pod when it starts. A healthy
      // pre-upgrade forward can therefore remain attached to a pod Helm is
      // terminating and disappear between startConnection() and doctor().
      // Replace supervised forwards after every deployment before validating it.
      stopConnection(context);
      await startConnection(context);
      reconcileGardenEdge(context, true);
      await doctor(context);
      console.log('The public Helm deployment is ready; helm:down preserves its data.');
      return;
    case 'status':
      status(context);
      return;
    case 'connect':
      await startConnection(context);
      reconcileGardenEdge(context, true);
      console.log(`Garden: ${context.gardenBase}/login`);
      console.log(`API:    ${context.apiBase}`);
      return;
    case 'disconnect':
      stopConnection(context);
      console.log('Stopped supervised Kubernetes port-forwards; cluster workloads and native Garden ingress remain running.');
      return;
    case 'doctor':
      await doctor(context);
      return;
    case 'verify':
      await verify(context);
      return;
    case 'restart':
      rollout(context);
      await startConnection(context);
      reconcileGardenEdge(context, true);
      await doctor(context);
      return;
    case 'logs':
      logs(context);
      return;
    case 'token':
      token(context);
      return;
    case 'down':
      scaleDown(context);
      return;
    default:
      usage();
      fail(`Unknown public Helm lifecycle command: ${command}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`public Helm lifecycle failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
