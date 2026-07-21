import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { validateToolReport } from './check-local-tools.mjs';
import { normalizeAliasValue } from './install-local-hooks.mjs';
import {
  REMOTE_ATTESTATION_CONTEXT,
  assessHookInstallation,
  buildValidatedPushRefspec,
  buildGatePlan,
  createAttestation,
  evaluateRequiredChecks,
  planPrePush,
  validateAttestation,
  validateRemoteAttestation,
} from './local-delivery-contract.mjs';
import { runLocalGate } from './run-local-gate.mjs';
import { validateZizmorInputs } from './run-zizmor-changed.mjs';
import { waitForRemoteAttestation } from './verify-pr-attestation.mjs';

const HEAD = '1111111111111111111111111111111111111111';
const BASE = '2222222222222222222222222222222222222222';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function pushUpdate(remoteRef, localSha = HEAD) {
  return { localSha, localRef: localSha === '0'.repeat(40) ? '(delete)' : 'HEAD', remoteRef, remoteSha: BASE };
}

function makeGateRepository() {
  const cwd = mkdtempSync(join(tmpdir(), 'local-delivery-gate-'));
  git(cwd, 'init', '--quiet');
  git(cwd, 'config', 'user.email', 'ci@example.invalid');
  git(cwd, 'config', 'user.name', 'CI Test');
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src/seed.ts'), 'export const seed = true;\n');
  git(cwd, 'add', 'src/seed.ts');
  git(cwd, 'commit', '--quiet', '-m', 'seed');
  const base = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'switch', '--quiet', '-c', 'feature');
  writeFileSync(join(cwd, 'src/feature.ts'), 'export const feature = true;\n');
  git(cwd, 'add', 'src/feature.ts');
  git(cwd, 'commit', '--quiet', '-m', 'feature');
  return { cwd, base };
}

test('attestation is valid only for the exact clean head and base', () => {
  const gates = ['change-budget', 'tests', 'semgrep'];
  const attestation = createAttestation({
    head: HEAD,
    base: BASE,
    baseRef: 'origin/main',
    gates,
  });

  assert.deepEqual(validateAttestation(attestation, { head: HEAD, base: BASE, gates }), {
    valid: true,
    reason: '',
  });
  assert.match(
    validateAttestation(attestation, { head: `0${HEAD.slice(1)}`, base: BASE, gates }).reason,
    /head/i,
  );
  assert.match(
    validateAttestation(attestation, { head: HEAD, base: `0${BASE.slice(1)}`, gates }).reason,
    /base/i,
  );
  assert.match(validateAttestation(attestation, { head: HEAD, base: BASE, gates: ['fake'] }).reason, /gate plan/i);
});

test('pre-push blocks direct main, skips deletions, reuses exact attestations, and never recurses', () => {
  assert.deepEqual(
    planPrePush({
      updates: [pushUpdate('refs/heads/main')],
      head: HEAD,
      currentBranch: 'feature',
      attestationValid: false,
      gateActive: false,
    }),
    { action: 'block', reason: 'Direct pushes to main are prohibited.' },
  );
  assert.deepEqual(
    planPrePush({
      updates: [pushUpdate('refs/heads/old', '0'.repeat(40))],
      head: HEAD,
      currentBranch: 'feature',
      attestationValid: false,
      gateActive: false,
    }),
    { action: 'allow', reason: 'No branch update requires validation.' },
  );
  assert.equal(
    planPrePush({
      updates: [pushUpdate('refs/heads/feature')],
      head: HEAD,
      currentBranch: 'feature',
      attestationValid: true,
      gateActive: false,
    }).action,
    'allow',
  );
  assert.equal(
    planPrePush({
      updates: [pushUpdate('refs/heads/feature')],
      head: HEAD,
      currentBranch: 'feature',
      attestationValid: false,
      gateActive: false,
    }).action,
    'run-gate',
  );
  assert.deepEqual(
    planPrePush({
      updates: [pushUpdate('refs/heads/feature')],
      head: HEAD,
      currentBranch: 'feature',
      attestationValid: false,
      gateActive: true,
    }),
    {
      action: 'block',
      reason: 'Local gate recursion detected without a valid exact-HEAD attestation.',
    },
  );
});

