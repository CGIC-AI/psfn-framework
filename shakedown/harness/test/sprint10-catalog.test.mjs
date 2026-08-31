import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { deriveApiKeyPrincipalId } from '../lib/probe.mjs';
import { prepareCaseChatDispatch } from '../lib/case-dispatch-auth.mjs';
import {
  SPRINT10_CASE_IDS,
  buildSprint10Cases,
} from '../cases/sprint10.mjs';
import {
  buildTemporalMessage,
  extractRenderedHistoryStamp,
} from '../cases/sprint10/conversation.mjs';
import { ACTION_BLOCKER_PATTERN } from '../lib/harness-verdicts.mjs';

const context = {
  runToken: '2026-07-17T12-00-00',
  primaryContactId: 'contact-fixture',
  primaryApiUserId: 'api-key-fixture',
};

const services = {
  apiBase: 'http://127.0.0.1:10153',
  apiUrl: 'http://127.0.0.1:10153/v1/chat/completions',
  adminBase: 'http://127.0.0.1:10154',
  apiKey: 'fixture-api-key',
  companionDataDir: '/round/companion-data',
  systemDataDir: '/round/system-data',
  fetchJson: async () => ({ ok: true, status: 200, body: {} }),
  pgAll: async () => [],
  pgScalar: async () => 0,
  readJsonIfExists: () => null,
  readJsonl: () => [],
  waitForTurnRecord: async () => null,
};

test('Sprint 10 catalog has stable unique IDs and complete execution metadata', () => {
  const cases = buildSprint10Cases(context, services, {});
  assert.deepEqual(cases.map((entry) => entry.id), SPRINT10_CASE_IDS);
  assert.equal(new Set(SPRINT10_CASE_IDS).size, SPRINT10_CASE_IDS.length);
  assert.ok(SPRINT10_CASE_IDS.length >= 9);

  for (const entry of cases) {
    assert.equal(typeof entry.id, 'string');
    assert.ok(['nursery', 'apprentice', 'autonomous', 'all'].includes(entry.tier));
    assert.ok(Array.isArray(entry.variants) && entry.variants.length > 0);
    assert.match(entry.feature, /^psfn-framework-/u);
    assert.equal(typeof entry.proof?.source, 'string');
    assert.equal(typeof entry.proof?.assertion, 'string');
    assert.equal(typeof entry.validatePersistedProof, 'function');
  }
});

test('catalog covers every in-scope Sprint 10 executable seam without duplicating external artifacts', () => {
  const ids = new Set(buildSprint10Cases(context, services, {}).map((entry) => entry.id));
  for (const expected of [
    's10_places_physical',
    's10_places_placeless',
    's10_mindspace_virtual',
    's10_mindspace_physical_precedence',
    's10_world_read_telemetry',
    's10_hub_identity_presence_follow',
    's10_cogsec_document_quarantine',
    's10_cogsec_satellite_document_quarantine',
    's10_temporal_stamp_strip',
    's10_sse_first_chunk',
  ]) {
    assert.ok(ids.has(expected), `missing ${expected}`);
  }
  assert.ok(!ids.has('s10_multi_companion_crossover'), 'multi-companion proof belongs to the support artifact');
  assert.ok(!ids.has('s10_capability_matrix'), 'capability proof belongs to the conformance artifact');
});

test('required world and place probes admit kube and fail on named fixture prerequisites', async () => {
  const cases = buildSprint10Cases(context, services, {});
  for (const caseId of [
    's10_world_read_telemetry',
    's10_places_physical',
    's10_places_placeless',
    's10_hub_identity_presence_follow',
  ]) {
    const testCase = cases.find(entry => entry.id === caseId);
    assert.ok(testCase?.variants.includes('kube'), `${caseId} must admit the kube target`);
    await assert.rejects(
      testCase.before({}),
      error => error?.name === 'MissingEnvError' && /^PSFN_SHAKEDOWN_/u.test(error.variable),
      `${caseId} must name its missing external fixture instead of excluding kube`,
    );
  }
});

