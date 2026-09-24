// 7wa3d: a malformed answer with readable values is judged on its values; the
// malformation is recorded as companion feedback, never as a failure.
import assert from 'node:assert/strict';
import test from 'node:test';

import { malformedAnswerFeedback, readAssistantAnswer } from '../lib/assistant-answer.mjs';

test('a clean JSON answer (fenced or bare) carries no malformation', () => {
  for (const text of ['{"result":391,"method":"mental"}', '```json\n{"result":391,"method":"mental"}\n```']) {
    assert.deepEqual(readAssistantAnswer(text), {
      value: { result: 391, method: 'mental' },
      malformation: null,
    });
  }
});

test('duplicate keys are read as JSON.parse reads them and reported verbatim', () => {
  const answer = readAssistantAnswer('{"result": 391, "method": "mental", "result": 391}');
  assert.equal(answer.value.result, 391);
  assert.deepEqual(answer.malformation, {
    reason: 'duplicate_keys',
    duplicateKeys: { result: ['391', '391'] },
  });
  assert.deepEqual(malformedAnswerFeedback(answer.malformation), [{
    kind: 'malformed_answer',
    value: answer.malformation,
  }]);
});

test('nested duplicate keys are reported with their path', () => {
  const answer = readAssistantAnswer('{"outer": {"a": 1, "a": 2}, "b": "x,}{"}');
  assert.deepEqual(answer.value, { outer: { a: 2 }, b: 'x,}{' });
  assert.deepEqual(answer.malformation, {
    reason: 'duplicate_keys',
    duplicateKeys: { 'outer.a': ['1', '2'] },
  });
});

test('prose around the object and a second object still yield the first answer', () => {
  const surrounded = readAssistantAnswer('Sure! {"result": 391, "method": "17*23"} Hope that helps.');
  assert.deepEqual(surrounded.value, { result: 391, method: '17*23' });
  assert.equal(surrounded.malformation.reason, 'surrounding_text');

  const twice = readAssistantAnswer('{"result": 391, "method": "a"}\n{"result": 391, "method": "b", "result": 391}');
  assert.deepEqual(twice.value, { result: 391, method: 'a' });
  assert.deepEqual(twice.malformation, {
    reason: 'multiple_objects', objectCount: 2, parsedObjectCount: 2,
  });
});

test('an answer with no parseable object stays null so required values still fail', () => {
  assert.deepEqual(readAssistantAnswer('The answer is 391.'), {
    value: null,
    malformation: { reason: 'unparseable', objectCount: 0 },
  });
  assert.deepEqual(readAssistantAnswer('{"result": 391,, }'), {
    value: null,
    malformation: { reason: 'unparseable', objectCount: 1 },
  });
  assert.deepEqual(readAssistantAnswer('   '), { value: null, malformation: null });
  assert.deepEqual(malformedAnswerFeedback(null), []);
});
