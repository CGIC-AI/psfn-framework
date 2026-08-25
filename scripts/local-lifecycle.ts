#!/usr/bin/env node

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
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
import pg from 'pg';
import {
  reverifyPersistedComposeTurn,
  runDeploymentChatVerification,
} from './compose-verification.js';

const { Pool } = pg;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const DIST_DIR = join(REPO_ROOT, 'dist');
const REQUIRED_ENV = [
  'COMPANION_ID',
  'PSFN_RUNTIME_ROOT',
  'SYSTEM_DATA_DIR',
  'COMPANION_DATA_DIR',
  'WORKSPACE_PATH',
  'CHARACTER_CARD_PATH',
  'PSFN_LOGS_DIR',
  'PSFN_TEMP_DIR',
  'BACKUP_ROOT_DIR',
  'PSFN_AGENT_AUTH_DIR',
  'GATEWAY_SOCKET',
  'ADMIN_TRANSPORT_SOCKET',
  'POSTGRES_ADMIN_DATABASE_URL',
  'POSTGRES_DATABASE_URL',
  'COMPANION_MAIN_DATABASE_URL',
  'SHARED_SCHEMA_MIGRATION_DATABASE_URL',
  'PSFN_COMPANION_DATABASE_PASSWORD',
  'PSFN_SHARED_MIGRATION_DATABASE_PASSWORD',
  'API_KEY',
  'ADMIN_TOKEN',
  'GATEWAY_SESSION_HMAC_KEY',
  'PSFN_BACKUP_ENCRYPTION_KEY',
] as const;
const REQUIRED_SYSTEM_FILES = ['settings.json', 'models.json', 'providers.json', 'companions.json'];
const REQUIRED_COMPANION_FILES = ['companion.json', 'scheduler.json', 'capability-tier.json'];
const HEALTHY_GATEWAY_SUBSYSTEMS = ['memory', 'embeddings', 'scheduler'];
const START_TIMEOUT_MS = 600_000;
const STOP_TIMEOUT_MS = 30_000;

interface LocalContext {
  env: NodeJS.ProcessEnv;
  runtimeRoot: string;
  systemDataDir: string;
  companionDataDir: string;
  statePath: string;
  releasePath: string;
  logPath: string;
  apiBase: string;
  gardenBase: string;
  alertBase: string;
}

interface ComponentState {
  name: string;
  pid: number;
}

interface RuntimeState {
  repoRoot: string;
  supervisorPid: number;
  status: 'starting' | 'running' | 'failed' | 'stopped';
  startedAt: string;
  gitHead: string;
  components: ComponentState[];
  error?: string;
}

interface ReleaseState {
  lastGoodBuildDir: string;
  recordedAt: string;
  gitHead: string;
}

function fail(message: string): never {
  throw new Error(message);
}

function positivePort(raw: string | undefined, fallback: number, name: string): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    fail(`${name} must be an integer from 1 to 65535.`);
  }
  return value;
}