test('satellite presence cases select scoped bearers without leaking them into case metadata', () => {
  const physicalKey = 'fixture-physical-satellite-key';
  const env = {
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_API_KEY: physicalKey,
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_CLAIM_TYPE: 'satellite-endpoint',
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_ID: 'physical-satellite',
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_ENDPOINT_ID: 'physical-endpoint',
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_SESSION_ID: 'physical-session',
    PSFN_SHAKEDOWN_PLACELESS_SATELLITE_CLAIM_TYPE: 'satellite-endpoint',
    PSFN_SHAKEDOWN_PLACELESS_SATELLITE_ID: 'placeless-satellite',
    PSFN_SHAKEDOWN_PLACELESS_SATELLITE_ENDPOINT_ID: 'placeless-endpoint',
    PSFN_SHAKEDOWN_PLACELESS_SATELLITE_SESSION_ID: 'placeless-session',
    PSFN_SHAKEDOWN_HUB_SATELLITE_CLAIM_TYPE: 'satellite-endpoint',
    PSFN_SHAKEDOWN_HUB_SATELLITE_ID: 'hub-satellite',
    PSFN_SHAKEDOWN_HUB_SATELLITE_ENDPOINT_ID: 'hub-endpoint',
    PSFN_SHAKEDOWN_HUB_SATELLITE_SESSION_ID: 'hub-session',
  };
  const cases = buildSprint10Cases(context, services, env);
  const expected = new Map([
    ['s10_places_physical', {
      satelliteId: 'physical-satellite',
      endpointId: 'physical-endpoint',
      satelliteSessionId: 'physical-session',
    }],
    ['s10_places_placeless', {
      satelliteId: 'placeless-satellite',
      endpointId: 'placeless-endpoint',
      satelliteSessionId: 'placeless-session',
    }],
    ['s10_mindspace_physical_precedence', {
      satelliteId: 'physical-satellite',
      endpointId: 'physical-endpoint',
      satelliteSessionId: 'physical-session',
    }],
    ['s10_hub_identity_presence_follow', {
      satelliteId: 'hub-satellite',
      endpointId: 'hub-endpoint',
      satelliteSessionId: 'hub-session',
    }],
  ]);

  for (const [caseId, claim] of expected) {
    const testCase = cases.find((entry) => entry.id === caseId);
    const dispatch = prepareCaseChatDispatch({
      defaultApiKey: services.apiKey,
      defaultApiUserId: context.primaryApiUserId,
      resolveDispatchAuth: testCase.resolveDispatchAuth,
      sessionId: testCase.sessionId,
      privacy: 'private',
      extraHeaders: testCase.headers,
    });

    assert.equal(dispatch.headers.Authorization, `Bearer ${physicalKey}`);
    assert.equal(dispatch.apiUserId, deriveApiKeyPrincipalId(physicalKey));
    assert.equal(dispatch.headers['X-PSFN-Satellite-Claim-Type'], 'satellite-endpoint');
    assert.equal(dispatch.headers['X-PSFN-Satellite-ID'], claim.satelliteId);
    assert.equal(dispatch.headers['X-PSFN-Satellite-Endpoint-ID'], claim.endpointId);
    assert.equal(dispatch.headers['X-PSFN-Satellite-Session-ID'], claim.satelliteSessionId);
    assert.equal(dispatch.requestSummary.headers.Authorization, undefined);
    assert.equal(JSON.stringify(dispatch.requestSummary).includes(physicalKey), false);
    assert.equal(JSON.stringify(testCase).includes(physicalKey), false);
  }
});

test('ordinary cases retain harness auth and satellite cases fail closed without their bearer', () => {
  const cases = buildSprint10Cases(context, services, {});
  const ordinaryCase = cases.find((entry) => entry.id === 's10_mindspace_virtual');
  const ordinaryDispatch = prepareCaseChatDispatch({
    defaultApiKey: services.apiKey,
    defaultApiUserId: context.primaryApiUserId,
    resolveDispatchAuth: ordinaryCase.resolveDispatchAuth,
    sessionId: ordinaryCase.sessionId,
    privacy: 'private',
    extraHeaders: ordinaryCase.headers,
  });
  assert.equal(ordinaryDispatch.headers.Authorization, `Bearer ${services.apiKey}`);
  assert.equal(ordinaryDispatch.apiUserId, context.primaryApiUserId);
  assert.throws(
    () => prepareCaseChatDispatch({
      defaultApiKey: services.apiKey,
      defaultApiUserId: context.primaryApiUserId,
      sessionId: ordinaryCase.sessionId,
      extraHeaders: { Authorization: 'Bearer caller-selected-key' },
    }),
    /must not override Authorization/u,
  );
  for (const malformed of [
    null,
    {},
    { apiKey: 'fixture-satellite-key-1234' },
    { apiUserId: 'satellite-user' },
  ]) {
    assert.throws(
      () => prepareCaseChatDispatch({
        defaultApiKey: services.apiKey,
        defaultApiUserId: context.primaryApiUserId,
        resolveDispatchAuth: () => malformed,
        sessionId: ordinaryCase.sessionId,
      }),
      /satellite dispatch auth resolver must return complete auth/ui,
    );
  }

  const physicalCase = cases.find((entry) => entry.id === 's10_places_physical');
  assert.throws(
    () => physicalCase.resolveDispatchAuth(),
    (error) => (
      error?.name === 'MissingEnvError'
      && error?.variable === 'PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_API_KEY'
    ),
  );

  const weakBearerCases = buildSprint10Cases(context, services, {
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_API_KEY: 'too-short',
  });
  const weakBearerCase = weakBearerCases.find((entry) => entry.id === 's10_places_physical');
  assert.throws(
    () => weakBearerCase.resolveDispatchAuth(),
    (error) => (
      error?.name === 'InvalidEnvError'
      && error?.variable === 'PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_API_KEY'
    ),
  );
});

