#!/usr/bin/env node

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const watchdogScript = new URL('./continuity-watchdog-healthcheck.mjs', import.meta.url);
const watchdogScriptPath = fileURLToPath(watchdogScript);

function makeHealthyPayload() {
  return {
    status: 'healthy',
    checkedAt: new Date().toISOString(),
    uptimeSeconds: 42,
    subsystems: {
      memory: { status: 'healthy' },
      llm: { status: 'healthy' },
      discord: { status: 'healthy' },
      embeddings: { status: 'healthy' },
      scheduler: { status: 'healthy' },
    },
    continuity: {
      status: 'healthy',
      checks: {
        database: { status: 'healthy' },
        gatewayLink: { status: 'healthy' },
        schedulerHeartbeat: { status: 'healthy' },
      },
    },
  };
}

function makeDegradedPayload() {
  return {
    status: 'degraded',
    checkedAt: new Date().toISOString(),
    uptimeSeconds: 42,
    subsystems: {
      memory: { status: 'healthy' },
      llm: { status: 'degraded', detail: 'simulated llm outage' },
      discord: { status: 'healthy' },
      embeddings: { status: 'degraded', detail: 'simulated gateway outage' },
      scheduler: { status: 'healthy' },
    },
    continuity: {
      status: 'degraded',
      checks: {
        database: { status: 'healthy' },
        gatewayLink: { status: 'degraded', detail: 'simulated gateway outage' },
        schedulerHeartbeat: { status: 'healthy' },
      },
    },
  };
}

function runWatchdog(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [watchdogScriptPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code: code ?? -1,
        stderr: stderr.trim(),
      });
    });
  });
}

const tempDir = await mkdtemp(join(tmpdir(), 'psfn-watchdog-smoke-'));
const stateFile = join(tempDir, 'watchdog-state.json');

let mode = 'healthy';
const server = createServer((req, res) => {
  if (req.url !== '/health') {
    res.writeHead(404).end();
    return;
  }

  const payload = mode === 'healthy' ? makeHealthyPayload() : makeDegradedPayload();
  res.setHeader('content-type', 'application/json');
  res.writeHead(mode === 'healthy' ? 200 : 503);
  res.end(JSON.stringify(payload));
});

await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', resolve);
});

const address = server.address();
if (!address || typeof address === 'string') {
  throw new Error('Failed to resolve smoke server port');
}

const baseEnv = {
  ...process.env,
  CONTINUITY_WATCHDOG_ENDPOINT: `http://127.0.0.1:${address.port}/health`,
  CONTINUITY_WATCHDOG_TIMEOUT_MS: '1500',
  CONTINUITY_WATCHDOG_MAX_FAILURES: '2',
  CONTINUITY_WATCHDOG_STATE_FILE: stateFile,
  CONTINUITY_WATCHDOG_RESTART_PID: '',
};

const healthyRun = await runWatchdog(baseEnv);
if (healthyRun.code !== 0) {
  throw new Error(`Expected healthy watchdog run to pass, got ${healthyRun.code}: ${healthyRun.stderr}`);
}

mode = 'degraded';
const degradedRun1 = await runWatchdog(baseEnv);
if (degradedRun1.code !== 1) {
  throw new Error(`Expected first degraded watchdog run to fail, got ${degradedRun1.code}: ${degradedRun1.stderr}`);
}

const degradedRun2 = await runWatchdog(baseEnv);
if (degradedRun2.code !== 1) {
  throw new Error(`Expected second degraded watchdog run to fail, got ${degradedRun2.code}: ${degradedRun2.stderr}`);
}

const state = JSON.parse(await readFile(stateFile, 'utf8'));
if (state.consecutiveFailures !== 2) {
  throw new Error(`Expected consecutiveFailures=2, got ${JSON.stringify(state)}`);
}

mode = 'healthy';
const recoveryRun = await runWatchdog(baseEnv);
if (recoveryRun.code !== 0) {
  throw new Error(`Expected recovery watchdog run to pass, got ${recoveryRun.code}: ${recoveryRun.stderr}`);
}

await new Promise((resolve, reject) => {
  server.close((error) => {
    if (error) reject(error);
    else resolve();
  });
});

console.log('continuity-watchdog smoke passed');
