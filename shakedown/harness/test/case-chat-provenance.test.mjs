// Every case-module chat dispatch must carry this run's testing-harness
// provenance.
//
// The gateway refuses a testing-harness bearer whose request omits the run and
// manifest ids (HTTP 400 testing_harness_provenance_required —
// src/channels/api/server/chat-completions.ts). The standard chatCase dispatch
// path merges them, but the Sprint 10 and hardening case modules used to build
// their own headers with a bare buildChatHeaders and silently dispatched
// without provenance. These tests hold the seam shut from both sides: the case
// modules cannot reach the bare builder, and the requests they actually put on
// the wire carry both headers.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  TESTING_HARNESS_MANIFEST_ID_HEADER,
  TESTING_HARNESS_RUN_ID_HEADER,
  createChatHeaderBuilder,
} from '../lib/probe.mjs';
import { buildSprint10Cases } from '../cases/sprint10.mjs';
import { buildHardeningCases } from '../cases/hardening.mjs';

const CASES_DIR = fileURLToPath(new URL('../cases/', import.meta.url));

const RUN_ID = 'run-fixture';
const MANIFEST_ID = 'shakedown:fixture:run-fixture';

const fixtureChatHeaders = createChatHeaderBuilder({
  apiKey: 'fixture-api-key',
  runId: RUN_ID,
  manifestId: MANIFEST_ID,
});

const context = {
  runToken: '2026-09-09T12-00-00',
  primaryContactId: 'contact-fixture',
  primaryApiUserId: 'api-key-fixture',
};

const services = {
  apiBase: 'http://127.0.0.1:10153',
  apiUrl: 'http://127.0.0.1:10153/v1/chat/completions',
  adminBase: 'http://127.0.0.1:10154',
  apiKey: 'fixture-api-key',
  chatHeaders: fixtureChatHeaders,
  companionDataDir: '/round/companion-data',
  systemDataDir: '/round/system-data',
  fetchJson: async () => ({ ok: true, status: 200, body: {} }),
  pgAll: async () => [],
  pgScalar: async () => 0,
  readJsonIfExists: () => null,
  readJsonl: () => [],
  waitForTurnRecord: async () => null,
};

function caseSourceFiles(dir = CASES_DIR, found = []) {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      caseSourceFiles(path, found);
      continue;
    }
    if (entry.endsWith('.mjs')) found.push(path);
  }
  return found;
}

// Capture the headers of every chat dispatch a case puts on the wire. Case
// modules are the unit under test, so the transport is stubbed rather than the
// header builder.
function captureChatDispatches(respond) {
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), headers: init.headers ?? {} });
    return respond(String(url), init);
  };
  return {
    requests,
    restore: () => { globalThis.fetch = originalFetch; },
  };
}

function assertProvenanceOnEveryRequest(requests, expectedCount) {
  assert.ok(
    requests.length >= expectedCount,
    `expected at least ${expectedCount} captured chat dispatches, saw ${requests.length}`,
  );
  for (const request of requests) {
    assert.equal(
      request.headers[TESTING_HARNESS_RUN_ID_HEADER],
      RUN_ID,
      `${request.url} dispatched without the testing-harness run id`,
    );
    assert.equal(
      request.headers[TESTING_HARNESS_MANIFEST_ID_HEADER],
      MANIFEST_ID,
      `${request.url} dispatched without the testing-harness manifest id`,
    );
  }
}

const jsonTurn = () => new Response(JSON.stringify({
  choices: [{ message: { content: 'ok' } }],
}), { status: 200, headers: { 'content-type': 'application/json' } });

test('no case module reaches the bare, provenance-free chat header builder', () => {
  const offenders = caseSourceFiles()
    .filter((path) => readFileSync(path, 'utf8').includes('buildChatHeaders'));
  assert.deepEqual(
    offenders,
    [],
    'case modules must dispatch through services.chatHeaders, never buildChatHeaders',
  );
});

