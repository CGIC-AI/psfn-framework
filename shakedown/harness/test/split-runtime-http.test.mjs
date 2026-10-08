import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ApiServer } from '../../../src/channels/api/server.js';
import { GatewayApiRuntime } from '../../../src/channels/api/gateway-runtime.js';
import { EventBus } from '../../../src/shared/event-bus.js';
import { createGatewayOperatorConfirmationClient } from '../../../src/app/startup/support/gateway-operator-confirmation-client.js';
import { prepareSplitRuntime, superviseSplitRuntime } from '../lib/split-runtime.mjs';

async function startFixture(confirmationOperator) {
  const root = mkdtempSync(join(tmpdir(), 'psfn-split-http-'));
  const env = {
    API_KEY: 'fixture-api-token', ADMIN_TOKEN: 'fixture-operator-token',
    GATEWAY_SESSION_HMAC_KEY: 'fixture-hmac-key', PSFN_BACKUP_ENCRYPTION_KEY: 'fixture-backup-key',
    PSFN_TEMP_DIR: root,
  };
  const server = new ApiServer({
    port: 0, host: '127.0.0.1', modelName: 'fixture-model',
    apiKey: env.API_KEY, adminToken: env.ADMIN_TOKEN,
    eventBus: new EventBus(), agentLoop: {}, sessionManager: {},
    runtime: new GatewayApiRuntime({ requestAgent: async () => { throw new Error('No agent connected'); } }),
    confirmationOperator,
  });
  let prepared;
  try {
    await server.start();
    const apiBase = `http://127.0.0.1:${server.server.address().port}`;
    env.PSFN_API_BASE = apiBase;
    prepared = prepareSplitRuntime({
      apiBase, repoRoot: root, tempDir: root,
      companionId: '11111111-1111-4111-8111-111111111111',
      postgresUrl: 'postgresql://fixture:fixture@127.0.0.1:5432/shakedown_fixture',
    }, env);
    return {
      root, apiBase, env, prepared,
      async cleanup() { prepared.cleanup(); await server.stop(); rmSync(root, { recursive: true, force: true }); },
    };
  } catch (error) {
    prepared?.cleanup();
    await server.stop();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

test('prepared supervisor authenticates the production health route before launching the agent', async () => {
  const fixture = await startFixture();
  const signals = new EventEmitter();
  let deadline;
  try {
    const unauthenticated = await fetch(`${fixture.apiBase}/health`);
    assert.equal(unauthenticated.status, 401);
    assert.equal((await unauthenticated.json()).error.type, 'invalid_api_key');
    mkdirSync(join(fixture.root, 'dist'));
    writeFileSync(join(fixture.root, 'dist/gateway-main.js'), 'setInterval(() => {}, 1000);');
    const marker = join(fixture.root, 'agent-started');
    writeFileSync(join(fixture.root, 'dist/agent-main.js'), `
      require('node:fs').writeFileSync(require('node:path').join(process.env.PSFN_TEMP_DIR, 'agent-started'), 'yes');
    `);
    // Bound the negative control: absent auth otherwise polls for 90 seconds.
    deadline = setTimeout(() => signals.emit('SIGTERM'), 2_000);
    const result = await superviseSplitRuntime({
      processes: fixture.prepared.processes.slice(0, 2), cwd: fixture.root, signals,
    });
    assert.equal(result, 1, 'the agent must start and exit after authenticated disconnected health');
    assert.equal(existsSync(marker), true);
  } finally {
    clearTimeout(deadline);
    await fixture.cleanup();
  }
});

test('prepared operator environment reaches the production confirmation route through its real client', async () => {
  const resolutions = [];
  const fixture = await startFixture({
    resolve: async (params, authority) => {
      resolutions.push({ params, authority });
      return { id: params.id, status: 'denied', message: 'Fixture action denied.', executed: false };
    },
  });
  try {
    const operatorEnv = fixture.prepared.processes.find(item => item.name === 'operator').env;
    const client = createGatewayOperatorConfirmationClient(operatorEnv.GATEWAY_OPERATOR_API_BASE_URL, {
      operatorToken: operatorEnv.ADMIN_TOKEN, requestTimeoutMs: 2_000,
    });
    const params = { id: 'fixture-confirmation', decision: 'deny' };
    const result = await client.resolve(params, {
      kind: 'standalone_operator', authorization: `Bearer ${operatorEnv.ADMIN_TOKEN}`,
    });
    assert.equal(result.status, 'denied');
    assert.equal(result.executed, false);
    assert.deepEqual(resolutions, [{ params, authority: { kind: 'standalone_operator' } }]);
    assert.equal(operatorEnv.API_KEY, undefined);
    assert.equal(operatorEnv.GATEWAY_SESSION_HMAC_KEY, undefined);
  } finally {
    await fixture.cleanup();
  }
});