test('delivery-only gate stays fast while product changes retain full validation', () => {
  const deliveryPlan = buildGatePlan({
    paths: [
      '.github/workflows/ci.yml',
      'README.md',
      'scripts/ci/local-delivery-contract.mjs',
    ],
  });
  const deliveryNames = deliveryPlan
    .filter(({ skip }) => !skip)
    .map(({ name }) => name);

  assert.deepEqual(deliveryNames, [
    'ci-rules',
    'change-budget',
    'lint-changed',
    'semgrep-diff',
    'ubs',
    'changed-workflow-analysis',
  ]);
  assert.ok(
    buildGatePlan({ paths: ['README.md'], changeBudgetException: true })
      .find(({ name }) => name === 'change-budget')
      .args.includes('--exception'),
  );

  for (const [path, specialist] of [
    ['admin-ui/src/routes/+page.svelte', 'garden-ui'],
    ['companion-ui/src/App.tsx', 'companion-ui'],
    ['deploy/helm/psfn/values.yaml', 'deployment-contracts'],
  ]) {
    const names = buildGatePlan({ paths: [path] })
      .filter(({ skip }) => !skip)
      .map(({ name }) => name);
    assert.ok(names.includes(specialist), `${path} must run ${specialist}`);
    for (const rootGate of ['lint', 'build', 'typecheck', 'repository-hygiene', 'tests']) {
      assert.ok(!names.includes(rootGate), `${path} must not run root ${rootGate}`);
    }
  }

  const lockfileNames = buildGatePlan({ paths: ['package-lock.json'] })
    .filter(({ skip }) => !skip)
    .map(({ name }) => name);
  for (const rootGate of ['lint', 'build', 'typecheck', 'repository-hygiene', 'tests']) {
    assert.ok(lockfileNames.includes(rootGate), `root lockfile must run ${rootGate}`);
  }

  const plan = buildGatePlan({
    paths: [
      '.github/workflows/ci.yml',
      '.semgrep/psfn.yml',
      'deploy/helm/psfn/values.yaml',
      'src/system/config/load-config.ts',
    ],
  });
  const names = plan.map(({ name }) => name);

  assert.deepEqual(names.slice(0, 3), ['ci-rules', 'change-budget', 'lint']);
  for (const required of [
    'build',
    'typecheck',
    'repository-hygiene',
    'semgrep-rules',
    'semgrep-diff',
    'ubs',
    'tests',
    'settings-contract',
    'supply-chain',
    'deployment-contracts',
    'changed-workflow-analysis',
  ]) {
    assert.ok(names.includes(required), `missing local gate: ${required}`);
  }
  assert.deepEqual(plan.find(({ name }) => name === 'ubs').args.slice(0, 2), [
    '--no-auto-update',
    '--skip=2',
  ]);
  assert.deepEqual(plan.find(({ name }) => name === 'tests').args, ['test', '--', '--maxWorkers=4']);
  assert.equal(plan.find(({ name }) => name === 'tests').skip, false);

  const deletionPlan = buildGatePlan({
    paths: ['src/removed.ts', 'src/retained.ts'],
    scannablePaths: ['src/retained.ts'],
  });
  assert.deepEqual(
    deletionPlan.find(({ name }) => name === 'ubs').args,
    ['--no-auto-update', '--skip=2', 'src/retained.ts'],
  );
});

test('local tool doctor pins UBS while accepting supported Node releases', () => {
  assert.doesNotThrow(() =>
    validateToolReport({ nodeVersion: 'v24.13.1', ubsVersion: 'UBS Meta-Runner v5.3.5' }),
  );
  assert.throws(
    () => validateToolReport({ nodeVersion: 'v20.19.0', ubsVersion: 'UBS Meta-Runner v5.3.5' }),
    /Node >=22/,
  );
  assert.throws(
    () => validateToolReport({ nodeVersion: 'v24.13.1', ubsVersion: 'UBS Meta-Runner v5.4.0' }),
    /UBS 5\.3\.5/,
  );
});

test('hook installer refuses to overwrite an unrelated hook configuration', () => {
  assert.deepEqual(assessHookInstallation({ hooksPath: '', existingHooks: [] }), {
    allowed: true,
    reason: '',
  });
  assert.match(
    assessHookInstallation({ hooksPath: '/custom/hooks', existingHooks: [] }).reason,
    /custom hooksPath/i,
  );
  assert.match(
    assessHookInstallation({ hooksPath: '', existingHooks: ['commit-msg'] }).reason,
    /commit-msg/i,
  );
  assert.equal(normalizeAliasValue(`'!npm run pr:publish -- "$@"'`), '!npm run pr:publish -- "$@"');
});

test('local gate writes one exact-head attestation and reuses it without rerunning tools', async () => {
  const { cwd, base } = makeGateRepository();
  const executed = [];
  const execute = async (gate) => executed.push(gate.name);

  const first = await runLocalGate({ cwd, baseRef: base, execute });
  assert.equal(first.head, git(cwd, 'rev-parse', 'HEAD'));
  assert.equal(first.base, base);
  assert.ok(executed.includes('tests'));
  const firstCount = executed.length;

  const second = await runLocalGate({ cwd, baseRef: base, execute });
  assert.deepEqual(second, first);
  assert.equal(executed.length, firstCount);

  writeFileSync(join(cwd, 'src/next.ts'), 'export const next = true;\n');
  git(cwd, 'add', 'src/next.ts');
  git(cwd, 'commit', '--quiet', '-m', 'next');
  const third = await runLocalGate({ cwd, baseRef: base, execute });
  assert.notEqual(third.head, first.head);
  assert.ok(executed.length > firstCount);
});

