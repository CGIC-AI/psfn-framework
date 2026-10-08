import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareSplitRuntime, superviseSplitRuntime } from '../lib/split-runtime.mjs';

test('real child processes receive only their role credentials and stop together after failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'psfn-split-regression-'));
  const signals = new EventEmitter();
  let prepared;
  const health = createServer((_req, res) => { res.end("ready"); });
  await new Promise(resolve => health.listen(0, '127.0.0.1', resolve));
  try {
    mkdirSync(join(root, 'dist'));
    const config = { apiBase: `http://127.0.0.1:${health.address().port}`, repoRoot: root, tempDir: root, companionId: '11111111-1111-4111-8111-111111111111', postgresUrl: 'postgresql://fixture:fixture@127.0.0.1:5432/shakedown_fixture' };
    const env = {
      PSFN_TEMP_DIR: root,
      PSFN_BACKUP_ENCRYPTION_KEY: 'fixture-backup-key',
      GATEWAY_SESSION_HMAC_KEY: 'fixture-hmac-key',
      OPENROUTER_API_KEY: 'fixture-provider-secret',
      ADMIN_TOKEN: 'fixture-admin-token',
      API_KEY: 'fixture-edge-token',
      POSTGRES_ADMIN_DATABASE_URL: 'postgresql://admin:fixture@127.0.0.1/fixture',
      PSFN_LIVE_POSTGRES_DATABASE_URL: 'postgresql://protected:fixture@127.0.0.1/protected',
      POSTGRES_DATABASE_URL: config.postgresUrl,
      PSFN_API_BASE: 'http://127.0.0.1:19053',
    };
    prepared = prepareSplitRuntime(config, env);
    const output = name => join(root, `${name}.json`);
    for (const name of ['gateway', 'agent', 'operator']) {
      writeFileSync(join(root, 'dist', `${name}-main.js`), `
        const fs = require('node:fs');
        const path = require('node:path');
        fs.writeFileSync(path.join(process.env.PSFN_TEMP_DIR, '${name}.json'), JSON.stringify({ env: process.env, pid: process.pid }));
        process.on('SIGTERM', () => { fs.writeFileSync(path.join(process.env.PSFN_TEMP_DIR, '${name}.stopped'), 'yes'); process.exit(0); });
        const timer = setInterval(() => {
          if ('${name}' === 'gateway' && ['agent','operator'].every(n => fs.existsSync(path.join(process.env.PSFN_TEMP_DIR, n + '.json')))) { clearInterval(timer); process.exit(7); }
        }, 10);
      `);
    }
    assert.equal(await superviseSplitRuntime({ processes: prepared.processes, cwd: root, signals }), 1);
    const gateway = JSON.parse(readFileSync(output('gateway'))).env;
    const agent = JSON.parse(readFileSync(output('agent'))).env;
    const operator = JSON.parse(readFileSync(output('operator'))).env;
    assert.equal(gateway.OPENROUTER_API_KEY, env.OPENROUTER_API_KEY);
    assert.equal(gateway.POSTGRES_ADMIN_DATABASE_URL, undefined);
    assert.equal(gateway.PSFN_LIVE_POSTGRES_DATABASE_URL, undefined);
    for (const role of [agent, operator]) {
      for (const name of ['OPENROUTER_API_KEY', 'GATEWAY_SESSION_HMAC_KEY', 'API_KEY']) assert.equal(role[name], undefined);
    }
    assert.equal(agent.POSTGRES_DATABASE_URL, undefined);
    assert.equal(agent.ADMIN_TOKEN, undefined);
    assert.match(agent.GATEWAY_COMPANION_AUTH_TOKEN, /^v1\.[a-f0-9]{64}$/u);
    assert.notEqual(agent.GATEWAY_COMPANION_AUTH_TOKEN, agent.GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN);
    assert.equal(readFileSync(agent.POSTGRES_DATABASE_URL_FILE, 'utf8'), config.postgresUrl);
    assert.equal(statSync(agent.POSTGRES_DATABASE_URL_FILE).mode & 0o777, 0o600);
    assert.equal(operator.ADMIN_TOKEN, env.ADMIN_TOKEN);
    assert.equal(operator.GATEWAY_COMPANION_AUTH_TOKEN, undefined);
    assert.equal(existsSync(join(root, 'agent.stopped')), true);
    assert.equal(existsSync(join(root, 'operator.stopped')), true);
    prepared.cleanup();
    assert.equal(existsSync(agent.POSTGRES_DATABASE_URL_FILE), false);
  } finally {
    prepared?.cleanup();
    await new Promise(resolve => health.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test('a supervisor signal stops only the child it owns and returns success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'psfn-split-signal-'));
  const signals = new EventEmitter();
  try {
    const childPath = join(root, 'child.cjs');
    writeFileSync(childPath, 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000);');
    const running = superviseSplitRuntime({ processes: [{ args: [childPath], env: {} }], cwd: root, signals });
    signals.emit('SIGTERM');
    assert.equal(await running, 0);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a gateway failure before readiness prevents dependent runtimes from starting', async () => {
  const root = mkdtempSync(join(tmpdir(), 'psfn-split-startup-'));
  const health = createServer((_req, res) => { res.writeHead(503).end(); });
  await new Promise(resolve => health.listen(0, '127.0.0.1', resolve));
  try {
    const gateway = join(root, 'gateway.cjs');
    const dependent = join(root, 'dependent.cjs');
    const marker = join(root, 'unexpected-dependent-start');
    writeFileSync(gateway, 'process.exit(7);');
    writeFileSync(dependent, 'require("node:fs").writeFileSync(process.env.MARKER, "started");');
    assert.equal(await superviseSplitRuntime({
      processes: [
        { name: 'gateway', args: [gateway], env: {}, readyUrl: `http://127.0.0.1:${health.address().port}/health` },
        { name: 'agent', args: [dependent], env: { MARKER: marker } },
      ],
      cwd: root,
      signals: new EventEmitter(),
    }), 1);
    assert.equal(existsSync(marker), false);
  } finally {
    await new Promise(resolve => health.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
