#!/usr/bin/env node
// ── Docker Compose smoke harness (psfn-framework-65rk.12) ──
// The Compose analogue of the k8s smoke:chat. Brings up the split runtime
// (postgres + gateway + agent) from docker/docker-compose.smoke.yml, proves the
// plumbing (gateway API edge up, gateway<->agent RPC connected), then drives one
// OpenAI-compatible chat turn through the gateway /v1 edge.
//
// Exit codes:
//   0  full turn: /v1/chat/completions returned a persisted assistant reply.
//   2  provider boundary reached: stack healthy and the request was accepted,
//      but the turn failed at the external provider egress (expected when
//      OPENROUTER_API_KEY is unset). This is the documented "validate up to the
//      provider call" stop.
//   1  plumbing failure: the stack did not come up, the gateway API edge never
//      became healthy, or the request failed before reaching the provider.
//
// Usage:
//   node scripts/smoke-docker.mjs [--no-up] [--keep-up] [--message <text>]
//     --no-up     assume the stack is already running (skip compose up)
//     --keep-up   leave the stack running on exit (default: compose down -v)

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

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
const HAS_PROVIDER_KEY = (process.env.OPENROUTER_API_KEY || '').trim().length > 0;

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
// model warmed), scheduler (agent runtime lanes up). The `llm` subsystem is
// EXPECTED to be degraded without a provider key (that's the provider boundary),
// and `discord` is benign (transport runs outside the agent container).
const PLUMBING_SUBSYSTEMS = ['memory', 'embeddings', 'scheduler'];

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

// A provider-boundary failure is one where the stack accepted the request and
// the turn ran up to the external model call. Plumbing failures (agent not
// connected, routing, 404, 5xx transport) are NOT provider-boundary.
function isProviderBoundary(status, bodyText) {
  const body = (bodyText || '').toLowerCase();
  const providerSignals = [
    'openrouter', 'provider', 'api key', 'api_key', 'unauthorized', '401',
    'no auth credentials', 'model', 'upstream', 'llm', 'completion failed',
    'no endpoints', 'quota', 'insufficient', 'credit', 'egress',
  ];
  const plumbingSignals = [
    'companion_not_connected', 'not connected', 'no route', 'not_found',
    'econnrefused', 'socket', 'gateway', 'timeout waiting', 'agent',
  ];
  if (plumbingSignals.some((s) => body.includes(s))) return false;
  return providerSignals.some((s) => body.includes(s));
}

async function queryPublicTableCount() {
  // Best-effort migration signal; conversation persistence is asserted against
  // the agent's canonical L0 session journal after the successful turn.
  const res = compose(
    ['exec', '-T', 'postgres', 'psql', '-U', 'psfn', '-d', 'psfn', '-tAc',
      "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"],
    { capture: true },
  );
  if (res.status !== 0) return null;
  return (res.stdout || '').trim();
}

function verifyPersistedTurn(userContent, assistantContent) {
  const verifier = String.raw`
    const fs = require('node:fs');
    const path = require('node:path');
    const [channelId, userContent, assistantContent] = process.argv.slice(1);
    const sessionsDir = '/app/companion-data/state/sessions';
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let exitCode = 1;

  try {
    if (opts.up) {
      log('Bringing up postgres + gateway + agent (docker compose up -d --wait)...');
      const up = compose(['up', '-d', '--wait', '--wait-timeout', '240']);
      if (up.status !== 0) {
        fail('docker compose up did not reach a healthy state');
        compose(['ps']);
        return 1;
      }
      pass('all services reported healthy (postgres, gateway, agent)');
    }

    log(`Waiting for gateway API edge at ${API_BASE}/health ...`);
    const health = await waitForHealth(120_000);
    const subStatus = Object.entries(health.subsystems)
      .map(([k, v]) => `${k}=${v.status}`)
      .join(', ');
    pass('gateway<->agent RPC connected and plumbing healthy '
      + '(memory/embeddings/scheduler); Postgres migrations applied.');
    log(`/health subsystems: ${subStatus}`);
    if (health.subsystems.llm?.status !== 'healthy') {
      log(`llm subsystem degraded (expected without a provider key): ${health.subsystems.llm?.detail ?? ''}`);
    }

    // Agent RPC connectivity: the agent container is healthy only once its
    // gateway socket peer is connectable, and the health payload reflects the
    // agent-backed scheduler. Report the table count as a migration signal.
    const tableCount = await queryPublicTableCount();
    if (tableCount) pass(`Postgres reachable; public schema has ${tableCount} tables (runtime migrations ran)`);

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
        return 0;
      }
      fail(`chat returned ${res.status} but no assistant content: ${bodyText.slice(0, 240)}`);
      return 1;
    }

    // Non-2xx: classify provider-boundary vs plumbing.
    if (isProviderBoundary(res.status, bodyText)) {
      log(`chat request accepted; turn stopped at the provider egress boundary (status ${res.status}).`);
      log(`provider response: ${bodyText.slice(0, 240)}`);
      if (HAS_PROVIDER_KEY) {
        fail('OPENROUTER_API_KEY is set but the provider call still failed — investigate the key/model.');
        return 1;
      }
      pass('PROVIDER BOUNDARY REACHED: stack healthy, gateway<->agent RPC connected, request accepted, '
        + 'turn failed only at the external provider (set OPENROUTER_API_KEY for a full turn).');
      return 2;
    }

    fail(`chat failed before the provider boundary (status ${res.status}): ${bodyText.slice(0, 280)}`);
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