test('PR check evaluator waits for both CI and Greptile and returns failures without reruns', () => {
  const pending = evaluateRequiredChecks({
    expectedHead: HEAD,
    actualHead: HEAD,
    checks: [
      { name: 'ci-required', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'Greptile Review', status: 'IN_PROGRESS', conclusion: '' },
    ],
  });
  assert.equal(pending.state, 'pending');

  const failed = evaluateRequiredChecks({
    expectedHead: HEAD,
    actualHead: HEAD,
    checks: [
      { name: 'ci-required', status: 'COMPLETED', conclusion: 'FAILURE' },
      { name: 'Greptile Review', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ],
  });
  assert.deepEqual(failed, {
    state: 'failed',
    reason: 'ci-required concluded FAILURE.',
  });

  assert.match(
    evaluateRequiredChecks({
      expectedHead: HEAD,
      actualHead: `3${HEAD.slice(1)}`,
      checks: [],
    }).reason,
    /head changed/i,
  );
});

test('GitHub waits for an authenticated exact-base commit status', async () => {
  const statuses = [{
    context: REMOTE_ATTESTATION_CONTEXT,
    state: 'success',
    description: `base=${BASE}`,
    creator: { login: 'axAilotl' },
  }];
  assert.equal(
    validateRemoteAttestation(statuses, BASE, 'axAilotl').context,
    REMOTE_ATTESTATION_CONTEXT,
  );
  assert.throws(
    () => validateRemoteAttestation(statuses, BASE, 'untrusted-writer'),
    /trusted issuer/,
  );
  assert.throws(
    () => validateRemoteAttestation(statuses, `3${BASE.slice(1)}`, 'axAilotl'),
    /exact base/,
  );
  assert.equal(
    (await waitForRemoteAttestation({
      repository: 'owner/repo',
      head: HEAD,
      base: BASE,
      expectedActor: 'axAilotl',
      attempts: 1,
      read: () => statuses,
    })).state,
    'success',
  );
});

test('publisher pushes the exact attested commit rather than mutable HEAD', () => {
  assert.equal(
    buildValidatedPushRefspec(HEAD, 'fix/validated-head'),
    `${HEAD}:refs/heads/fix/validated-head`,
  );
  assert.throws(() => buildValidatedPushRefspec('HEAD', 'fix/validated-head'), /SHA/);
});

test('changed-workflow security scan accepts only explicit GitHub workflow inputs', () => {
  assert.deepEqual(
    validateZizmorInputs(['.github/workflows/ci.yml', '.github/workflows/ci.yml']),
    ['.github/workflows/ci.yml'],
  );
  assert.throws(() => validateZizmorInputs([]), /at least one input/);
  assert.throws(() => validateZizmorInputs(['src/index.ts']), /unexpected zizmor input/);
});

test('GitHub CI is one complementary delta lane without label-triggered reruns', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

  assert.doesNotMatch(workflow, /\b(?:labeled|unlabeled)\b/);
  assert.doesNotMatch(workflow, /^  push:\s*$/m);
  assert.doesNotMatch(workflow, /^  workflow_dispatch:\s*$/m);
  assert.match(workflow, /^  github-delta:\s*$/m);
  assert.match(workflow, /^  ci-required:\s*$/m);
  assert.equal((workflow.match(/^    runs-on:/gm) ?? []).length, 2);
  assert.ok(
    workflow.indexOf('Verify exact local-gate status') < workflow.indexOf('run: npm ci'),
    'attestation must fail before the clean-environment install',
  );
  assert.match(workflow, /steps\.scope\.outputs\.root_runtime == 'true'/);
  assert.match(workflow, /steps\.scope\.outputs\.admin_ui == 'true'/);
  assert.match(workflow, /steps\.scope\.outputs\.companion_ui == 'true'/);
  assert.match(workflow, /steps\.scope\.outputs\.deployment == 'true'/);
  assert.doesNotMatch(workflow, /run: npm run lint/);
  assert.doesNotMatch(workflow, /run: npm test/);
  assert.doesNotMatch(workflow, /run: bash scripts\/ci\/run-semgrep\.sh/);
  assert.match(workflow, /statuses: read/);
  assert.match(workflow, /vars\.LOCAL_GATE_STATUS_ACTOR/);
});
