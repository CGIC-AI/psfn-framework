import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { validateToolReport } from './check-local-tools.mjs';
import { normalizeAliasValue } from './install-local-hooks.mjs';
import {
  appendAttestationMarker,
  assessHookInstallation,
  buildGatePlan,
  createAttestation,
  evaluateRequiredChecks,
  formatAttestationMarker,
  parseAttestationMarker,
  planPrePush,
  validateAttestation,
} from './local-delivery-contract.mjs';
import { runLocalGate } from './run-local-gate.mjs';
import { validateZizmorInputs } from './run-zizmor-changed.mjs';
import { verifyPrAttestation } from './verify-pr-attestation.mjs';

const HEAD = '1111111111111111111111111111111111111111';
const BASE = '2222222222222222222222222222222222222222';

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeGateRepository() {
  const cwd = mkdtempSync(join(tmpdir(), 'psfn-local-gate-'));
  git(cwd, 'init', '--quiet');
  git(cwd, 'config', 'user.email', 'ci@example.invalid');
  git(cwd, 'config', 'user.name', 'CI Test');
  writeFileSync(join(cwd, 'seed.ts'), 'export const seed = true;\n');
  git(cwd, 'add', 'seed.ts');
  git(cwd, 'commit', '--quiet', '-m', 'seed');
  const base = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'switch', '--quiet', '-c', 'feature');
  writeFileSync(join(cwd, 'feature.ts'), 'export const feature = true;\n');
  git(cwd, 'add', 'feature.ts');
  git(cwd, 'commit', '--quiet', '-m', 'feature');
  return { cwd, base };
}

test('attestation is valid only for the exact clean head and base', () => {
  const attestation = createAttestation({
    head: HEAD,
    base: BASE,
    baseRef: 'origin/main',
    gates: ['change-budget', 'tests', 'semgrep'],
  });

  assert.deepEqual(validateAttestation(attestation, { head: HEAD, base: BASE }), {
    valid: true,
    reason: '',
  });
  assert.match(
    validateAttestation(attestation, { head: `0${HEAD.slice(1)}`, base: BASE }).reason,
    /head/i,
  );
  assert.match(
    validateAttestation(attestation, { head: HEAD, base: `0${BASE.slice(1)}` }).reason,
    /base/i,
  );
});

test('PR marker round-trips and replaces a stale marker instead of accumulating', () => {
  const attestation = createAttestation({
    head: HEAD,
    base: BASE,
    baseRef: 'origin/main',
    gates: ['change-budget', 'tests'],
  });
  const marker = formatAttestationMarker(attestation);

  assert.deepEqual(parseAttestationMarker(marker), {
    schemaVersion: 1,
    head: HEAD,
    base: BASE,
  });
  const body = appendAttestationMarker(`Summary\n\n${marker}`, {
    ...attestation,
    head: `3${HEAD.slice(1)}`,
  });
  assert.equal((body.match(/psfn-local-gate:v1/g) ?? []).length, 1);
  assert.match(body, new RegExp(`head=3${HEAD.slice(1)}`));
});

test('pre-push blocks direct main, skips deletions, reuses exact attestations, and never recurses', () => {
  assert.deepEqual(
    planPrePush({
      updates: [
        {
          localSha: HEAD,
          localRef: 'HEAD',
          remoteRef: 'refs/heads/main',
          remoteSha: BASE,
        },
      ],
      head: HEAD,
      currentBranch: 'feature',
      attestationValid: false,
      gateActive: false,
    }),
    { action: 'block', reason: 'Direct pushes to main are prohibited.' },
  );
  assert.deepEqual(
    planPrePush({
      updates: [
        {
          localSha: '0'.repeat(40),
          localRef: '(delete)',
          remoteRef: 'refs/heads/old',
          remoteSha: BASE,
        },
      ],
      head: HEAD,
      currentBranch: 'feature',
      attestationValid: false,
      gateActive: false,
    }),
    { action: 'allow', reason: 'No branch update requires validation.' },
  );
  assert.equal(
    planPrePush({
      updates: [
        {
          localSha: HEAD,
          localRef: 'HEAD',
          remoteRef: 'refs/heads/feature',
          remoteSha: BASE,
        },
      ],
      head: HEAD,
      currentBranch: 'feature',
      attestationValid: true,
      gateActive: false,
    }).action,
    'allow',
  );
  assert.equal(
    planPrePush({
      updates: [
        {
          localSha: HEAD,
          localRef: 'HEAD',
          remoteRef: 'refs/heads/feature',
          remoteSha: BASE,
        },
      ],
      head: HEAD,
      currentBranch: 'feature',
      attestationValid: false,
      gateActive: false,
    }).action,
    'run-gate',
  );
  assert.deepEqual(
    planPrePush({
      updates: [
        {
          localSha: HEAD,
          localRef: 'HEAD',
          remoteRef: 'refs/heads/feature',
          remoteSha: BASE,
        },
      ],
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

test('gate plan keeps broad checks local and scopes specialist tools', () => {
  const plan = buildGatePlan({
    paths: [
      '.github/workflows/ci.yml',
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
    'zizmor-changed-workflows',
  ]) {
    assert.ok(names.includes(required), `missing local gate: ${required}`);
  }
  assert.deepEqual(plan.find(({ name }) => name === 'ubs').args.slice(0, 1), [
    '--no-auto-update',
  ]);
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
  assert.deepEqual(assessHookInstallation({ hooksPath: '', existingPrePush: false }), {
    allowed: true,
    reason: '',
  });
  assert.match(
    assessHookInstallation({ hooksPath: '/custom/hooks', existingPrePush: false }).reason,
    /custom hooksPath/i,
  );
  assert.match(
    assessHookInstallation({ hooksPath: '', existingPrePush: true }).reason,
    /existing pre-push/i,
  );
  assert.equal(normalizeAliasValue("'!npm run pr:publish --'"), '!npm run pr:publish --');
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

  writeFileSync(join(cwd, 'next.ts'), 'export const next = true;\n');
  git(cwd, 'add', 'next.ts');
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

test('GitHub verifies the local marker against the exact event head and base', () => {
  const marker = `<!-- psfn-local-gate:v1 head=${HEAD} base=${BASE} -->`;
  assert.equal(verifyPrAttestation({ body: marker, head: HEAD, base: BASE }).head, HEAD);
  assert.throws(
    () => verifyPrAttestation({ body: marker, head: `3${HEAD.slice(1)}`, base: BASE }),
    /does not match PR head/,
  );
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
  assert.match(workflow, /^  github-delta:\s*$/m);
  assert.match(workflow, /^  ci-required:\s*$/m);
  assert.equal((workflow.match(/^    runs-on:/gm) ?? []).length, 2);
  assert.ok(
    workflow.indexOf('Verify exact local-gate attestation') < workflow.indexOf('run: npm ci'),
    'attestation must fail before the clean-environment install',
  );
  assert.match(workflow, /steps\.scope\.outputs\.clean_environment == 'true'/);
  assert.doesNotMatch(workflow, /run: npm run lint/);
  assert.doesNotMatch(workflow, /run: bash scripts\/ci\/run-semgrep\.sh/);
});
