#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  proveFirstConversation,
  waitForRuntimeReadiness,
} from '../lib/bootstrap-services.mjs';
import {
  deriveApiKeyPrincipalId,
  turnRecordPath,
} from '../lib/probe.mjs';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

const fixtureRoot = mkdtempSync(join(tmpdir(), 'psfn-bootstrap-services-'));
const turnRecordsDir = join(fixtureRoot, 'turn-records');
const apiKey = 'bootstrap-test-key';
const adminToken = 'bootstrap-admin-key';
let agentHealthAttempts = 0;

const gateway = createServer(async (request, response) => {
  assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"data":[{"id":"psfn-live"}]}');
    return;
  }
  if (request.method === 'GET' && request.url === '/health') {
    agentHealthAttempts += 1;
    if (agentHealthAttempts === 1) {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        status: 'degraded',
        continuity: {
          checks: {
            gatewayLink: {
              status: 'degraded',
              detail: 'No ready agent connected',
              meta: { agentConnected: false },
            },
          },
        },
      }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      status: 'healthy',
      continuity: {
        checks: {
          gatewayLink: {
            status: 'healthy',
            meta: { sourceSubsystems: ['llm', 'embeddings'] },
          },
        },
      },
    }));
    return;
  }
  if (request.method === 'POST' && request.url === '/v1/chat/completions') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const message = body.messages[0].content;
    const sessionId = request.headers['x-session-id'];
    const path = turnRecordPath(
      turnRecordsDir,
      sessionId,
      deriveApiKeyPrincipalId(apiKey),
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({
      status: 'completed',
      startedAt: Date.now(),
      userMessage: { content: message },
      assistantMessage: { content: 'durably recorded' },
    })}\n`);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"choices":[{"message":{"content":"ok"}}]}');
    return;
  }
  response.writeHead(404);
  response.end();
});

const garden = createServer((request, response) => {
  assert.equal(request.headers.authorization, `Bearer ${adminToken}`);
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
    return;
  }
  response.writeHead(404);
  response.end();
});

try {
  const apiBase = await listen(gateway);
  const adminBase = await listen(garden);
  const config = { apiBase, adminBase, apiKey, adminToken };

  const readiness = await waitForRuntimeReadiness({
    config,
    timeoutMs: 1000,
    pollMs: 10,
  });
  assert.deepEqual(readiness, {
    gatewayModels: true,
    gardenAdmin: true,
    agentConnected: true,
  });
  assert.ok(agentHealthAttempts >= 2, 'agent readiness must retry a not-yet-connected gateway');

  const message = 'PSFN fresh-bootstrap proof exact-message';
  const sessionId = 'bootstrap-exact-session';
  const proof = await proveFirstConversation({
    config,
    message,
    sessionId,
    turnRecordsDir,
    turnRecordTimeoutMs: 1000,
    pollMs: 10,
  });
  assert.equal(proof.message, message);
  assert.equal(proof.sessionId, sessionId);
  assert.equal(
    proof.turnRecordPath,
    turnRecordPath(turnRecordsDir, sessionId, deriveApiKeyPrincipalId(apiKey)),
  );

  console.log('bootstrap live readiness/persistence service test passed');
} finally {
  await Promise.all([close(gateway), close(garden)]);
  rmSync(fixtureRoot, { recursive: true, force: true });
}
