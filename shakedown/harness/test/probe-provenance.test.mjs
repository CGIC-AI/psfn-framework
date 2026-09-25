import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPANION_SELECTOR_HEADER,
  createChatHeaderBuilder,
  TESTING_HARNESS_MANIFEST_ID_HEADER,
  TESTING_HARNESS_RUN_ID_HEADER,
  testingHarnessProvenanceHeaders,
  withTestingHarnessProvenance,
} from '../lib/probe.mjs';

test('provenance header names match the framework gateway contract', () => {
  // src/shared/contracts/testing-harness.ts in the public framework reads
  // exactly these wire names; a rename silently drops run provenance.
  assert.equal(TESTING_HARNESS_RUN_ID_HEADER, 'x-testing-harness-run-id');
  assert.equal(TESTING_HARNESS_MANIFEST_ID_HEADER, 'x-testing-harness-manifest-id');
});

test('testing harness provenance headers omit empty ids', () => {
  assert.deepEqual(testingHarnessProvenanceHeaders(), {});
  assert.deepEqual(testingHarnessProvenanceHeaders({ runId: '  ', manifestId: '' }), {});
});

test('testing harness provenance headers attach trimmed run and manifest ids', () => {
  assert.deepEqual(testingHarnessProvenanceHeaders({
    runId: ' run-1 ',
    manifestId: ' shakedown:apprentice:run-1 ',
  }), {
    [TESTING_HARNESS_RUN_ID_HEADER]: 'run-1',
    [TESTING_HARNESS_MANIFEST_ID_HEADER]: 'shakedown:apprentice:run-1',
  });
});

test('case-supplied headers cannot override testing harness provenance', () => {
  const merged = withTestingHarnessProvenance({
    'x-custom': 'kept',
    [TESTING_HARNESS_RUN_ID_HEADER]: 'forged-run',
    [TESTING_HARNESS_MANIFEST_ID_HEADER]: 'forged-manifest',
  }, {
    runId: 'run-1',
    manifestId: 'shakedown:apprentice:run-1',
  });
  assert.deepEqual(merged, {
    'x-custom': 'kept',
    [TESTING_HARNESS_RUN_ID_HEADER]: 'run-1',
    [TESTING_HARNESS_MANIFEST_ID_HEADER]: 'shakedown:apprentice:run-1',
  });
});

// psfn-framework-gz50o: the kube harness targets one fleet companion for chat.
test('the companion selector header matches the framework gateway contract', () => {
  // src/channels/api/server/bearer-companion-selector.ts BEARER_COMPANION_SELECTOR_HEADER
  assert.equal(COMPANION_SELECTOR_HEADER, 'x-psfn-companion-id');
});

test('a companion-bound builder selects that companion on every harness dispatch', () => {
  const follower = '22222222-2222-4222-8222-222222222222';
  const chatHeaders = createChatHeaderBuilder({
    apiKey: 'harness-key',
    runId: 'run-1',
    manifestId: 'shakedown:baseline:run-1',
    companionId: follower.toUpperCase(),
  });
  const headers = chatHeaders({
    sessionId: 's',
    extra: { 'X-PSFN-Companion-ID': '11111111-1111-4111-8111-111111111111' },
  });
  assert.equal(headers[COMPANION_SELECTOR_HEADER], follower);
  assert.equal(headers['X-PSFN-Companion-ID'], undefined);
  assert.equal(headers.Authorization, 'Bearer harness-key');
});

test('a dispatch under another credential never carries the harness selector', () => {
  const chatHeaders = createChatHeaderBuilder({
    apiKey: 'harness-key',
    runId: 'run-1',
    manifestId: 'shakedown:baseline:run-1',
    companionId: '22222222-2222-4222-8222-222222222222',
  });
  const headers = chatHeaders({ apiKey: 'satellite-key', sessionId: 's' });
  assert.equal(headers[COMPANION_SELECTOR_HEADER], undefined);
  assert.equal(headers.Authorization, 'Bearer satellite-key');
});

test('an unbound builder keeps pinned routing', () => {
  const headers = createChatHeaderBuilder({ apiKey: 'k', runId: 'r', manifestId: 'm' })({ sessionId: 's' });
  assert.equal(headers[COMPANION_SELECTOR_HEADER], undefined);
});

test('a malformed companion id fails closed at builder creation', () => {
  assert.throws(
    () => createChatHeaderBuilder({ apiKey: 'k', runId: 'r', manifestId: 'm', companionId: 'vega' }),
    /companionId must be an RFC 4122 UUID/,
  );
});