export function loadLocalContext(
  repoRoot = REPO_ROOT,
  processEnvironment: NodeJS.ProcessEnv = process.env,
): LocalContext {
  const envFile = join(repoRoot, '.env');
  if (!existsSync(envFile)) {
    fail(`Missing ${envFile}; run npm run onboard and choose Repository-native.`);
  }
  const fileEnv = parseEnv(readFileSync(envFile, 'utf8'));
  const env: NodeJS.ProcessEnv = { ...fileEnv, ...processEnvironment };
  for (const name of REQUIRED_ENV) {
    if (!env[name]?.trim()) fail(`Missing ${name} in .env; rerun npm run onboard.`);
  }
  const runtimeRoot = resolve(repoRoot, env.PSFN_RUNTIME_ROOT!);
  const systemDataDir = resolve(repoRoot, env.SYSTEM_DATA_DIR!);
  const companionDataDir = resolve(repoRoot, env.COMPANION_DATA_DIR!);
  const logsDir = resolve(repoRoot, env.PSFN_LOGS_DIR!);
  const tempDir = resolve(repoRoot, env.PSFN_TEMP_DIR!);
  env.PSFN_RUNTIME_ROOT = runtimeRoot;
  env.SYSTEM_DATA_DIR = systemDataDir;
  env.COMPANION_DATA_DIR = companionDataDir;
  env.WORKSPACE_PATH = resolve(repoRoot, env.WORKSPACE_PATH!);
  env.CHARACTER_CARD_PATH = resolve(repoRoot, env.CHARACTER_CARD_PATH!);
  env.PSFN_LOGS_DIR = logsDir;
  env.PSFN_TEMP_DIR = tempDir;
  env.BACKUP_ROOT_DIR = resolve(repoRoot, env.BACKUP_ROOT_DIR!);
  env.PSFN_AGENT_AUTH_DIR = resolve(repoRoot, env.PSFN_AGENT_AUTH_DIR!);
  env.GATEWAY_SOCKET = resolve(repoRoot, env.GATEWAY_SOCKET!);
  env.ADMIN_TRANSPORT_SOCKET = resolve(repoRoot, env.ADMIN_TRANSPORT_SOCKET!);
  env.CONFIG_DIR ||= join(repoRoot, 'config');
  env.NODE_ENV = 'production';
  env.PSFN_RUNTIME_MODE ||= 'gateway-agent';
  env.PSFN_RUNTIME_LAYOUT_MODE ||= 'production';
  env.PERSISTENCE_BACKEND ||= 'postgres';
  env.COMPANION_PG_SCHEMA ||= 'companion_main';
  env.API_HOST ||= '127.0.0.1';
  env.ADMIN_HOST ||= '127.0.0.1';
  env.ADMIN_TRANSPORT_MODE ||= 'socket';
  env.ALLOW_AGENT_OUTBOUND_NETWORK ||= 'true';
  env.PSFN_RUNTIME_UID = String(process.getuid?.() ?? 1);
  env.PSFN_RUNTIME_GID = String(process.getgid?.() ?? 1);
  env.PSFN_COMPANION_DATABASE_CONNECTION_LIMIT ||= '80';
  const apiPort = positivePort(env.API_PORT, 10054, 'API_PORT');
  const gardenPort = positivePort(env.ADMIN_PORT, 10053, 'ADMIN_PORT');
  const alertPort = positivePort(env.PSFN_LOCAL_ALERT_PORT, 10055, 'PSFN_LOCAL_ALERT_PORT');
  env.API_PORT = String(apiPort);
  env.ADMIN_PORT = String(gardenPort);
  env.PSFN_LOCAL_ALERT_PORT = String(alertPort);
  env.NTFY_BASE_URL ||= `http://127.0.0.1:${alertPort}`;
  env.NTFY_TOPIC ||= 'local-operator-alerts';
  for (const directory of [
    runtimeRoot,
    logsDir,
    tempDir,
    env.BACKUP_ROOT_DIR,
    env.WORKSPACE_PATH,
    dirname(env.GATEWAY_SOCKET),
    env.PSFN_AGENT_AUTH_DIR,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  return {
    env,
    runtimeRoot,
    systemDataDir,
    companionDataDir,
    statePath: join(tempDir, 'local-lifecycle.json'),
    releasePath: join(tempDir, 'local-release.json'),
    logPath: join(logsDir, 'local-runtime.log'),
    apiBase: `http://127.0.0.1:${apiPort}`,
    gardenBase: `http://127.0.0.1:${gardenPort}`,
    alertBase: `http://127.0.0.1:${alertPort}`,
  };
}

function requireRegularFiles(root: string, names: readonly string[]): void {
  for (const name of names) {
    const path = join(root, name);
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      fail(`Required generated configuration is missing: ${path}; run npm run onboard.`);
    }
  }
}

function validateLayout(context: LocalContext): void {
  requireRegularFiles(context.systemDataDir, REQUIRED_SYSTEM_FILES);
  requireRegularFiles(context.companionDataDir, REQUIRED_COMPANION_FILES);
}

function writeJson(path: string, value: unknown): void {
  const nextPath = `${path}.next`;
  writeFileSync(nextPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(nextPath, path);
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

function gitHead(): string {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.status === 0 ? result.stdout.trim() : 'local-checkout';
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function activeState(context: LocalContext): RuntimeState | undefined {
  const state = readJson<RuntimeState>(context.statePath);
  if (!state || state.repoRoot !== REPO_ROOT || !isProcessAlive(state.supervisorPid)) return undefined;
  return state;
}

export function parseAgentAuthFile(text: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = /^export ([A-Z][A-Z0-9_]*)=([A-Za-z0-9._~+-]+)$/u.exec(line);
    if (!match) fail('Agent credential handoff contains an invalid line');
    output[match[1]!] = match[2]!;
  }
  for (const name of [
    'GATEWAY_COMPANION_AUTH_TOKEN',
    'GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN',
    'PSFN_BACKUP_ENCRYPTION_KEY',
  ]) {
    if (!output[name]) fail(`Agent credential handoff is missing ${name}`);
  }
  return output;
}

function runtimeEnvironment(context: LocalContext): NodeJS.ProcessEnv {
  const names = [
    'NODE_ENV', 'TZ', 'PSFN_RUNTIME_MODE', 'PSFN_RUNTIME_LAYOUT_MODE', 'PSFN_RUNTIME_ROOT',
    'SYSTEM_DATA_DIR', 'COMPANION_DATA_DIR', 'WORKSPACE_PATH', 'PSFN_LOGS_DIR', 'PSFN_TEMP_DIR',
    'BACKUP_ROOT_DIR', 'CONFIG_DIR', 'PERSISTENCE_BACKEND', 'COMPANION_ID', 'COMPANION_PG_SCHEMA',
    'CHARACTER_CARD_PATH', 'GATEWAY_SOCKET', 'ADMIN_TRANSPORT_MODE', 'ADMIN_TRANSPORT_SOCKET',
    'NTFY_BASE_URL', 'NTFY_TOPIC', 'ALLOW_AGENT_OUTBOUND_NETWORK',
  ];
  return Object.fromEntries(names.flatMap(name => (
    context.env[name] === undefined ? [] : [[name, context.env[name]!]]
  )));
}

function agentEnvironment(context: LocalContext): NodeJS.ProcessEnv {
  const authPath = join(context.env.PSFN_AGENT_AUTH_DIR!, 'agent-auth.env');
  const databasePath = join(context.env.PSFN_AGENT_AUTH_DIR!, 'postgres-database-url');
  if (!existsSync(authPath) || !existsSync(databasePath)) {
    fail('Role-bound agent credentials are missing; local bootstrap did not complete.');
  }
  return {
    ...runtimeEnvironment(context),
    ...parseAgentAuthFile(readFileSync(authPath, 'utf8')),
    POSTGRES_DATABASE_URL_FILE: databasePath,
  };
}

function gardenEnvironment(context: LocalContext): NodeJS.ProcessEnv {
  return {
    ...runtimeEnvironment(context),
    POSTGRES_DATABASE_URL: context.env.POSTGRES_DATABASE_URL,
    ADMIN_HOST: context.env.ADMIN_HOST,
    ADMIN_PORT: context.env.ADMIN_PORT,
    ADMIN_TOKEN: context.env.ADMIN_TOKEN,
  };
}

function gatewayEnvironment(context: LocalContext): NodeJS.ProcessEnv {
  const env = { ...context.env };
  delete env.POSTGRES_ADMIN_DATABASE_URL;
  delete env.PSFN_COMPANION_DATABASE_PASSWORD;
  delete env.PSFN_SHARED_MIGRATION_DATABASE_PASSWORD;
  return env;
}

function runChecked(command: string, args: string[], env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, { cwd: REPO_ROOT, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed with exit ${result.status ?? 'unknown'}`);
}

function bootstrap(context: LocalContext): void {
  validateLayout(context);
  runChecked(process.execPath, [join(REPO_ROOT, 'scripts/ops/psfn-compose-bootstrap.mjs')], context.env);
}

function ensureBuild(context: LocalContext): void {
  const required = ['gateway-main.js', 'agent-main.js', 'operator-main.js'];
  if (required.every(name => existsSync(join(DIST_DIR, name)))) return;
  runChecked('npm', ['run', 'build:runtime'], context.env);
}

function ensureGardenBuild(context: LocalContext): void {
  if (existsSync(join(REPO_ROOT, 'admin-ui', 'build', 'index.html'))) return;
  console.log('Building the Garden web UI (first start only)...');
  runChecked('npm', ['run', 'garden:build'], context.env);
}

function modelAssetsReady(): boolean {
  const injectionModel = join(REPO_ROOT, 'models', 'prompt-injection-v2', 'onnx', 'model.onnx');
  const emotionModel = join(REPO_ROOT, 'models', 'transformers', 'SamLowe', 'roberta-base-go_emotions-onnx', 'onnx', 'model.onnx');
  const embeddingModel = join(REPO_ROOT, 'models', 'transformers', 'Xenova', 'all-MiniLM-L6-v2', 'onnx', 'model.onnx');
  return [injectionModel, emotionModel, embeddingModel].every(path => existsSync(path));
}

function prepareModels(context: LocalContext): void {
  if (modelAssetsReady()) return;
  console.log('Preparing pinned local model assets (first start only)...');
  runChecked(process.execPath, [join(REPO_ROOT, 'scripts/ops/psfn-compose-smoke-prefetch.mjs')], {
    ...context.env,
    PSFN_SMOKE_MODEL_CACHE_DIR: join(REPO_ROOT, 'models', 'transformers'),
    PSFN_SMOKE_MODEL_PREFETCH_OFFLINE: context.env.PSFN_LOCAL_MODEL_PREFETCH_OFFLINE ?? '0',
    PSFN_SMOKE_TEXT_EMOTION_MODEL_REVISION: '90ee0c1c4796d370e68968687b8ba51fc11224f4',
    PSFN_SMOKE_EMBEDDING_MODEL_REVISION: '751bff37182d3f1213fa05d7196b954e230abad9',
    PSFN_SMOKE_INJECTION_MODEL_DIR: join(REPO_ROOT, 'models', 'prompt-injection-v2'),
    PSFN_SMOKE_INJECTION_PROVISION_SCRIPT: join(DIST_DIR, 'provision-injection-model.js'),
  });
}

async function assertPortAvailable(port: number, name: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`${name} port ${port} is already occupied`)));
    server.listen(port, '127.0.0.1', () => server.close(() => resolvePromise()));
  });
}

async function preflightPorts(context: LocalContext): Promise<void> {
  await assertPortAvailable(Number(context.env.API_PORT), 'Gateway');
  await assertPortAvailable(Number(context.env.ADMIN_PORT), 'Garden');
  await assertPortAvailable(Number(context.env.PSFN_LOCAL_ALERT_PORT), 'Local alert sink');
}

function removeStaleSocket(path: string): void {
  if (!existsSync(path)) return;
  const stats = lstatSync(path);
  if (!stats.isSocket()) fail(`Refusing to replace non-socket runtime path: ${path}`);
  unlinkSync(path);
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

async function doctor(context: LocalContext, quiet = false): Promise<void> {
  validateLayout(context);
  const state = activeState(context);
  if (!state || state.status === 'failed' || state.status === 'stopped') {
    fail(`Repository-native runtime is not running. Inspect ${context.logPath}.`);
  }
  const dead = state.components.filter(component => !isProcessAlive(component.pid));
  if (dead.length > 0) fail(`Runtime components exited: ${dead.map(item => item.name).join(', ')}`);

  const gateway = await fetchJson(`${context.apiBase}/health`, {
    headers: { Authorization: `Bearer ${context.env.API_KEY}` },
  });
  const subsystems = record(record(gateway.body)?.subsystems);
  if (!gateway.response.ok || !subsystems) {
    fail(`Gateway /health is not ready (HTTP ${gateway.response.status}).`);
  }
  const unhealthy = HEALTHY_GATEWAY_SUBSYSTEMS.filter(name => record(subsystems[name])?.status !== 'healthy');
  if (unhealthy.length > 0) fail(`Gateway runtime is not ready: ${unhealthy.join(', ')}`);

  const alert = await fetch(`${context.alertBase}/health`, { signal: AbortSignal.timeout(10_000) });
  if (!alert.ok) fail(`Local alert sink is not ready (HTTP ${alert.status}).`);
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

  const pool = new Pool({
    connectionString: context.env.POSTGRES_ADMIN_DATABASE_URL,
    application_name: 'psfn-local-doctor',
    max: 1,
  });
  try {
    const database = await pool.query(
      "SELECT (SELECT count(*)::int FROM pg_roles WHERE rolname IN ('companion_main_runtime','shared_schema_migration')) AS roles, "
      + "(SELECT count(*)::int FROM pg_namespace WHERE nspname IN ('extensions','companion_main','shared')) AS schemas",
    );
    if (database.rows[0]?.roles !== 2 || database.rows[0]?.schemas !== 3) {
      fail('Postgres role/schema topology is incomplete.');
    }
  } finally {
    await pool.end();
  }
  if (!quiet) {
    console.log('PASS: supervised gateway, agent, Garden, alert sink, and Postgres are healthy.');
    console.log('PASS: Garden login challenge and authenticated UI both succeeded.');
    console.log(`Gateway: ${context.apiBase}`);
    console.log(`Garden:  ${context.gardenBase}/login`);
  }
}

function componentCommand(
  name: string,
  path: string,
  env: NodeJS.ProcessEnv,
): { name: string; command: string; args: string[]; env: NodeJS.ProcessEnv } {
  return { name, command: process.execPath, args: [path], env };
}

async function waitForGateway(context: LocalContext, children: readonly ChildProcess[]): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  do {
    if (children.some(child => child.exitCode !== null)) fail('A runtime component exited during startup');
    try {
      const response = await fetch(`${context.apiBase}/health`, { signal: AbortSignal.timeout(2_000) });
      if (response.status < 500) return;
    } catch { /* startup polling */ }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
  } while (Date.now() <= deadline);
  fail('Gateway did not open its health surface before the startup timeout');
}

async function supervise(context: LocalContext): Promise<void> {
  let stopping = false;
  const children: ChildProcess[] = [];
  const state: RuntimeState = {
    repoRoot: REPO_ROOT,
    supervisorPid: process.pid,
    status: 'starting',
    startedAt: new Date().toISOString(),
    gitHead: gitHead(),
    components: [],
  };
  writeJson(context.statePath, state);

  const stopChildren = async (): Promise<void> => {
    stopping = true;
    for (const child of [...children].reverse()) {
      if (child.exitCode === null && child.pid) child.kill('SIGTERM');
    }
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (children.some(child => child.exitCode === null) && Date.now() <= deadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
    }
    for (const child of children) {
      if (child.exitCode === null && child.pid) child.kill('SIGKILL');
    }
  };
  const terminate = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    void stopChildren().finally(() => {
      state.status = 'stopped';
      writeJson(context.statePath, state);
      process.exit(signal === 'SIGINT' ? 130 : 0);
    });
  };
  process.once('SIGINT', () => terminate('SIGINT'));
  process.once('SIGTERM', () => terminate('SIGTERM'));

  const start = (spec: ReturnType<typeof componentCommand>): ChildProcess => {
    const child = spawn(spec.command, spec.args, {
      cwd: REPO_ROOT,
      env: spec.env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    children.push(child);
    if (!child.pid) fail(`Failed to start ${spec.name}`);
    state.components.push({ name: spec.name, pid: child.pid });
    writeJson(context.statePath, state);
    child.once('exit', (code, signal) => {
      if (stopping) return;
      state.status = 'failed';
      state.error = `${spec.name} exited unexpectedly (${signal ?? code ?? 'unknown'})`;
      writeJson(context.statePath, state);
      void stopChildren().finally(() => process.exit(1));
    });
    return child;
  };

  const alertEnv = {
    PATH: context.env.PATH,
    PSFN_SMOKE_OPERATOR_ALERT_HOST: '127.0.0.1',
    PSFN_SMOKE_OPERATOR_ALERT_PORT: context.env.PSFN_LOCAL_ALERT_PORT,
    PSFN_SMOKE_OPERATOR_ALERT_TOPIC: context.env.NTFY_TOPIC,
  };
  start(componentCommand(
    'operator-alert-sink',
    join(REPO_ROOT, 'scripts/ops/psfn-compose-smoke-operator-alert-sink.mjs'),
    alertEnv,
  ));
  start(componentCommand('gateway', join(DIST_DIR, 'gateway-main.js'), gatewayEnvironment(context)));
  await waitForGateway(context, children);
  start(componentCommand('agent', join(DIST_DIR, 'agent-main.js'), agentEnvironment(context)));
  start(componentCommand('garden', join(DIST_DIR, 'operator-main.js'), gardenEnvironment(context)));
  state.status = 'running';
  writeJson(context.statePath, state);
  await new Promise<void>(() => undefined);
}

async function startRuntime(context: LocalContext): Promise<void> {
  const existing = activeState(context);
  if (existing) {
    await doctor(context);
    console.log(`Repository-native runtime is already supervised by PID ${existing.supervisorPid}.`);
    return;
  }
  await preflightPorts(context);
  removeStaleSocket(context.env.GATEWAY_SOCKET!);
  removeStaleSocket(context.env.ADMIN_TRANSPORT_SOCKET!);
  bootstrap(context);
  ensureBuild(context);
  ensureGardenBuild(context);
  prepareModels(context);
  if (existsSync(context.statePath)) unlinkSync(context.statePath);
  const logFd = openSync(context.logPath, 'a');
  const child = spawn(process.execPath, ['--import', 'tsx', SCRIPT_PATH, 'supervise'], {
    cwd: REPO_ROOT,
    env: context.env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  closeSync(logFd);
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError: unknown;
  do {
    const state = readJson<RuntimeState>(context.statePath);
    if (state?.status === 'failed') fail(state.error ?? 'Runtime supervisor reported startup failure');
    if (state?.status === 'running') {
      try {
        await doctor(context);
        console.log(`Logs:    ${context.logPath}`);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000));
  } while (Date.now() <= deadline);
  if (child.pid && isProcessAlive(child.pid)) process.kill(child.pid, 'SIGTERM');
  fail(`Repository-native runtime did not become ready: ${lastError instanceof Error ? lastError.message : 'startup timeout'}`);
}

async function stopRuntime(context: LocalContext, quiet = false): Promise<void> {
  const state = activeState(context);
  if (!state) {
    if (!quiet) console.log('Repository-native runtime is already stopped; persistent data was preserved.');
    return;
  }
  process.kill(state.supervisorPid, 'SIGTERM');
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (isProcessAlive(state.supervisorPid) && Date.now() <= deadline) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  if (isProcessAlive(state.supervisorPid)) {
    fail(`Supervisor PID ${state.supervisorPid} did not stop; inspect ${context.logPath}.`);
  }
  if (!quiet) console.log('Stopped. Owner files, workspace, memories, and PostgreSQL data were preserved.');
}

async function restartRuntime(context: LocalContext): Promise<void> {
  await stopRuntime(context, true);
  await startRuntime(context);
}

async function verify(context: LocalContext): Promise<void> {
  await doctor(context);
  const result = await runDeploymentChatVerification({
    apiBase: context.apiBase,
    apiKey: context.env.API_KEY!,
    companionDataDir: context.companionDataDir,
    proofLabel: 'repository-native',
  });
  console.log('PASS: a real provider-backed chat returned non-empty assistant content.');
  console.log('PASS: the exact user/assistant pair is present in the canonical TurnRecord journal.');
  await restartRuntime(context);
  reverifyPersistedComposeTurn(result);
  console.log('PASS: the same persisted turn survived a full supervised runtime restart.');
}

function backupBuild(context: LocalContext): string {
  if (!existsSync(DIST_DIR)) fail('No current runtime build exists to protect before update.');
  const backupDir = join(context.env.PSFN_TEMP_DIR!, `local-dist-good-${Date.now()}`);
  cpSync(DIST_DIR, backupDir, { recursive: true, errorOnExist: true });
  return backupDir;
}

function preserveFailedBuild(context: LocalContext, label: string): string | undefined {
  if (!existsSync(DIST_DIR)) return undefined;
  const failedDir = join(context.env.PSFN_TEMP_DIR!, `local-dist-${label}-${Date.now()}`);
  renameSync(DIST_DIR, failedDir);
  return failedDir;
}

function restoreBuild(backupDir: string): void {
  if (!existsSync(backupDir)) fail(`Last-good runtime build is missing: ${backupDir}`);
  cpSync(backupDir, DIST_DIR, { recursive: true, errorOnExist: true });
}

async function updateRuntime(context: LocalContext): Promise<void> {
  await doctor(context);
  const backupDir = backupBuild(context);
  try {
    runChecked('npm', ['run', 'build:runtime'], context.env);
    await restartRuntime(context);
    writeJson(context.releasePath, {
      lastGoodBuildDir: backupDir,
      recordedAt: new Date().toISOString(),
      gitHead: gitHead(),
    } satisfies ReleaseState);
    console.log('Update deployed from the current checkout; the previous build remains available to local:recover.');
  } catch (error) {
    await stopRuntime(context, true);
    const failedDir = preserveFailedBuild(context, 'failed-update');
    restoreBuild(backupDir);
    await startRuntime(context);
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Update failed and the previous runtime was restored${failedDir ? `; failed build retained at ${failedDir}` : ''}: ${detail}`);
  }
}

async function recoverRuntime(context: LocalContext): Promise<void> {
  const release = readJson<ReleaseState>(context.releasePath);
  if (!release?.lastGoodBuildDir) fail('No last-good runtime build has been recorded by local:update.');
  await stopRuntime(context, true);
  const failedDir = preserveFailedBuild(context, 'recovery-replaced');
  restoreBuild(release.lastGoodBuildDir);
  try {
    await startRuntime(context);
  } catch (error) {
    fail(`Last-good build recovery failed; replaced build is retained at ${failedDir ?? 'no path'}: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(`Recovered the last-good build recorded at ${release.recordedAt}.`);
}

function status(context: LocalContext): void {
  const state = readJson<RuntimeState>(context.statePath);
  if (!state) {
    console.log('Repository-native runtime: never started');
    return;
  }
  const supervisor = isProcessAlive(state.supervisorPid) ? 'alive' : 'not running';
  console.log(`Repository-native runtime: ${state.status} (supervisor ${state.supervisorPid}, ${supervisor})`);
  for (const component of state.components) {
    console.log(`  ${component.name}: PID ${component.pid} (${isProcessAlive(component.pid) ? 'alive' : 'not running'})`);
  }
  if (state.error) console.log(`  failure: ${state.error}`);
  console.log(`  logs: ${context.logPath}`);
}

function logs(context: LocalContext): void {
  if (!existsSync(context.logPath)) fail(`No runtime log exists yet at ${context.logPath}.`);
  const result = spawnSync('tail', ['-n', '200', '-f', context.logPath], { stdio: 'inherit' });
  if (result.error) throw result.error;
}

function usage(): void {
  console.log(`Usage: npm run local:<command>

Commands:
  up       provision/validate PostgreSQL, build if needed, and start the supervised runtime
  status   show supervisor and component process state
  doctor   validate processes, database topology, gateway subsystems, and Garden login
  verify   run a real chat, prove persistence, restart, and prove recovery
  restart  restart the complete runtime and validate readiness
  update   build the current checkout, deploy it, and automatically roll back on failure
  recover  restore the last-good build retained by local:update
  logs     follow the consolidated runtime log
  down     stop all components while preserving every persistent root`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || command === '--help' || command === '-h') {
    usage();
    return;
  }
  const context = loadLocalContext();
  switch (command) {
    case 'supervise':
      await supervise(context);
      return;
    case 'up':
      await startRuntime(context);
      return;
    case 'status':
      status(context);
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
    case 'update':
      await updateRuntime(context);
      return;
    case 'recover':
      await recoverRuntime(context);
      return;
    case 'logs':
      logs(context);
      return;
    case 'down':
      await stopRuntime(context);
      return;
    default:
      usage();
      fail(`Unknown repository-native lifecycle command: ${command}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`repository-native lifecycle failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