test('Hub-device dispatch resolves a fresh assertion per attempt without persisting it', () => {
  let attempt = 0;
  const dispatch = prepareCaseChatDispatch({
    defaultApiKey: 'fixture-satellite-key-1234',
    defaultApiUserId: 'api-key-fixture',
    sessionId: 'hub-session',
    extraHeaders: {
      'X-PSFN-Satellite-ID': 'hub-satellite',
    },
    resolveAttemptHeaders: () => ({
      'X-PSFN-Hub-Device-Assertion': `header.claims.signature-${++attempt}`,
    }),
  });

  assert.equal(
    dispatch.resolveHeaders()['X-PSFN-Hub-Device-Assertion'],
    'header.claims.signature-1',
  );
  assert.equal(
    dispatch.resolveHeaders()['X-PSFN-Hub-Device-Assertion'],
    'header.claims.signature-2',
  );
  assert.equal(JSON.stringify(dispatch.requestSummary).includes('header.claims.signature'), false);
});

test('satellite cases bind canonical assertions to their exact enrolled endpoint/session', () => {
  const issueCalls = [];
  const env = {
    COMPANION_ID: '11111111-1111-4111-8111-111111111111',
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_API_KEY: 'fixture-physical-satellite-key',
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_CLAIM_TYPE: 'satellite-endpoint',
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_ID: 'physical-satellite',
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_ENDPOINT_ID: 'physical-endpoint',
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_SESSION_ID: 'physical-session',
    PSFN_SHAKEDOWN_PLACELESS_SATELLITE_CLAIM_TYPE: 'satellite-endpoint',
    PSFN_SHAKEDOWN_PLACELESS_SATELLITE_ID: 'placeless-satellite',
    PSFN_SHAKEDOWN_PLACELESS_SATELLITE_ENDPOINT_ID: 'placeless-endpoint',
    PSFN_SHAKEDOWN_PLACELESS_SATELLITE_SESSION_ID: 'placeless-session',
    PSFN_SHAKEDOWN_HUB_SATELLITE_CLAIM_TYPE: 'satellite-endpoint',
    PSFN_SHAKEDOWN_HUB_SATELLITE_ID: 'hub-satellite',
    PSFN_SHAKEDOWN_HUB_SATELLITE_ENDPOINT_ID: 'hub-endpoint',
    PSFN_SHAKEDOWN_HUB_SATELLITE_SESSION_ID: 'hub-session',
  };
  const cases = buildSprint10Cases(context, {
    ...services,
    issueHubDeviceAssertion: (input) => {
      issueCalls.push(input);
      return `header.claims.signature-${issueCalls.length}`;
    },
  }, env);
  const expected = new Map([
    ['s10_places_physical', {
      satelliteId: 'physical-satellite', endpointId: 'physical-endpoint',
      sessionId: 'physical-session',
    }],
    ['s10_places_placeless', {
      satelliteId: 'placeless-satellite', endpointId: 'placeless-endpoint',
      sessionId: 'placeless-session',
    }],
    ['s10_mindspace_physical_precedence', {
      satelliteId: 'physical-satellite', endpointId: 'physical-endpoint',
      sessionId: 'physical-session',
    }],
    ['s10_hub_identity_presence_follow', {
      satelliteId: 'hub-satellite', endpointId: 'hub-endpoint',
      sessionId: 'hub-session',
    }],
  ]);

  for (const [caseId, binding] of expected) {
    const testCase = cases.find((entry) => entry.id === caseId);
    const dispatch = prepareCaseChatDispatch({
      defaultApiKey: services.apiKey,
      defaultApiUserId: context.primaryApiUserId,
      resolveDispatchAuth: testCase.resolveDispatchAuth,
      resolveAttemptHeaders: testCase.resolveAttemptHeaders,
      sessionId: testCase.sessionId,
      extraHeaders: testCase.headers,
    });
    const headers = dispatch.resolveHeaders();
    assert.match(headers['X-PSFN-Hub-Device-Assertion'], /^header\.claims\.signature-/u);
    assert.deepEqual(issueCalls.at(-1), {
      companionId: env.COMPANION_ID,
      satelliteId: binding.satelliteId,
      endpointId: binding.endpointId,
      sessionId: binding.sessionId,
    });
    assert.equal(JSON.stringify(dispatch.requestSummary).includes('header.claims.signature'), false);
  }
});

