import assert from 'node:assert/strict';
import test from 'node:test';

import { validateMemoryLookupAnswer } from '../lib/memory-lookup-answer.mjs';

const CASE_ID = 'analysis_workbench_memory_lookup_avoidance';

test('an honest empty lookup passes with a null or empty summary', () => {
  assert.deepEqual(validateMemoryLookupAnswer({ count: 0, summary: null }, CASE_ID), []);
  assert.deepEqual(validateMemoryLookupAnswer({ count: 0, summary: '' }, CASE_ID), []);
  assert.deepEqual(validateMemoryLookupAnswer({ count: 0 }, CASE_ID), []);
  assert.deepEqual(validateMemoryLookupAnswer({ count: 0, summary: 'No matching memories.' }, CASE_ID), []);
});

test('a positive count still requires a non-empty summary', () => {
  assert.deepEqual(validateMemoryLookupAnswer({ count: 2, summary: 'Two notes about the principal.' }, CASE_ID), []);
  assert.deepEqual(
    validateMemoryLookupAnswer({ count: 2, summary: null }, CASE_ID),
    [`${CASE_ID} summary must be non-empty when count is positive`],
  );
});

test('a missing, negative, or fractional count fails', () => {
  for (const parsed of [null, {}, { count: '0' }, { count: -1 }, { count: 1.5 }]) {
    assert.deepEqual(
      validateMemoryLookupAnswer(parsed, CASE_ID),
      [`${CASE_ID} count must be a non-negative integer`],
    );
  }
});

test('an empty result with a non-string summary fails', () => {
  assert.deepEqual(
    validateMemoryLookupAnswer({ count: 0, summary: { text: 'x' } }, CASE_ID),
    [`${CASE_ID} summary must be a string or null for an empty result`],
  );
});