test('every case module that dispatches chat demands the provenance-bearing builder', () => {
  for (const path of caseSourceFiles()) {
    const source = readFileSync(path, 'utf8');
    const dispatches = source.includes('postChatCompletion(')
      || source.includes('probeSseChatCompletion(');
    if (!dispatches) continue;
    assert.ok(
      source.includes('requireCaseChatHeaders('),
      `${path} dispatches chat but never calls requireCaseChatHeaders`,
    );
    assert.ok(
      source.includes('services.chatHeaders('),
      `${path} dispatches chat without services.chatHeaders`,
    );
  }
});

test('case catalogs fail closed when the services object has no chat-header builder', () => {
  const { chatHeaders, ...withoutBuilder } = services;
  assert.equal(typeof chatHeaders, 'function');
  assert.throws(
    () => buildSprint10Cases(context, withoutBuilder, {}),
    /requires services\.chatHeaders/u,
  );
  assert.throws(
    () => buildHardeningCases(context, withoutBuilder),
    /requires services\.chatHeaders/u,
  );
});

test('the chat-header builder fails closed on an absent run or manifest id', () => {
  assert.throws(
    () => createChatHeaderBuilder({ apiKey: 'k', runId: '', manifestId: MANIFEST_ID }),
    /non-empty testing-harness runId and manifestId/u,
  );
  assert.throws(
    () => createChatHeaderBuilder({ apiKey: 'k', runId: RUN_ID, manifestId: '  ' }),
    /non-empty testing-harness runId and manifestId/u,
  );
});

test('the chat-header builder keeps provenance authoritative over case-supplied headers', () => {
  const headers = fixtureChatHeaders({
    apiKey: 'satellite-key',
    sessionId: 'session-fixture',
    privacy: 'public',
    extra: {
      'X-PSFN-Satellite-ID': 'satellite-fixture',
      [TESTING_HARNESS_RUN_ID_HEADER]: 'forged-run',
      [TESTING_HARNESS_MANIFEST_ID_HEADER]: 'forged-manifest',
    },
  });
  assert.equal(headers.Authorization, 'Bearer satellite-key');
  assert.equal(headers['X-Session-ID'], 'session-fixture');
  assert.equal(headers['X-Channel-Privacy'], 'public');
  assert.equal(headers['X-PSFN-Satellite-ID'], 'satellite-fixture');
  assert.equal(headers[TESTING_HARNESS_RUN_ID_HEADER], RUN_ID);
  assert.equal(headers[TESTING_HARNESS_MANIFEST_ID_HEADER], MANIFEST_ID);
  // The bound key is the default; a case that names none still authenticates.
  assert.equal(
    fixtureChatHeaders({ sessionId: 'session-fixture' }).Authorization,
    'Bearer fixture-api-key',
  );
});

test('s10_temporal_stamp_strip dispatches every turn with run provenance', async () => {
  const stamp = '[Wed 09-09-26 12:34]';
  const messages = [];
  const capture = captureChatDispatches((_url, init) => {
    messages.push(JSON.parse(init.body).messages[0].content);
    return jsonTurn();
  });
  let turnIndex = 0;
  try {
    const temporal = buildSprint10Cases(context, {
      ...services,
      waitForTurnRecord: async ({ message }) => {
        turnIndex += 1;
        if (turnIndex === 1) return { turnId: 'seed', status: 'completed' };
        if (turnIndex === 2) {
          return {
            turnId: 'preview',
            status: 'completed',
            observability: { snapshot: { plan: { messages: [
              { role: 'user', content: `${stamp} ${messages[0]}` },
            ] } } },
          };
        }
        return {
          turnId: 'main',
          status: 'completed',
          userMessage: { content: message },
          assistantMessage: { content: `Here is the exact line:\n${messages[0]}` },
          observability: { snapshot: {
            plan: { messages: [{ role: 'user', content: `${stamp} ${messages[0]}` }] },
            promptContext: {
              response: { content: `Here is the exact line:\n${stamp} ${messages[0]}` },
            },
          } },
        };
      },
    }, {}).find((entry) => entry.id === 's10_temporal_stamp_strip');
    await temporal.execute({
      sessionId: temporal.sessionId,
      apiUserId: context.primaryApiUserId,
    });
  } finally {
    capture.restore();
  }
  assertProvenanceOnEveryRequest(capture.requests, 3);
});

