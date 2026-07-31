import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { deriveApiKeyPrincipalId } from '../lib/probe.mjs';
import {
  SPRINT10_CASE_IDS,
  buildSprint10Cases,
} from '../cases/sprint10.mjs';
import {
  buildTemporalMessage,
  extractRenderedHistoryStamp,
} from '../cases/sprint10/conversation.mjs';

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

test('temporal strip probe echoes the seeded history turn real stamp', () => {
  const seedMessage = 'Remember that this is the first turn of the temporal rendering probe.';
  const previewTurn = {
    observability: {
      snapshot: {
        plan: {
          messages: [{
            role: 'user',
            content: `[Fri 07-31-26 12:34] ${seedMessage}`,
          }],
        },
      },
    },
  };
  const prefix = extractRenderedHistoryStamp(previewTurn, seedMessage);

  assert.equal(prefix, '[Fri 07-31-26 12:34]');
  assert.match(buildTemporalMessage(prefix), /\[Fri 07-31-26 12:34\]/u);
  assert.doesNotMatch(buildTemporalMessage(prefix), /07-17-26/u);
});

test('satellite CogSec dispatch uses the scoped satellite bearer and binds proof to its real turn', async () => {
  const satelliteKey = 'fixture-satellite-key-1234';
  const env = {
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

  const sideChecks = await apiCase.after({ outcome, sessionEntries });
  assert.deepEqual(apiCase.validatePersistedProof({ sideChecks }), []);
  assert.deepEqual(sideChecks.cogsec.session, {
    found: true,
    withheld: true,
    envelopeState: 'quarantined',
    fixedNoticePresent: true,
  });
});
