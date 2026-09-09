#!/usr/bin/env node
// ── Docker Compose smoke harness (psfn-framework-65rk.12) ──
// The Compose analogue of the k8s smoke:chat. Brings up the split runtime
// (postgres + gateway + agent + provider-stub + satellite-hub + companion-ui)
// from docker/docker-compose.smoke.yml, proves the plumbing (gateway API edge
// up, gateway<->agent RPC connected), verifies the Satellite Hub and
// companion-ui surfaces, then drives one OpenAI-compatible chat turn through the
// gateway /v1 edge.
//
// KEYLESS BY CONTRACT (psfn-framework-j3iol). The stack needs no provider
// account: docker/smoke-fixtures/{providers,models}.json route every model
// purpose at the in-stack `provider-stub` double, and the gateway resolves and
// presents a real bearer for it. So a complete turn is always expected, and
// there is no "stopped at the provider boundary" outcome to excuse. A turn that
// does not complete is a failure of this stack, not of an absent key.
//
// This harness does NOT prove a real provider account, model slug, or egress
// path works. That is `npm run compose:verify` against docker/compose.yml.
//
// Exit codes:
//   0  full turn: /v1/chat/completions returned a persisted assistant reply.
//   3  hub contract boundary reached: the whole stack is healthy and the hub
//      handshake works, but companion-ui's own protocol decoder rejects a live
//      hub frame. That is a source-contract divergence, not a deployment fault.
//   1  failure: the stack did not come up, the gateway API edge never became
//      healthy, or the chat turn did not complete and persist.
//
// Usage:
//   npm run smoke:docker -- [--no-up] [--keep-up] [--message <text>]
//     --no-up     assume the stack is already running (skip compose up)
//     --keep-up   leave the stack running on exit (default: compose down -v)
//
// Runs under tsx: the hub verification imports companion-ui's own TypeScript
// protocol codec so the handshake is decoded by the real client, not a copy.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { verifyComposeHub } from './compose-hub-verification.ts';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const COMPOSE_FILE = resolve(REPO_ROOT, 'docker/docker-compose.smoke.yml');
const API_PORT = process.env.PSFN_SMOKE_API_PORT || '13000';
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const API_KEY = process.env.PSFN_SMOKE_API_KEY || 'psfn-smoke-api-key-please-rotate';
const AUTH_HEADERS = { Authorization: `Bearer ${API_KEY}` };
const SMOKE_SESSION_ID = 'compose-persistence';
const API_PRINCIPAL_ID = `api-key-${createHash('sha256').update(API_KEY.trim()).digest('hex').slice(0, 24)}`;
const SMOKE_CHANNEL_ID = `api:${API_PRINCIPAL_ID}:${SMOKE_SESSION_ID}`;
const HUB_PORT = process.env.PSFN_SMOKE_HUB_PORT || '18787';
const COMPANION_UI_PORT = process.env.PSFN_SMOKE_COMPANION_UI_PORT || '18080';
const SATELLITE_API_KEY = process.env.PSFN_SMOKE_SATELLITE_API_KEY
  || 'psfn-smoke-satellite-key-please-rotate';
const HUB_VERIFY_TIMEOUT_MS = 20_000;

function log(msg) {
  console.log(`[smoke:docker] ${msg}`);
}
function pass(msg) {
  console.log(`[smoke:docker] PASS  ${msg}`);
}
function fail(msg) {
  console.error(`[smoke:docker] FAIL  ${msg}`);
}