test('s10_sse_first_chunk dispatches its streaming turn with run provenance', async () => {
  const capture = captureChatDispatches(() => new Response(
    'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'
    + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
    + 'data: [DONE]\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  ));
  try {
    const sse = buildSprint10Cases(context, {
      ...services,
      waitForTurnRecord: async () => ({ turnId: 'sse', status: 'completed' }),
    }, {}).find((entry) => entry.id === 's10_sse_first_chunk');
    await sse.execute({
      sessionId: sse.sessionId,
      apiUserId: context.primaryApiUserId,
    });
  } finally {
    capture.restore();
  }
  assertProvenanceOnEveryRequest(capture.requests, 1);
});

test('the satellite CogSec dispatch carries run provenance alongside its scoped bearer', async () => {
  const satelliteKey = 'fixture-satellite-key-1234';
  const env = {
    COMPANION_ID: '11111111-1111-4111-8111-111111111111',
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_API_KEY: satelliteKey,
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_CLAIM_TYPE: 'satellite-endpoint',
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_ID: 'satellite-fixture',
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_ENDPOINT_ID: 'endpoint-fixture',
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_SESSION_ID: 'session-fixture',
  };
  const capture = captureChatDispatches(() => jsonTurn());
  try {
    const satelliteCase = buildSprint10Cases(context, {
      ...services,
      issueHubDeviceAssertion: () => 'header.claims.signature',
      waitForTurnRecord: async () => ({
        turnId: 'satellite-turn-1',
        status: 'completed',
        location: { satelliteId: 'satellite-fixture' },
        userMessage: { content: 'fixture' },
      }),
    }, env).find((entry) => entry.id === 's10_cogsec_satellite_document_quarantine');
    await satelliteCase.execute({
      sessionId: satelliteCase.sessionId,
      apiUserId: context.primaryApiUserId,
    });
  } finally {
    capture.restore();
  }
  assertProvenanceOnEveryRequest(capture.requests, 1);
  // The satellite dispatch path keeps its scoped bearer and hub-device assertion.
  assert.equal(capture.requests[0].headers.Authorization, `Bearer ${satelliteKey}`);
  assert.equal(
    capture.requests[0].headers['X-PSFN-Hub-Device-Assertion'],
    'header.claims.signature',
  );
});

test('model_lane_attribution dispatches its hardening turns with run provenance', async () => {
  const capture = captureChatDispatches(() => jsonTurn());
  let turnIndex = 0;
  try {
    const attribution = buildHardeningCases(context, {
      ...services,
      waitForTurnRecord: async () => ({
        turnId: `turn-${++turnIndex}`,
        status: 'completed',
        assistantMessage: { content: 'ok' },
      }),
      pgAll: async () => { throw new Error('Query read timeout'); },
    }, { modelLaneDispatchTimeoutMs: 100 })
      .find((entry) => entry.id === 'model_lane_attribution');
    await attribution.execute({
      ctx: context,
      sessionId: 'hardening-spend-provenance',
      apiUserId: context.primaryApiUserId,
    });
  } finally {
    capture.restore();
  }
  assertProvenanceOnEveryRequest(capture.requests, 1);
});

test('a refused chat dispatch surfaces the gateway status and error body', async () => {
  const refusal = JSON.stringify({
    error: {
      message: 'Testing-harness chat requests require exact run and manifest identifiers',
      type: 'testing_harness_provenance_required',
    },
  });
  const capture = captureChatDispatches(() => new Response(refusal, {
    status: 400,
    headers: { 'content-type': 'application/json' },
  }));
  let observed = null;
  try {
    const temporal = buildSprint10Cases(context, {
      ...services,
      waitForTurnRecord: async () => {
        throw new Error('a refused dispatch must never wait for a turn record');
      },
    }, {}).find((entry) => entry.id === 's10_temporal_stamp_strip');
    observed = await temporal.execute({
      sessionId: temporal.sessionId,
      apiUserId: context.primaryApiUserId,
    }).then(() => null, (error) => error);
  } finally {
    capture.restore();
  }
  assert.ok(observed instanceof Error);
  assert.match(observed.message, /temporal history seed chat dispatch was refused/u);
  assert.match(observed.message, /HTTP 400 \(application\/json\)/u);
  assert.match(observed.message, /testing_harness_provenance_required/u);
});
