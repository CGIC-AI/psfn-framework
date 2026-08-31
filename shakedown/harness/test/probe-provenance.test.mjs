import assert from 'node:assert/strict';
import test from 'node:test';

import {
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
