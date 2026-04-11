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
        schedulerHealthcheck: { status: 'healthy' },
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
        schedulerHealthcheck: { status: 'healthy' },
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

function isExpectedAuthorization(headerValue, expectedApiKey) {
  if (typeof headerValue !== 'string') return false;
  return headerValue.trim() === `Bearer ${expectedApiKey}`;
}

async function runScenario(name, options = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), `psfn-watchdog-smoke-${name}-`));
  const stateFile = join(tempDir, 'watchdog-state.json');
  const expectedApiKey = options.expectedApiKey ?? '';
  const watchdogApiKey = options.watchdogApiKey ?? '';

  let mode = 'healthy';
  const server = createServer((req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }

    if (expectedApiKey && !isExpectedAuthorization(req.headers.authorization, expectedApiKey)) {
      res.setHeader('content-type', 'application/json');
      res.writeHead(401);
      res.end(JSON.stringify({
        error: {
          type: 'invalid_api_key',
          message: 'Invalid or missing API key',
        },
      }));
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

  try {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error(`Failed to resolve smoke server port for scenario "${name}"`);
    }

    const baseEnv = {
      ...process.env,
      CONTINUITY_WATCHDOG_ENDPOINT: `http://127.0.0.1:${address.port}/health`,
      CONTINUITY_WATCHDOG_TIMEOUT_MS: '1500',
      CONTINUITY_WATCHDOG_MAX_FAILURES: '2',
      CONTINUITY_WATCHDOG_STATE_FILE: stateFile,
      CONTINUITY_WATCHDOG_RESTART_PID: '',
    };
    delete baseEnv.API_KEY;
    delete baseEnv.CONTINUITY_WATCHDOG_API_KEY;
    if (watchdogApiKey) {
      baseEnv.API_KEY = watchdogApiKey;
    }

    if (expectedApiKey) {
      const unauthenticatedEnv = { ...baseEnv };
      delete unauthenticatedEnv.API_KEY;
      delete unauthenticatedEnv.CONTINUITY_WATCHDOG_API_KEY;
      const unauthenticatedRun = await runWatchdog(unauthenticatedEnv);
      if (unauthenticatedRun.code !== 1 || !unauthenticatedRun.stderr.includes('HTTP 401')) {
        throw new Error(
          `Expected unauthenticated watchdog run to fail with HTTP 401 in scenario "${name}", got ${unauthenticatedRun.code}: ${unauthenticatedRun.stderr}`,
        );
      }
    }

    const healthyRun = await runWatchdog(baseEnv);
    if (healthyRun.code !== 0) {
      throw new Error(`Expected healthy watchdog run to pass in scenario "${name}", got ${healthyRun.code}: ${healthyRun.stderr}`);
    }

    mode = 'degraded';
    const degradedRun1 = await runWatchdog(baseEnv);
    if (degradedRun1.code !== 1) {
      throw new Error(`Expected first degraded watchdog run to fail in scenario "${name}", got ${degradedRun1.code}: ${degradedRun1.stderr}`);
    }

    const degradedRun2 = await runWatchdog(baseEnv);
    if (degradedRun2.code !== 1) {
      throw new Error(`Expected second degraded watchdog run to fail in scenario "${name}", got ${degradedRun2.code}: ${degradedRun2.stderr}`);
    }

    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    if (state.consecutiveFailures !== 2) {
      throw new Error(`Expected consecutiveFailures=2 in scenario "${name}", got ${JSON.stringify(state)}`);
    }

    mode = 'healthy';
    const recoveryRun = await runWatchdog(baseEnv);
    if (recoveryRun.code !== 0) {
      throw new Error(`Expected recovery watchdog run to pass in scenario "${name}", got ${recoveryRun.code}: ${recoveryRun.stderr}`);
    }
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

await runScenario('insecure-local');
await runScenario('authenticated', {
  expectedApiKey: 'watchdog-auth-token',
  watchdogApiKey: 'watchdog-auth-token',
});

console.log('continuity-watchdog smoke passed (insecure-local + authenticated)');
