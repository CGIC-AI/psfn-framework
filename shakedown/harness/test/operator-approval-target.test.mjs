import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveOperatorApprovalTarget,
  resolveOperatorApprovalTargetForCases,
} from '../lib/operator-approval-target.mjs';

const KUBE_ENV = {
  PSFN_TARGET: 'kube',
  PSFN_API_BASE: 'https://gateway.example.test',
  TESTING_HARNESS_API_KEY: 'testing-harness-key',
  ADMIN_TOKEN: 'independent-operator-token',
  POSTGRES_DATABASE_URL: 'postgres://unused',
  COMPANION_ID: '22222222-2222-4222-8222-222222222222',
};

test('standard SSO shakedown env resolves independent operator approval authority', () => {
  assert.deepEqual(resolveOperatorApprovalTarget({
    chatBaseUrl: KUBE_ENV.PSFN_API_BASE,
    apiKey: KUBE_ENV.TESTING_HARNESS_API_KEY,
  }, KUBE_ENV), {
    apiBaseUrl: 'https://gateway.example.test/v1',
    adminToken: 'independent-operator-token',
  });
});

test('testing-harness chat authority cannot double as operator approval authority', () => {
  const env = {
    ...KUBE_ENV,
    ADMIN_TOKEN: KUBE_ENV.TESTING_HARNESS_API_KEY,
  };

  assert.throws(
    () => resolveOperatorApprovalTarget({
      chatBaseUrl: env.PSFN_API_BASE,
      apiKey: env.TESTING_HARNESS_API_KEY,
    }, env),
    /independent from TESTING_HARNESS_API_KEY/u,
  );
});

test('operator approval fails closed when no independent credential is configured', () => {
  const {
    ADMIN_TOKEN: _adminToken,
    ...env
  } = KUBE_ENV;

  assert.throws(
    () => resolveOperatorApprovalTarget({
      chatBaseUrl: env.PSFN_API_BASE,
      apiKey: env.TESTING_HARNESS_API_KEY,
    }, env),
    /Missing required environment variable: PSFN_OPERATOR_ADMIN_TOKEN/u,
  );
});

test('explicit private Operator overrides take precedence', () => {
  const env = {
    ...KUBE_ENV,
    PSFN_OPERATOR_API_BASE: 'https://operator.example.test/',
    PSFN_OPERATOR_ADMIN_TOKEN: 'overridden-operator-token',
  };

  assert.deepEqual(resolveOperatorApprovalTarget({
    chatBaseUrl: env.PSFN_API_BASE,
    apiKey: env.TESTING_HARNESS_API_KEY,
  }, env), {
    apiBaseUrl: 'https://operator.example.test/',
    adminToken: 'overridden-operator-token',
  });
});

test('memory delete/restore selection preflights Operator authority', () => {
  const {
    ADMIN_TOKEN: _adminToken,
    ...env
  } = KUBE_ENV;

  assert.throws(
    () => resolveOperatorApprovalTargetForCases({
      chatBaseUrl: env.PSFN_API_BASE,
      apiKey: env.TESTING_HARNESS_API_KEY,
    }, {
      caseIds: new Set(['memory_delete_restore']),
      phase: 'autonomous',
    }, env),
    /Missing required environment variable: PSFN_OPERATOR_ADMIN_TOKEN/u,
  );
});

test('a focused non-HITL case does not require Operator authority', () => {
  const {
    ADMIN_TOKEN: _adminToken,
    ...env
  } = KUBE_ENV;

  assert.equal(resolveOperatorApprovalTargetForCases({
    chatBaseUrl: env.PSFN_API_BASE,
    apiKey: env.TESTING_HARNESS_API_KEY,
  }, {
    caseIds: new Set(['memory_write_patch']),
    phase: 'apprentice',
  }, env), null);
});

test('an unfiltered non-autonomous phase does not require Operator authority', () => {
  const {
    ADMIN_TOKEN: _adminToken,
    ...env
  } = KUBE_ENV;

  assert.equal(resolveOperatorApprovalTargetForCases({
    chatBaseUrl: env.PSFN_API_BASE,
    apiKey: env.TESTING_HARNESS_API_KEY,
  }, {
    caseIds: new Set(),
    phase: 'baseline',
  }, env), null);
});

test('an unfiltered autonomous phase preflights Operator authority', () => {
  const {
    ADMIN_TOKEN: _adminToken,
    ...env
  } = KUBE_ENV;

  assert.throws(
    () => resolveOperatorApprovalTargetForCases({
      chatBaseUrl: env.PSFN_API_BASE,
      apiKey: env.TESTING_HARNESS_API_KEY,
    }, {
      caseIds: new Set(),
      phase: 'autonomous',
    }, env),
    /Missing required environment variable: PSFN_OPERATOR_ADMIN_TOKEN/u,
  );
});
