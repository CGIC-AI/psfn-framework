#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import {
  reverifyPersistedComposeTurn,
  runComposeChatVerification,
} from './compose-verification.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const COMPOSE_FILE = join(REPO_ROOT, 'docker', 'compose.yml');
const ENV_FILE = join(REPO_ROOT, '.env');
const REQUIRED_ENV = [
  'COMPANION_ID',
  'PSFN_POSTGRES_SUPERUSER_PASSWORD',
  'PSFN_COMPANION_DATABASE_PASSWORD',
  'PSFN_SHARED_MIGRATION_DATABASE_PASSWORD',
  'API_KEY',
  'ADMIN_TOKEN',
  'GATEWAY_SESSION_HMAC_KEY',
  'PSFN_BACKUP_ENCRYPTION_KEY',
  'PSFN_PROVIDER_API_KEY',
] as const;
const REQUIRED_SYSTEM_FILES = [
  'settings.json',
  'models.json',
  'providers.json',
  'companions.json',
];
const REQUIRED_COMPANION_FILES = [
  'companion.json',
  'scheduler.json',
  'capability-tier.json',
];
const REQUIRED_RUNNING_SERVICES = [
  'postgres',
  'operator-alert-sink',
  'gateway',
  'agent',
  'garden',
];
const HEALTHY_GATEWAY_SUBSYSTEMS = ['memory', 'embeddings', 'scheduler'];

interface LifecycleContext {
  env: NodeJS.ProcessEnv;
  dataRoot: string;
  apiBase: string;
  gardenBase: string;
}

function fail(message: string): never {
  throw new Error(message);
}

function loadContext(): LifecycleContext {
  if (!existsSync(ENV_FILE)) {
    fail(`Missing ${ENV_FILE}; run npm run onboard and choose Docker Compose.`);
  }
  const fileEnv = parseEnv(readFileSync(ENV_FILE, 'utf8'));
  // Match Docker Compose precedence: explicit process environment can override
  // local defaults without rewriting the persisted .env file.
  const env: NodeJS.ProcessEnv = { ...fileEnv, ...process.env };
  for (const name of REQUIRED_ENV) {
    if (!env[name]?.trim()) fail(`Missing ${name} in .env; rerun npm run onboard.`);
  }
  if (env.PSFN_IMAGE?.trim().endsWith(':latest')) {
    fail('PSFN_IMAGE must use an exact version tag or digest, never :latest.');
  }
  const requestedDataRoot = env.PSFN_DATA_ROOT?.trim() || 'data';
  const dataRoot = resolve(REPO_ROOT, requestedDataRoot);
  env.PSFN_DATA_ROOT = dataRoot;
  env.PSFN_HOST_UID = String(process.getuid?.() || 999);
  env.PSFN_HOST_GID = String(process.getgid?.() || 999);
  env.PSFN_GIT_COMMIT = gitHead();
  const apiPort = positivePort(env.PSFN_API_PORT, 10054, 'PSFN_API_PORT');
  const gardenPort = positivePort(env.PSFN_GARDEN_PORT, 10053, 'PSFN_GARDEN_PORT');
  return {
    env,
    dataRoot,
    apiBase: `http://127.0.0.1:${apiPort}`,
    gardenBase: `http://127.0.0.1:${gardenPort}`,
  };
}

function positivePort(raw: string | undefined, fallback: number, name: string): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    fail(`${name} must be an integer from 1 to 65535.`);
  }
  return value;
}

function gitHead(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? result.stdout.trim() : 'local-checkout';
}

function prepareHostDirectories(context: LifecycleContext): void {
  const companionId = context.env.COMPANION_ID!;
  for (const path of [
    join(context.dataRoot, 'workspaces', 'personal', companionId),
    join(context.dataRoot, 'logs'),
    join(context.dataRoot, 'tmp'),
    join(context.dataRoot, 'backups'),
    join(context.dataRoot, 'models'),
  ]) {
    mkdirSync(path, { recursive: true });
  }
  for (const [root, names] of [
    [join(context.dataRoot, 'system-data'), REQUIRED_SYSTEM_FILES],
    [join(context.dataRoot, 'companion-data', 'main'), REQUIRED_COMPANION_FILES],
  ] as const) {
    for (const name of names) {
      const path = join(root, name);
      if (!existsSync(path)) fail(`Missing ${path}; run npm run onboard and choose Docker Compose.`);
    }
  }
}

