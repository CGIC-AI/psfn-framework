// 7wa3d: honest companion commentary is collected as feedback, never scored.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectAnswerFeedback,
  companionFeedbackDigest,
  normalizeValidatorOutput,
} from '../lib/companion-feedback.mjs';

const PROMPT_STACK_KEYS = {
  requiredKeys: ['layerCount', 'northStarCount', 'settingKeyCount'],
  commentaryKeys: ['confusion'],
};

test('an accurate caveat in confusion becomes feedback, not a failure', () => {
  const caveat = 'north_star list returned count 3 at limit 3, so the count may be capped';
  assert.deepEqual(collectAnswerFeedback({
    layerCount: 18, northStarCount: 3, settingKeyCount: 170, confusion: caveat,
  }, PROMPT_STACK_KEYS), [{ kind: 'commentary', key: 'confusion', value: caveat }]);
});

test('empty commentary and exact answers yield no feedback', () => {
  for (const confusion of ['', '  ', null, false, 0]) {
    assert.deepEqual(collectAnswerFeedback({
      layerCount: 1, northStarCount: 0, settingKeyCount: 1, confusion,
    }, PROMPT_STACK_KEYS), []);
  }
});

test('extra keys beside the required answer are captured verbatim', () => {
  assert.deepEqual(collectAnswerFeedback({
    layerCount: 1, northStarCount: 0, settingKeyCount: 1, suggestion: 'list the limit too',
  }, PROMPT_STACK_KEYS), [{ kind: 'extra_keys', value: { suggestion: 'list the limit too' } }]);
});

test('validator output accepts the legacy array and the feedback object, and rejects anything else', () => {
  assert.deepEqual(normalizeValidatorOutput(['x']), { failures: ['x'], feedback: [] });
  assert.deepEqual(normalizeValidatorOutput(undefined), { failures: [], feedback: [] });
  assert.deepEqual(
    normalizeValidatorOutput({ failures: [], feedback: [{ kind: 'commentary', key: 'c', value: 'v' }] }),
    { failures: [], feedback: [{ kind: 'commentary', key: 'c', value: 'v' }] },
  );
  assert.throws(() => normalizeValidatorOutput('oops'), TypeError);
});

test('the run-level digest tags each entry with its case id', () => {
  assert.deepEqual(companionFeedbackDigest([
    { caseId: 'prompt_stack', companionFeedback: [{ kind: 'commentary', key: 'confusion', value: 'hm' }] },
    { caseId: 'l0_baseline' },
  ]), [{ caseId: 'prompt_stack', kind: 'commentary', key: 'confusion', value: 'hm' }]);
});