test('hub presence telemetry uses the enrolled satellite bearer and keeps it out of proof data', async () => {
  const physicalKey = 'fixture-physical-satellite-key';
  const env = {
    COMPANION_ID: '11111111-1111-4111-8111-111111111111',
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_API_KEY: physicalKey,
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_CLAIM_TYPE: 'satellite-endpoint',
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_ID: 'physical-satellite',
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_ENDPOINT_ID: 'physical-endpoint',
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_SESSION_ID: 'physical-session',
    PSFN_SHAKEDOWN_HUB_SATELLITE_CLAIM_TYPE: 'satellite-endpoint',
    PSFN_SHAKEDOWN_HUB_SATELLITE_ID: 'hub-satellite',
    PSFN_SHAKEDOWN_HUB_SATELLITE_ENDPOINT_ID: 'hub-endpoint',
    PSFN_SHAKEDOWN_HUB_SATELLITE_SESSION_ID: 'hub-session',
  };
  const requests = [];
  const hubServices = {
    ...services,
    fetchJson: async (url, init = {}) => {
      requests.push({ url, init });
      if (url.endsWith('/api/admin/enrollments')) {
        return { status: 201, body: {} };
      }
      return { status: 202, body: { id: 'telemetry-fixture' } };
    },
    pgAll: async () => [{ place_id: 'living_room' }],
  };
  const hubCase = buildSprint10Cases(context, hubServices, env)
    .find((entry) => entry.id === 's10_hub_identity_presence_follow');
  const beforeChecks = await hubCase.before({});
  const telemetryRequests = requests.filter(
    ({ url }) => url.endsWith('/v1/telemetry/ingest'),
  );

  assert.equal(telemetryRequests.length, 2);
  assert.equal(telemetryRequests[0].init.headers.Authorization, `Bearer ${physicalKey}`);
  assert.equal(telemetryRequests[1].init.headers.Authorization, `Bearer ${physicalKey}`);
  assert.equal(JSON.stringify(beforeChecks).includes(physicalKey), false);
});

test('mindspace probe fails as a named coverage hole when its places fixture is absent', async () => {
  const mindspace = buildSprint10Cases(context, services, {})
    .find((entry) => entry.id === 's10_mindspace_virtual');
  await assert.rejects(
    mindspace.before({}),
    error => error?.name === 'CaseConfigurationError'
      && error.reason === 'missing_fixture:places.json.mindspace',
  );
});

test('CogSec hold language is recognized as a truthful action blocker', () => {
  assert.match(
    'This content looked off, so it is being kept aside for the Operator to look over.',
    ACTION_BLOCKER_PATTERN,
  );
});

test('temporal strip probe echoes the seeded history turn real stamp', () => {
  const seedMessage = 'Temporal strip-guard history witness run-fixture.';
  const previewTurn = {
    observability: {
      snapshot: {
        plan: {
          messages: [
            { role: 'user', content: `[Fri 07-31-26 11:11] ${seedMessage}` },
            { role: 'user', content: `[Fri 07-31-26 12:34] ${seedMessage}` },
          ],
        },
      },
    },
  };
  const prefix = extractRenderedHistoryStamp(previewTurn, seedMessage);

  assert.equal(prefix, '[Fri 07-31-26 12:34]');
  assert.equal(
    buildTemporalMessage(prefix, seedMessage),
    `Quote this previously rendered history line exactly, including its truthful provenance prefix, and output nothing else:\n${prefix} ${seedMessage}`,
  );
  assert.doesNotMatch(buildTemporalMessage(prefix, seedMessage), /current date/iu);
});