function parseArgs(argv) {
  const opts = { up: true, keepUp: false, message: 'Smoke ping from the docker compose stack.' };
  for (let i = 0; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--no-up': opts.up = false; break;
      case '--keep-up': opts.keepUp = true; break;
      case '--message': opts.message = argv[++i]; break;
      case '--help': case '-h':
        console.log('Usage: node scripts/smoke-docker.mjs [--no-up] [--keep-up] [--message <text>]');
        process.exit(0);
        break;
      default: throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  return opts;
}

function compose(args, { capture = false } = {}) {
  const result = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, ...args], {
    cwd: REPO_ROOT,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    env: process.env,
  });
  if (result.error) throw result.error;
  return result;
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Plumbing subsystems that MUST be healthy for the stack to be considered wired:
// memory (agent RPC connected + Postgres persistence), embeddings (in-process
// model warmed), scheduler (agent runtime lanes up), and llm — the provider
// double is part of this stack, so a degraded `llm` subsystem is a real defect
// here, not an expected keyless state. `discord` is benign (transport runs
// outside the agent container).
const PLUMBING_SUBSYSTEMS = ['memory', 'embeddings', 'scheduler', 'llm'];

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'no attempt';
  while (Date.now() < deadline) {
    try {
      // /health is authenticated and returns 503 while any subsystem is
      // degraded, so read the body regardless of status code and inspect the
      // plumbing subsystems directly.
      const res = await fetchWithTimeout(`${API_BASE}/health`, { method: 'GET', headers: AUTH_HEADERS }, 5000);
      const text = await res.text();
      let payload;
      try { payload = JSON.parse(text); } catch { payload = null; }
      const subsystems = payload?.subsystems;
      if (subsystems && typeof subsystems === 'object') {
        const unhealthy = PLUMBING_SUBSYSTEMS.filter((name) => subsystems[name]?.status !== 'healthy');
        if (unhealthy.length === 0) {
          return { httpStatus: res.status, payload, subsystems };
        }
        lastErr = `plumbing not ready: ${unhealthy.map((n) => `${n}=${subsystems[n]?.status ?? 'absent'}`).join(', ')}`;
      } else {
        lastErr = `status ${res.status}, unparseable body`;
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await sleep(2000);
  }
  throw new Error(`gateway /health plumbing never became ready (${lastErr})`);
}

// Migration signal. The fleet topology puts every runtime table in this
// companion's own schema plus the shared one — `public` is empty by design, so
// counting it proved nothing. Conversation persistence is still asserted
// against the agent's canonical L0 session journal after the successful turn.
async function queryRuntimeTableCount() {
  const res = compose(
    ['exec', '-T', 'postgres', 'psql', '-U', 'psfn', '-d', 'psfn_smoke', '-tAc',
      "SELECT count(*) FROM information_schema.tables "
      + "WHERE table_schema IN ('companion_smoke', 'shared');"],
    { capture: true },
  );
  if (res.status !== 0) return null;
  const count = Number((res.stdout || '').trim());
  return Number.isInteger(count) ? count : null;
}

function verifyPersistedTurn(userContent, assistantContent) {
  const verifier = String.raw`
    const fs = require('node:fs');
    const path = require('node:path');
    const [channelId, userContent, assistantContent] = process.argv.slice(1);
    const sessionsDir = '/app/runtime-root/companions/smoke/state/sessions';
    const index = JSON.parse(fs.readFileSync(path.join(sessionsDir, '_channel_index.json'), 'utf8'));
    const entry = index.channels?.[channelId];
    if (!entry || !Array.isArray(entry.filenames) || entry.filenames.length === 0) process.exit(2);
    const rows = entry.filenames.flatMap(filename =>
      fs.readFileSync(path.join(sessionsDir, filename), 'utf8')
        .split('\n').filter(Boolean).map(line => JSON.parse(line)));
    const hasUser = rows.some(row => row.type === 'message'
      && row.role === 'user' && row.content === userContent);
    const hasAssistant = rows.some(row => row.type === 'message'
      && row.role === 'assistant' && row.content === assistantContent);
    if (!hasUser || !hasAssistant) process.exit(3);
  `;
  const result = compose([
    'exec', '-T', 'agent', 'node', '-e', verifier,
    SMOKE_CHANNEL_ID, userContent, assistantContent,
  ], { capture: true });
  return result.status === 0;
}

// A contract divergence between two source trees is neither a deployment fault
// nor a provider fault, so it gets its own exit code instead of masking either.
function contractExit(code, contractBoundary) {
  if (!contractBoundary) return code;
  fail(`HUB CONTRACT BOUNDARY: ${contractBoundary}`);
  log('Everything else in the stack is healthy; this is a source-contract divergence.');
  return 3;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let exitCode = 1;

  try {
    if (opts.up) {
      log('Bringing up postgres + provider-stub + gateway + agent + satellite-hub '
        + '+ companion-ui (docker compose up -d --wait)...');
      const up = compose(['up', '-d', '--wait', '--wait-timeout', '240']);
      if (up.status !== 0) {
        fail('docker compose up did not reach a healthy state');
        compose(['ps']);
        return 1;
      }
      pass('all services reported healthy (postgres, provider-stub, gateway, agent, '
        + 'satellite-hub, companion-ui)');
    }

    log(`Waiting for gateway API edge at ${API_BASE}/health ...`);
    const health = await waitForHealth(120_000);
    const subStatus = Object.entries(health.subsystems)
      .map(([k, v]) => `${k}=${v.status}`)
      .join(', ');
    pass('gateway<->agent RPC connected and plumbing healthy '
      + '(memory/embeddings/scheduler/llm); Postgres migrations applied.');
    log(`/health subsystems: ${subStatus}`);

    // Agent RPC connectivity: the agent container is healthy only once its
    // gateway socket peer is connectable, and the health payload reflects the
    // agent-backed scheduler. Report the table count as a migration signal.
    const tableCount = await queryRuntimeTableCount();
    if (tableCount === null) {
      fail('could not read the runtime schema table count from Postgres');
      return 1;
    }
    if (tableCount === 0) {
      fail('Postgres is reachable but the companion_smoke/shared schemas are empty: '
        + 'runtime migrations did not run');
      return 1;
    }
    pass(`Postgres reachable; companion_smoke + shared schemas hold ${tableCount} tables `
      + '(runtime migrations ran)');

    log('Verifying the Satellite Hub and companion-ui surfaces ...');
    let hubContractBoundary = null;
    try {
      const hubResult = await verifyComposeHub({
        hubBase: `http://127.0.0.1:${HUB_PORT}`,
        hubWsUrl: `ws://127.0.0.1:${HUB_PORT}/`,
        companionUiBase: `http://127.0.0.1:${COMPANION_UI_PORT}`,
        gatewayApiBase: `${API_BASE}/v1`,
        satelliteApiKey: SATELLITE_API_KEY,
        satelliteId: 'smoke-hub',
        endpointId: 'smoke-hub-endpoint',
        claimType: 'satellite.endpoint',
        timeoutMs: HUB_VERIFY_TIMEOUT_MS,
      });
      for (const entry of hubResult.checks) {
        if (entry.ok) pass(`${entry.name} (${entry.detail})`);
        else fail(`${entry.name}: ${entry.detail}`);
      }
      hubContractBoundary = hubResult.contractBoundary;
      const blocking = hubResult.checks.filter((entry) => !entry.ok
        && entry.name !== 'companion-ui decoder accepts the hub session.ready');
      if (blocking.length > 0) {
        fail(`hub/companion-ui verification failed: ${blocking.map((entry) => entry.name).join(', ')}`);
        return 1;
      }
    } catch (err) {
      fail(`hub/companion-ui verification could not run: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }

    log('Driving one chat turn: POST /v1/chat/completions ...');
    let res;
    try {
      res = await fetchWithTimeout(`${API_BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-Session-Id': SMOKE_SESSION_ID,
          ...AUTH_HEADERS,
        },
        body: JSON.stringify({
          model: 'companion',
          messages: [{ role: 'user', content: opts.message }],
          stream: false,
        }),
      }, 90_000);
    } catch (err) {
      fail(`chat request transport failed before reaching the provider: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }

    const bodyText = await res.text();
    if (res.ok) {
      let payload;
      try { payload = JSON.parse(bodyText); } catch { payload = null; }
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content === 'string' && content.trim().length > 0) {
        if (!verifyPersistedTurn(opts.message, content)) {
          fail(`chat reply returned but the exact user/assistant turn was not found in ${SMOKE_CHANNEL_ID}`);
          return 1;
        }
        pass(`full Autonomous turn persisted and returned: ${content.slice(0, 160)}`);
        pass(`canonical L0 session journal contains the exact user/assistant pair (${SMOKE_CHANNEL_ID})`);
        return contractExit(0, hubContractBoundary);
      }
      fail(`chat returned ${res.status} but no assistant content: ${bodyText.slice(0, 240)}`);
      return 1;
    }

    // The provider double is part of this stack, so there is no external
    // boundary left to excuse a non-2xx: every one of them is a real failure.
    fail(`chat turn failed (status ${res.status}): ${bodyText.slice(0, 280)}`);
    log('The provider double runs inside this stack; inspect the gateway, agent, '
      + 'and provider-stub logs (docker compose -f docker/docker-compose.smoke.yml logs).');
    return 1;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    if (opts.up && !opts.keepUp) {
      log('Tearing down (docker compose down -v)...');
      compose(['down', '-v']);
    }
    void exitCode;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
