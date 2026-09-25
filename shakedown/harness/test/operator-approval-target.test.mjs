import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOperatorConfirmationApproval,
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
    companionId: KUBE_ENV.COMPANION_ID,
  }, KUBE_ENV), {
    apiBaseUrl: 'https://gateway.example.test/v1',
    adminToken: 'independent-operator-token',
    companionId: KUBE_ENV.COMPANION_ID,
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
    companionId: env.COMPANION_ID,
  }, env), {
    apiBaseUrl: 'https://operator.example.test/',
    adminToken: 'overridden-operator-token',
    companionId: KUBE_ENV.COMPANION_ID,
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

test('fleet approval resolves the target companion and sends it to the resolver', () => {
  const approvalTarget = resolveOperatorApprovalTarget({
    chatBaseUrl: KUBE_ENV.PSFN_API_BASE,
    apiKey: KUBE_ENV.TESTING_HARNESS_API_KEY,
    companionId: '33333333-3333-4333-8333-333333333333',
  }, KUBE_ENV);
  assert.equal(approvalTarget.companionId, '33333333-3333-4333-8333-333333333333');

  const approval = buildOperatorConfirmationApproval(approvalTarget, 'confirm-1');
  assert.equal(approval.url, 'https://gateway.example.test/v1/operator/confirmations/resolve');
  assert.equal(approval.headers.Authorization, 'Bearer independent-operator-token');
  assert.deepEqual(JSON.parse(approval.body), {
    id: 'confirm-1',
    decision: 'approve',
    companionId: '33333333-3333-4333-8333-333333333333',
  });
});

test('single-companion local approval omits companionId even when COMPANION_ID is set', () => {
  const approvalTarget = resolveOperatorApprovalTarget({
    chatBaseUrl: KUBE_ENV.PSFN_API_BASE,
    apiKey: KUBE_ENV.TESTING_HARNESS_API_KEY,
    companionId: null,
  }, KUBE_ENV);
  assert.equal(approvalTarget.companionId, null);
  assert.deepEqual(
    JSON.parse(buildOperatorConfirmationApproval(approvalTarget, 'confirm-2').body),
    { id: 'confirm-2', decision: 'approve' },
  );
});

test('a malformed approval companionId fails closed', () => {
  assert.throws(
    () => resolveOperatorApprovalTarget({
      chatBaseUrl: KUBE_ENV.PSFN_API_BASE,
      apiKey: KUBE_ENV.TESTING_HARNESS_API_KEY,
      companionId: 'not-a-uuid',
    }, KUBE_ENV),
    /RFC 4122/u,
  );
});