test('temporal case uses a run-unique witness and proves the exact strip transformation', async () => {
  const messages = [];
  const stamp = '[Fri 07-31-26 12:34]';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    messages.push(body.messages[0].content);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
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
        const rawResponse = `Here is the exact line:\n${stamp} ${messages[0]}`;
        return {
          turnId: 'main',
          status: 'completed',
          userMessage: { content: message },
          assistantMessage: { content: `Here is the exact line:\n${messages[0]}` },
          observability: { snapshot: {
            plan: { messages: [{ role: 'user', content: `${stamp} ${messages[0]}` }] },
            promptContext: {
              response: { content: rawResponse },
              finalSystemSections: [{
                id: 'runtime.current_datetime',
                content: '<runtime.current_datetime>now</runtime.current_datetime>',
              }],
            },
          } },
        };
      },
    }).find((entry) => entry.id === 's10_temporal_stamp_strip');
    const outcome = await temporal.execute({
      sessionId: temporal.sessionId,
      apiUserId: context.primaryApiUserId,
    });

    assert.match(messages[0], new RegExp(context.runToken, 'u'));
    assert.equal(typeof outcome.busyObservedAtMs, 'number');
    assert.equal(messages[2], buildTemporalMessage(stamp, messages[0]));
    assert.deepEqual(temporal.validatePersistedProof({
      outcome,
      turnRecord: outcome.turnRecord,
    }), []);
    assert.ok(temporal.validatePersistedProof({
      outcome,
      turnRecord: {
        ...outcome.turnRecord,
        assistantMessage: { content: 'a different unstamped reply' },
      },
    }).includes(
      'persisted assistant reply does not equal the raw response after the exact history-stamp strip',
    ));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('satellite CogSec dispatch uses the scoped satellite bearer and binds proof to its real turn', async () => {
  const satelliteKey = 'fixture-satellite-key-1234';
  const env = {
    COMPANION_ID: '11111111-1111-4111-8111-111111111111',
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_API_KEY: satelliteKey,
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_CLAIM_TYPE: 'satellite-endpoint',
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_ID: 'satellite-fixture',
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_ENDPOINT_ID: 'endpoint-fixture',
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_SESSION_ID: 'session-fixture',
  };
  const expectedPrincipalId = deriveApiKeyPrincipalId(satelliteKey);
  let requestHeaders = null;
  let waitOptions = null;
  const realTurn = {
    turnId: 'satellite-turn-1',
    status: 'completed',
    location: { satelliteId: 'satellite-fixture' },
    userMessage: { content: 'Please inspect the attached synthetic satellite security fixture.' },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    requestHeaders = init?.headers ?? null;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const cases = buildSprint10Cases(context, {
      ...services,
      issueHubDeviceAssertion: () => 'header.claims.signature',
      waitForTurnRecord: async (options) => {
        waitOptions = options;
        return realTurn;
      },
    }, env);
    const satelliteCase = cases.find(
      (entry) => entry.id === 's10_cogsec_satellite_document_quarantine',
    );
    const outcome = await satelliteCase.execute({
      sessionId: satelliteCase.sessionId,
      apiUserId: context.primaryApiUserId,
    });

    assert.equal(requestHeaders.Authorization, `Bearer ${satelliteKey}`);
    assert.equal(requestHeaders['X-PSFN-Hub-Device-Assertion'], 'header.claims.signature');
    assert.equal(requestHeaders['X-PSFN-Channel-Type'], 'satellite.endpoint');
    assert.equal(waitOptions.apiUserId, expectedPrincipalId);
    assert.equal(outcome.apiUserId, expectedPrincipalId);
    assert.equal(outcome.response.status, 200);
    assert.equal(outcome.turnRecord, realTurn);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('satellite CogSec case fails closed when its scoped bearer is absent', async () => {
  const cases = buildSprint10Cases(context, {
    ...services,
    readJsonIfExists: () => ({ mode: 'enforce' }),
  }, {
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_CLAIM_TYPE: 'satellite-endpoint',
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_ID: 'satellite-fixture',
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_ENDPOINT_ID: 'endpoint-fixture',
    PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_SESSION_ID: 'session-fixture',
  });
  const satelliteCase = cases.find(
    (entry) => entry.id === 's10_cogsec_satellite_document_quarantine',
  );

  await assert.rejects(
    satelliteCase.before(),
    (error) => (
      error?.name === 'MissingEnvError'
      && error?.variable === 'PSFN_SHAKEDOWN_PHYSICAL_SATELLITE_API_KEY'
    ),
  );
});

test('API CogSec proof reads the quarantined envelope from its durable current-turn session entry', async () => {
  const runToken = '2026-07-31T12-00-00';
  const caseId = 's10_cogsec_document_quarantine';
  const tokenHash = createHash('sha256').update(`${runToken}:${caseId}`, 'utf8').digest('hex');
  const token = `s10-cogsec-API-${runToken}-${tokenHash.slice(0, 12)}`;
  const envelopeId = 'envelope-current-turn';
  const turnId = 'turn-current';
  const cogSecServices = {
    ...services,
    readJsonIfExists: () => ({
      entries: [{
        id: envelopeId,
        status: 'held',
        rawText: `hostile fixture ${token}`,
        artifactPaths: ['/held/fixture.txt'],
        accessAttempts: [{ path: '/held/fixture.txt', via: 'gateway:fs.read', atMs: 1 }],
        envelope: {
          id: envelopeId,
          state: 'quarantined',
          sourceClass: 'document',
          contentRef: { sha256: 'a'.repeat(64) },
        },
      }],
    }),
    pgAll: async () => [
      { kind: 'emotion_appraisal', state: 'succeeded', reason_code: 'completed' },
      { kind: 'memory_extraction', state: 'succeeded', reason_code: 'completed' },
    ],
    pgScalar: async () => 0,
    fetchJson: async (url) => {
      if (url.endsWith('/confirm')) {
        return { status: 200, body: { confirmToken: 'confirm-current' } };
      }
      if (url.endsWith('/decide')) {
        return { status: 200, body: { ok: true } };
      }
      return {
        status: 200,
        body: {
          items: [{ id: envelopeId, status: 'held', contentSha256: 'a'.repeat(64) }],
        },
      };
    },
  };
  const apiCase = buildSprint10Cases({ ...context, runToken }, cogSecServices, {})
    .find((entry) => entry.id === caseId);
  const sessionEntries = [
    {
      role: 'user',
      content: 'stale entry without a screening envelope',
      metadata: JSON.stringify({ turn: { turnId: 'turn-stale' } }),
    },
    {
      role: 'user',
      content: 'This content is being kept aside for your human to look over.',
      metadata: JSON.stringify({
        turn: { turnId },
        intakeScreening: {
          withheld: true,
          envelopes: [{ envelopeId, state: 'quarantined' }],
        },
      }),
    },
  ];
  const outcome = {
    apiUserId: context.primaryApiUserId,
    response: { status: 200 },
    turnRecord: {
      turnId,
      location: null,
      userMessage: { content: 'snapshot deliberately lacks the current session envelope' },
      assistantMessage: { content: 'I could not inspect the quarantined attachment.' },
      toolCalls: [{
        toolName: 'fs',
        outcome: 'error',
        resultText: 'This content is being kept aside for your human to look over.',
      }],
      snapshot: {
        sessionContext: {
          recentEntries: [{
            role: 'user',
            content: 'wrong source',
            metadata: JSON.stringify({ turn: { turnId: 'turn-stale' } }),
          }],
        },
      },
    },
  };

  const sideChecks = await apiCase.after({
    outcome,
    sessionEntries,
    gatewayAuditRows: [{
      method: 'fs.read',
      decision: 'ALLOW',
      params_json: JSON.stringify({ path: '/held/fixture.txt' }),
      error: 'This content is being kept aside for your human to look over.',
    }],
  });
  assert.deepEqual(apiCase.validatePersistedProof({ sideChecks }), []);
  assert.deepEqual(sideChecks.cogsec.session, {
    found: true,
    withheld: true,
    envelopeState: 'quarantined',
    fixedNoticePresent: true,
    locatorsAbsent: true,
  });
  assert.deepEqual(sideChecks.cogsec.containment, {
    assistantReplyFound: true,
    replyMarkerAbsent: true,
    toolResultMarkerAbsent: true,
    successfulRawReadCount: 0,
    gatewayReadAuditCount: 1,
    targetedReadAttemptCount: 1,
    unexpectedContentReadAuditCount: 0,
    unexpectedToolCallCount: 0,
    readToolCallCount: 1,
    queuedAccessAttemptCount: 1,
  });
});
