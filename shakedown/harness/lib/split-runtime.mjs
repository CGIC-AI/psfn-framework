import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveCompanionAuthToken } from '../../../src/boundary/gateway/companion-auth.js';
import { requireGatewaySessionHmacKeyring } from '../../../src/boundary/gateway/session-hmac-env.js';

// Match the production role boundary: only the gateway receives ambient
// provider credentials. The agent receives role proofs and a file-owned DB URL.
const RUNTIME_ENV = [
  'PATH', 'TZ', 'NODE_ENV', 'CONFIG_DIR', 'PSFN_RUNTIME_MODE', 'PSFN_RUNTIME_LAYOUT_MODE',
  'PSFN_RUNTIME_ROOT', 'SYSTEM_DATA_DIR', 'COMPANION_DATA_DIR', 'WORKSPACE_PATH',
  'PSFN_LOGS_DIR', 'PSFN_TEMP_DIR', 'BACKUP_ROOT_DIR', 'CHARACTER_CARD_PATH',
  'COMPANION_ID', 'COMPANION_PG_SCHEMA', 'PERSISTENCE_BACKEND', 'LOG_LEVEL',
  'GATEWAY_SOCKET', 'ADMIN_TRANSPORT_MODE', 'ADMIN_TRANSPORT_SOCKET',
  'ALLOW_AGENT_OUTBOUND_NETWORK', 'PSFN_TESTING_HARNESS_DEVICES',
  'PSFN_TESTING_HARNESS_GARDEN_VERIFIER', 'NTFY_BASE_URL', 'NTFY_TOPIC',
];

export function prepareSplitRuntime(config, env) {
  const apiKey = env.API_KEY?.trim();
  if (!apiKey) throw new Error('API_KEY is required for authenticated shakedown health checks');
  if (!env.PSFN_BACKUP_ENCRYPTION_KEY?.trim()) {
    throw new Error('PSFN_BACKUP_ENCRYPTION_KEY is required for isolated shakedown persistence');
  }
  const keyring = requireGatewaySessionHmacKeyring(env);
  mkdirSync(config.tempDir, { recursive: true });
  const credentialDir = mkdtempSync(join(config.tempDir, 'shakedown-credentials-'));
  const databasePath = join(credentialDir, 'postgres-database-url');
  try {
    writeFileSync(databasePath, config.postgresUrl, { mode: 0o600, flag: 'wx' });
    const runtimeEnv = Object.fromEntries(RUNTIME_ENV.flatMap(name => env[name] === undefined ? [] : [[name, env[name]]]));
    const agentEnv = {
      ...runtimeEnv,
      POSTGRES_DATABASE_URL_FILE: databasePath,
      PSFN_BACKUP_ENCRYPTION_KEY: env.PSFN_BACKUP_ENCRYPTION_KEY,
      GATEWAY_COMPANION_AUTH_TOKEN: deriveCompanionAuthToken(config.companionId, 'agent', keyring),
      GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN: deriveCompanionAuthToken(config.companionId, 'internal_session_integrity', keyring),
    };
    const operatorEnv = {
      ...runtimeEnv,
      POSTGRES_DATABASE_URL: config.postgresUrl,
      ADMIN_HOST: env.ADMIN_HOST,
      ADMIN_PORT: env.ADMIN_PORT,
      ADMIN_TOKEN: env.ADMIN_TOKEN,
      GATEWAY_OPERATOR_API_BASE_URL: `${config.apiBase}/v1`,
    };
    const gatewayEnv = { ...env };
    for (const name of ['POSTGRES_ADMIN_DATABASE_URL', 'PSFN_COMPANION_DATABASE_PASSWORD', 'PSFN_SHARED_MIGRATION_DATABASE_PASSWORD', 'PSFN_LIVE_POSTGRES_DATABASE_URL']) {
      delete gatewayEnv[name];
    }
    return {
      processes: [
        {
          name: 'gateway', args: [join(config.repoRoot, 'dist/gateway-main.js')], env: gatewayEnv,
          readyUrl: `${config.apiBase}/health`, readyHeaders: { Authorization: `Bearer ${apiKey}` },
        },
        { name: 'agent', args: [join(config.repoRoot, 'dist/agent-main.js')], env: agentEnv },
        { name: 'operator', args: [join(config.repoRoot, 'dist/operator-main.js')], env: operatorEnv },
      ],
      cleanup: () => rmSync(credentialDir, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(credentialDir, { recursive: true, force: true });
    throw error;
  }
}

// The supervisor owns exactly the children it starts. It never discovers and
// kills unrelated processes by port, command substring, or a reused PID file.
export async function superviseSplitRuntime({ processes, cwd, signals = process }) {
  const children = [];
  const startupAbort = new AbortController();
  const exits = [];
  let finish;
  const completion = new Promise(resolve => { finish = resolve; });
  const onSignal = () => { finish(0); startupAbort.abort(); };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) signals.once(signal, onSignal);
  try {
    for (const spec of processes) {
      const child = spawn(process.execPath, spec.args, { cwd, env: spec.env, stdio: 'inherit' });
      children.push(child);
      exits.push(new Promise(resolve => {
        child.once('error', error => {
          console.error(`${spec.name} failed to start: ${error.message}`);
          finish(1); startupAbort.abort(); resolve();
        });
        child.once('exit', (code, signal) => {
          if (!startupAbort.signal.aborted) console.error(`${spec.name} exited unexpectedly (code=${code}, signal=${signal})`);
          finish(1); startupAbort.abort(); resolve();
        });
      }));
      if (spec.readyUrl) {
        const deadline = Date.now() + 90_000;
        let ready = false;
        while (!startupAbort.signal.aborted && Date.now() < deadline) {
          try {
            const response = await fetch(spec.readyUrl, {
              headers: spec.readyHeaders,
              signal: AbortSignal.any([startupAbort.signal, AbortSignal.timeout(1_000)]),
            });
            const health = await response.json();
            // ApiServer returns 503 for GatewayApiRuntime's disconnected-agent
            // health. That exact startup state permits launching the agent;
            // unrelated HTTP errors or other degraded states do not.
            const hasHealthEnvelope = typeof health?.checkedAt === 'string'
              && Number.isFinite(health?.uptimeSeconds)
              && ['healthy', 'degraded'].includes(health?.subsystems?.memory?.status);
            const healthy = response.status === 200 && health?.status === 'healthy';
            const waitingForAgent = response.status === 503 && health?.status === 'degraded'
              && health?.continuity?.checks?.gatewayLink?.meta?.agentConnected === false;
            if (hasHealthEnvelope && (healthy || waitingForAgent)) { ready = true; break; }
          } catch (error) {
            if (startupAbort.signal.aborted) break;
            if (!(error instanceof Error)) throw error;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!ready) {
          if (startupAbort.signal.aborted) return await completion;
          throw new Error(`${spec.name} did not open its health surface before startup timed out`);
        }
      }
    }
    return await completion;
  } finally {
    startupAbort.abort();
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) signals.removeListener(signal, onSignal);
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const force = setTimeout(() => {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 15_000);
    await Promise.all(exits);
    clearTimeout(force);
  }
}