function compose(
  context: LifecycleContext,
  args: string[],
  options: { capture?: boolean; allowFailure?: boolean } = {},
) {
  const result = spawnSync(
    'docker',
    ['compose', '--env-file', ENV_FILE, '-f', COMPOSE_FILE, ...args],
    {
      cwd: REPO_ROOT,
      env: context.env,
      encoding: 'utf8',
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    },
  );
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    const detail = options.capture ? (result.stderr || result.stdout).trim() : '';
    fail(`docker compose ${args[0] ?? ''} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function validateCompose(context: LifecycleContext): void {
  prepareHostDirectories(context);
  compose(context, ['config', '--quiet']);
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { response, body };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function doctor(context: LifecycleContext): Promise<void> {
  validateCompose(context);
  const runningResult = compose(
    context,
    ['ps', '--services', '--status', 'running'],
    { capture: true },
  );
  const running = new Set(runningResult.stdout.split(/\r?\n/u).map(value => value.trim()).filter(Boolean));
  const missing = REQUIRED_RUNNING_SERVICES.filter(service => !running.has(service));
  if (missing.length > 0) fail(`Required Compose services are not running: ${missing.join(', ')}`);

  const gateway = await fetchJson(`${context.apiBase}/health`, {
    headers: { Authorization: `Bearer ${context.env.API_KEY}` },
  });
  const gatewayBody = record(gateway.body);
  const subsystems = record(gatewayBody?.subsystems);
  if (!subsystems) fail(`Gateway /health did not return subsystem status (HTTP ${gateway.response.status}).`);
  const unhealthy = HEALTHY_GATEWAY_SUBSYSTEMS.filter(name => record(subsystems[name])?.status !== 'healthy');
  if (unhealthy.length > 0) fail(`Gateway runtime is not ready: ${unhealthy.join(', ')}`);

  const gardenHealth = await fetchJson(`${context.gardenBase}/health`);
  if (!gardenHealth.response.ok || record(gardenHealth.body)?.status !== 'ok') {
    fail(`Garden /health is not ready (HTTP ${gardenHealth.response.status}).`);
  }
  const loginPage = await fetch(`${context.gardenBase}/login`, { signal: AbortSignal.timeout(10_000) });
  if (!loginPage.ok || !(await loginPage.text()).includes('name="token"')) {
    fail(`Garden login page is unavailable (HTTP ${loginPage.status}).`);
  }
  const login = await fetch(`${context.gardenBase}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: context.env.ADMIN_TOKEN! }),
    signal: AbortSignal.timeout(10_000),
  });
  if (login.status !== 302 || !login.headers.get('set-cookie')?.includes('psfn_token=')) {
    fail(`Garden rejected the configured ADMIN_TOKEN (HTTP ${login.status}).`);
  }
  const sessionCookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  const dashboard = await fetch(`${context.gardenBase}/`, {
    redirect: 'manual',
    headers: { Cookie: sessionCookie! },
    signal: AbortSignal.timeout(10_000),
  });
  const dashboardBody = await dashboard.text();
  if (!dashboard.ok || !dashboard.headers.get('content-type')?.includes('text/html')
    || !dashboardBody.toLowerCase().includes('<!doctype html')) {
    fail(`Garden authenticated UI is unavailable (HTTP ${dashboard.status}).`);
  }

  const database = compose(context, [
    'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'psfn', '-Atc',
    "SELECT (SELECT count(*) FROM pg_roles WHERE rolname IN ('companion_main_runtime','shared_schema_migration')) || ':' || (SELECT count(*) FROM pg_namespace WHERE nspname IN ('extensions','companion_main','shared'));",
  ], { capture: true });
  if (database.stdout.trim() !== '2:3') {
    fail('Postgres role/schema topology is incomplete.');
  }

  console.log('PASS: Postgres, gateway, agent, and Garden are running.');
  console.log('PASS: Gateway memory, embeddings, and scheduler subsystems are healthy.');
  console.log('PASS: Garden health, token login, and authenticated UI succeeded.');
  console.log(`Gateway: ${context.apiBase}`);
  console.log(`Garden:  ${context.gardenBase}/login`);
}

async function restartRuntime(context: LifecycleContext): Promise<void> {
  validateCompose(context);
  compose(context, ['restart', 'gateway', 'agent', 'garden']);
  compose(context, [
    'up', '-d', '--wait', '--wait-timeout', '300',
    'gateway', 'agent', 'garden',
  ]);
  await doctor(context);
}

async function verify(context: LifecycleContext): Promise<void> {
  await doctor(context);
  const result = await runComposeChatVerification({
    apiBase: context.apiBase,
    apiKey: context.env.API_KEY!,
    dataRoot: context.dataRoot,
  });
  console.log('PASS: a real provider-backed chat turn returned non-empty assistant content.');
  console.log('PASS: the exact user/assistant pair is present in the canonical TurnRecord journal.');
  await restartRuntime(context);
  reverifyPersistedComposeTurn(result);
  console.log('PASS: the same persisted turn survived a full runtime restart.');
}

function usage(): void {
  console.log(`Usage: npm run compose:<command>

Commands:
  up       build/update and start the persistent stack
  update   same safe, data-preserving convergence as up
  status   show container state
  doctor   validate services, database topology, gateway subsystems, and Garden login
  verify   run a real chat, prove persistence, restart, and prove recovery
  restart  restart gateway, agent, and Garden, then validate readiness
  logs     follow gateway, agent, and Garden logs
  down     stop containers; preserve owner files, workspace, memories, and Postgres data`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || command === '--help' || command === '-h') {
    usage();
    return;
  }
  const context = loadContext();
  switch (command) {
    case 'up':
    case 'update':
      validateCompose(context);
      compose(context, ['up', '-d', '--build', '--wait', '--wait-timeout', '900']);
      await doctor(context);
      console.log('The persistent stack is ready. compose:down will not delete its data.');
      return;
    case 'status':
      validateCompose(context);
      compose(context, ['ps']);
      return;
    case 'doctor':
      await doctor(context);
      return;
    case 'verify':
      await verify(context);
      return;
    case 'restart':
      await restartRuntime(context);
      return;
    case 'logs':
      validateCompose(context);
      compose(context, ['logs', '--follow', '--tail', '200', 'gateway', 'agent', 'garden']);
      return;
    case 'down':
      validateCompose(context);
      compose(context, ['down']);
      console.log('Stopped. Persistent data and the Postgres volume were preserved.');
      return;
    default:
      usage();
      fail(`Unknown Compose lifecycle command: ${command}`);
  }
}

main().catch((error) => {
  console.error(`compose lifecycle failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
