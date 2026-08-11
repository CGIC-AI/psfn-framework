import assert from 'node:assert/strict';
import test from 'node:test';

import { validateAttestedPublication } from './pre-push.mjs';

test('attested publication validates the same change-budget plan used by the publisher', () => {
  let validationOptions;
  const allowed = validateAttestedPublication('work/exception', {
    env: {
      PSFN_ATTESTED_PUBLISH: '1',
      CHANGE_BUDGET_EXCEPTION: 'true',
    },
    gitCommand: () => 'origin/main',
    resolveGateState: ({ baseRef }) => ({
      baseRef,
      attestationPath: '/tmp/attestation.json',
    }),
    readGateAttestation: () => ({ schemaVersion: 3 }),
    validateGateAttestation: (_attestation, _state, options) => {
      validationOptions = options;
      return { result: { valid: true, reason: '' } };
    },
  });

  assert.equal(allowed, true);
  assert.deepEqual(validationOptions, { changeBudgetException: true });
});

test('ordinary checkpoint pushes do not enter attested publication validation', () => {
  const allowed = validateAttestedPublication('work/checkpoint', {
    env: {},
    gitCommand: () => {
      throw new Error('git must not run');
    },
  });

  assert.equal(allowed, false);
});
