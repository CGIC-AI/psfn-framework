import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { validateToolReport } from './check-local-tools.mjs';
import { normalizeAliasValue } from './install-local-hooks.mjs';
import {
  GATE_PHASE,
  GATE_VERSION,
  REMOTE_ATTESTATION_CONTEXT,
  STAGE_SCHEMA_VERSION,
  assessHookInstallation,
  buildValidatedPushRefspec,
  buildGatePlan,
  createAttestation,
  createCanaryAttestation,
  describeLockWait,
  evaluateRequiredChecks,
  isStageReusable,
  partitionGatePlan,
  planPrePush,
  validateAttestation,
  validateRemoteAttestation,
} from './local-delivery-contract.mjs';
import {
  acquireHeavyPhaseLock,
  isProcessAlive,
  releaseHeavyPhaseLock,
  runCanaryGate,
  runLocalGate,
  withHeavyPhaseLock,
} from './run-local-gate.mjs';
import { validateZizmorInputs } from './run-zizmor-changed.mjs';
import { waitForRemoteAttestation } from './verify-pr-attestation.mjs';
import { waitForPr } from './wait-for-pr.mjs';

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
    'commit-identities',
    'lint-changed',
    'startup-owner-files',
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
    for (const rootGate of [
      'lint',
      'build',
      'typecheck',
      'repository-hygiene',
      'tests',
    ]) {
      assert.ok(!names.includes(rootGate), `${path} must not run root ${rootGate}`);
    }
    assert.ok(names.includes('startup-owner-files'), `${path} must run startup-owner-files`);
  }

  const catalogueOnlyNames = buildGatePlan({
    paths: ['src/boundary/fleet-auth/garden-route-capabilities.ts'],
  })
    .filter(({ skip }) => !skip)
    .map(({ name }) => name);
  assert.ok(
    catalogueOnlyNames.includes('garden-route-body-policy'),
    'a catalogue-only change must run the Garden route body-policy conformance suite',
  );

  const lockfileNames = buildGatePlan({ paths: ['package-lock.json'] })
    .filter(({ skip }) => !skip)
    .map(({ name }) => name);
  for (const rootGate of [
    'lint',
    'build',
    'typecheck',
    'repository-hygiene',
    'startup-owner-files',
    'tests',
  ]) {
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

  assert.deepEqual(names.slice(0, 4), [
    'ci-rules',
    'change-budget',
    'commit-identities',
    'lint',
  ]);
  for (const required of [
    'build',
    'typecheck',
    'repository-hygiene',
    'startup-owner-files',
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
  assert.deepEqual(plan.find(({ name }) => name === 'ubs').args, [
    '--no-auto-update',
    '--skip-js=4,7',
    'src/system/config/load-config.ts',
  ]);
  assert.deepEqual(plan.find(({ name }) => name === 'tests').args, [
    'test',
    '--',
    '--maxWorkers=8',
    '--bail=1',
  ]);
  assert.equal(plan.find(({ name }) => name === 'tests').skip, false);

  const deletionPlan = buildGatePlan({
    paths: ['src/removed.ts', 'src/retained.ts'],
    scannablePaths: ['src/retained.ts'],
  });
  assert.deepEqual(
    deletionPlan.find(({ name }) => name === 'ubs').args,
    ['--no-auto-update', '--skip-js=4,7', 'src/retained.ts'],
  );
});

test('local tool doctor pins UBS while accepting supported Node releases', () => {
  assert.doesNotThrow(() =>
    validateToolReport({ nodeVersion: 'v24.13.1', ubsVersion: 'UBS Meta-Runner v5.3.7' }),
  );
  assert.throws(
    () => validateToolReport({ nodeVersion: 'v20.19.0', ubsVersion: 'UBS Meta-Runner v5.3.7' }),
    /Node >=22/,
  );
  assert.throws(
    () => validateToolReport({ nodeVersion: 'v24.13.1', ubsVersion: 'UBS Meta-Runner v5.4.0' }),
    /UBS 5\.3\.7/,
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
  const heavyLock = { lockDir: makeLockDir() };

  const first = await runLocalGate({ cwd, baseRef: base, execute, heavyLock });
  assert.equal(first.head, git(cwd, 'rev-parse', 'HEAD'));
  assert.equal(first.base, base);
  assert.ok(executed.includes('tests'));
  const firstCount = executed.length;

  const second = await runLocalGate({ cwd, baseRef: base, execute, heavyLock });
  assert.deepEqual(second, first);
  assert.equal(executed.length, firstCount);

  writeFileSync(join(cwd, 'src/next.ts'), 'export const next = true;\n');
  git(cwd, 'add', 'src/next.ts');
  git(cwd, 'commit', '--quiet', '-m', 'next');
  const third = await runLocalGate({ cwd, baseRef: base, execute, heavyLock });
  assert.notEqual(third.head, first.head);
  assert.ok(executed.length > firstCount);
});

test('a stage record is reusable only for the exact head, base, gate version, and command', () => {
  const record = {
    schemaVersion: STAGE_SCHEMA_VERSION,
    gateVersion: GATE_VERSION,
    head: HEAD,
    base: BASE,
    name: 'tests',
    command: 'npm test -- --maxWorkers=8 --bail=1',
  };
  const context = {
    head: HEAD,
    base: BASE,
    gateVersion: GATE_VERSION,
    command: 'npm test -- --maxWorkers=8 --bail=1',
  };
  assert.equal(isStageReusable(record, context), true);
  assert.equal(isStageReusable(record, { ...context, head: `0${HEAD.slice(1)}` }), false);
  assert.equal(isStageReusable(record, { ...context, base: `0${BASE.slice(1)}` }), false);
  assert.equal(isStageReusable(record, { ...context, gateVersion: GATE_VERSION + 1 }), false);
  assert.equal(isStageReusable(record, { ...context, command: 'npm test -- --bail' }), false);
  assert.equal(isStageReusable(null, context), false);
  assert.equal(isStageReusable({ ...record, schemaVersion: STAGE_SCHEMA_VERSION + 1 }, context), false);
});

test('the whole-gate attestation carries the gate version and stays exact-head bound', () => {
  const gates = ['ci-rules', 'tests'];
  const attestation = createAttestation({ head: HEAD, base: BASE, baseRef: 'origin/main', gates });
  assert.equal(attestation.gateVersion, GATE_VERSION);
  assert.equal(validateAttestation(attestation, { head: HEAD, base: BASE, gates }).valid, true);
  // A bumped gate version invalidates an otherwise-exact attestation.
  assert.match(
    validateAttestation(attestation, { head: HEAD, base: BASE, gates, gateVersion: GATE_VERSION + 1 }).reason,
    /gate version/i,
  );
  // The exact-head discipline is unchanged: a different head is still rejected.
  assert.match(
    validateAttestation(attestation, { head: `0${HEAD.slice(1)}`, base: BASE, gates }).reason,
    /head/i,
  );
  // A v1-shaped attestation (no gateVersion, old schema) never validates.
  assert.equal(
    validateAttestation({ ...attestation, schemaVersion: 1 }, { head: HEAD, base: BASE, gates }).valid,
    false,
  );
});

test('a partial gate run reuses passed stages and reruns only the failed stage on the same head', async () => {
  const { cwd, base } = makeGateRepository();
  const runs = [];
  let failTests = true;
  const execute = async (gate) => {
    if (gate.skip) return;
    runs.push(gate.name);
    if (gate.name === 'tests' && failTests) throw new Error('tests failed');
  };
  const heavyLock = { lockDir: makeLockDir(), isAlive: () => true, sleep: async () => {} };

  await assert.rejects(
    runLocalGate({ cwd, baseRef: base, execute, heavyLock }),
    /tests failed/,
  );
  assert.ok(runs.includes('ci-rules'), 'preflight stages ran on the first pass');
  assert.ok(runs.includes('tests'), 'the heavy stage ran and failed on the first pass');
  // The whole-gate attestation is not written when a stage fails.
  assert.equal(
    existsSync(join(cwd, '.git', 'local-delivery-gate', 'attestation.json')),
    false,
    'no whole-gate attestation exists after a partial failure',
  );

  runs.length = 0;
  failTests = false;
  const attestation = await runLocalGate({ cwd, baseRef: base, execute, heavyLock });
  assert.ok(runs.includes('tests'), 'the previously failed stage reruns');
  assert.ok(!runs.includes('ci-rules'), 'a previously passed stage is reused, not rerun');
  assert.ok(!runs.includes('lint'), 'a previously passed stage is reused, not rerun');
  assert.equal(attestation.head, git(cwd, 'rev-parse', 'HEAD'));
  assert.equal(attestation.gateVersion, GATE_VERSION);
});

function makeLockDir() {
  const parent = mkdtempSync(join(tmpdir(), 'heavy-phase-lock-'));
  return join(parent, 'heavy.lock');
}

function seedLock(lockDir, meta) {
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'meta.json'), `${JSON.stringify(meta)}\n`);
}

function readSeededMeta(lockDir) {
  return JSON.parse(readFileSync(join(lockDir, 'meta.json'), 'utf8'));
}

test('gate plan splits the heavy product suite from parallel-safe preflight', () => {
  const plan = buildGatePlan({
    paths: ['deploy/helm/psfn/values.yaml', 'src/system/config/load-config.ts'],
  });
  const { preflight, heavy } = partitionGatePlan(plan);

  // Only the product/Postgres suite is heavy; everything else is preflight.
  assert.deepEqual(heavy.map(({ name }) => name), ['tests']);
  assert.equal(plan.find(({ name }) => name === 'tests').phase, GATE_PHASE.HEAVY);
  assert.ok(!preflight.some(({ name }) => name === 'tests'));

  // Cheap contracts (deployment/settings/supply-chain) are preflight, so they
  // fire before the heavy suite — the PR-190 ordering regression stays fixed.
  for (const contract of ['deployment-contracts', 'settings-contract', 'supply-chain']) {
    assert.ok(
      preflight.some(({ name }) => name === contract),
      `${contract} must run in the preflight phase`,
    );
  }
  // Partition preserves the plan's own ordering within each phase.
  assert.deepEqual(
    [...preflight, ...heavy].map(({ name }) => name).sort(),
    plan.map(({ name }) => name).sort(),
  );
});

function makeCanaryRepository() {
  const cwd = mkdtempSync(join(tmpdir(), 'local-canary-gate-'));
  git(cwd, 'init', '--quiet');
  git(cwd, 'config', 'user.email', 'ci@example.invalid');
  git(cwd, 'config', 'user.name', 'CI Test');
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src/seed.ts'), 'export const seed = true;\n');
  git(cwd, 'add', 'src/seed.ts');
  git(cwd, 'commit', '--quiet', '-m', 'seed');
  git(cwd, 'branch', '-M', 'main');
  return { cwd, main: git(cwd, 'rev-parse', 'HEAD') };
}

test('canary plan forces whole-repo gates on and skips diff-scoped gates explicitly', () => {
  const plan = buildGatePlan({ paths: [], canary: true });
  const active = plan.filter(({ skip }) => !skip).map(({ name }) => name);
  for (const gate of [
    'ci-rules',
    'lint',
    'build',
    'typecheck',
    'repository-hygiene',
    'startup-owner-files',
    'semgrep-rules',
    'tests',
  ]) {
    assert.ok(active.includes(gate), `canary must run ${gate} against main`);
  }
  // Diff-scoped gates are skipped with an explicit, logged reason — never silent.
  for (const gate of ['change-budget', 'commit-identities', 'semgrep-diff', 'ubs']) {
    const entry = plan.find(({ name }) => name === gate);
    assert.equal(entry.skip, true, `canary must skip ${gate}`);
    assert.match(entry.skipReason ?? '', /canary/, `canary must state why ${gate} is skipped`);
  }
  // The delivery-scoped lint-changed variant is never used in canary.
  assert.ok(!plan.some(({ name }) => name === 'lint-changed'));
});

test('clean-main canary runs the full gate against main and records an attestation', async () => {
  const { cwd, main } = makeCanaryRepository();
  const executed = [];
  const skipped = [];
  const execute = async (gate) => {
    if (gate.skip) skipped.push(gate.name);
    else executed.push(gate.name);
  };

  const attestation = await runCanaryGate({
    cwd,
    mainRef: 'main',
    execute,
    heavyLock: { lockDir: makeLockDir(), isAlive: () => true, sleep: async () => {} },
  });

  assert.equal(attestation.kind, 'canary');
  assert.equal(attestation.base, main);
  assert.equal(attestation.gateVersion, GATE_VERSION);
  for (const gate of [
    'ci-rules',
    'lint',
    'build',
    'typecheck',
    'repository-hygiene',
    'startup-owner-files',
    'tests',
  ]) {
    assert.ok(executed.includes(gate), `canary must run ${gate}`);
  }
  for (const gate of ['change-budget', 'commit-identities', 'semgrep-diff', 'ubs']) {
    assert.ok(skipped.includes(gate), `canary must skip ${gate}`);
  }
  const written = JSON.parse(
    readFileSync(join(cwd, '.git', 'local-delivery-gate', 'canary-attestation.json'), 'utf8'),
  );
  assert.equal(written.base, main);
  assert.equal(written.kind, 'canary');
  // A canary attestation is deliberately not a branch attestation.
  assert.equal(
    validateAttestation(written, { head: main, base: main, gates: ['tests'] }).valid,
    false,
  );
});

test('clean-main canary refuses a dirty worktree', async () => {
  const { cwd } = makeCanaryRepository();
  writeFileSync(join(cwd, 'src/dirty.ts'), 'export const dirty = true;\n');
  await assert.rejects(
    runCanaryGate({ cwd, mainRef: 'main', execute: async () => {} }),
    /clean worktree/i,
  );
});

test('clean-main canary refuses a head that is not origin/main', async () => {
  const { cwd } = makeCanaryRepository();
  git(cwd, 'switch', '--quiet', '-c', 'feature');
  writeFileSync(join(cwd, 'src/feature.ts'), 'export const feature = true;\n');
  git(cwd, 'add', 'src/feature.ts');
  git(cwd, 'commit', '--quiet', '-m', 'feature');
  await assert.rejects(
    runCanaryGate({ cwd, mainRef: 'main', execute: async () => {} }),
    /exactly main/i,
  );
});

test('clean-main canary propagates a gate failure', async () => {
  const { cwd } = makeCanaryRepository();
  const boom = new Error('lint exploded');
  const execute = async (gate) => {
    if (gate.name === 'lint') throw boom;
  };
  await assert.rejects(
    runCanaryGate({ cwd, mainRef: 'main', execute, heavyLock: { lockDir: makeLockDir() } }),
    (error) => error === boom,
  );
  // A failed canary leaves no attestation behind.
  assert.equal(
    existsSync(join(cwd, '.git', 'local-delivery-gate', 'canary-attestation.json')),
    false,
  );
});

test('createCanaryAttestation records base, gate version, and a timestamp', () => {
  const attestation = createCanaryAttestation({ base: BASE, mainRef: 'origin/main' });
  assert.equal(attestation.kind, 'canary');
  assert.equal(attestation.base, BASE);
  assert.equal(attestation.gateVersion, GATE_VERSION);
  assert.equal(attestation.mainRef, 'origin/main');
  assert.match(attestation.completedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.throws(() => createCanaryAttestation({ base: 'not-a-sha', mainRef: 'origin/main' }), /SHA/);
});

test('heavy-phase lock: preflight runs lock-free while the heavy suite holds the lock', async () => {
  const { cwd, base } = makeGateRepository();
  const lockDir = makeLockDir();
  const lockPresent = {};
  const execute = async (gate) => {
    lockPresent[gate.name] = existsSync(lockDir);
  };

  await runLocalGate({
    cwd,
    baseRef: base,
    execute,
    heavyLock: { lockDir, isAlive: () => true, sleep: async () => {} },
  });

  assert.equal(lockPresent.tests, true, 'heavy suite must run while the lock is held');
  assert.equal(lockPresent['ci-rules'], false, 'preflight must run without the lock');
  assert.equal(lockPresent['lint'], false, 'preflight must run without the lock');
  assert.equal(existsSync(lockDir), false, 'lock must be released after the heavy phase');
});

test('heavy-phase lock: a delivery-only change takes no lock', async () => {
  const lockDir = makeLockDir();
  // No heavy gate is active for a docs/delivery-only change.
  const plan = buildGatePlan({ paths: ['README.md'] });
  const { heavy } = partitionGatePlan(plan);
  assert.ok(heavy.every(({ skip }) => skip), 'delivery-only plan has no active heavy gate');
  // Direct check: acquiring is only reached when an active heavy gate exists,
  // so the lock directory is never created for delivery-only work.
  assert.equal(existsSync(lockDir), false);
});

test('heavy-phase lock: two gates serialize; the waiter prints who holds it', async () => {
  const lockDir = makeLockDir();
  const logs = [];
  const log = { error: (message) => logs.push(message) };
  let clock = 0;
  const now = () => clock;

  const holderMeta = { pid: 111, worktree: '/worktree/a', command: 'tests', startedAt: 't0' };
  const first = await acquireHeavyPhaseLock({
    lockDir,
    meta: holderMeta,
    isAlive: () => true,
    now,
    log,
    sleep: async () => {},
  });
  assert.equal(readSeededMeta(lockDir).pid, 111);

  const waiterMeta = { pid: 222, worktree: '/worktree/b', command: 'tests', startedAt: 't1' };
  let polls = 0;
  const sleep = async (ms) => {
    polls += 1;
    clock += ms;
    if (polls === 3) first.release(); // holder finishes; waiter can proceed
  };

  const second = await acquireHeavyPhaseLock({
    lockDir,
    meta: waiterMeta,
    isAlive: () => true,
    now,
    log,
    sleep,
    diagnosticEveryMs: 1,
  });

  assert.ok(polls >= 3, 'the second gate waited for the first');
  assert.ok(
    logs.some((m) => /held by pid 111/.test(m) && /\/worktree\/a/.test(m) && /waited/.test(m)),
    'waiter must report the live holder and its own wait state',
  );
  assert.equal(readSeededMeta(lockDir).pid, 222, 'the waiter owns the lock once free');
  second.release();
  assert.equal(existsSync(lockDir), false);
});

test('heavy-phase lock: a dead owner is reclaimed', async () => {
  const lockDir = makeLockDir();
  const deadPid = 999001;
  seedLock(lockDir, { pid: deadPid, worktree: '/crashed', command: 'tests', startedAt: 't0' });
  const logs = [];

  const handle = await acquireHeavyPhaseLock({
    lockDir,
    meta: { pid: 222, worktree: '/live', command: 'tests', startedAt: 't1' },
    isAlive: (pid) => pid !== deadPid,
    log: { error: (m) => logs.push(m) },
    sleep: async () => {},
  });

  assert.equal(readSeededMeta(lockDir).pid, 222, 'the live process reclaimed the stale lock');
  assert.ok(logs.some((m) => /reclaimed stale lock from dead pid 999001/.test(m)));
  handle.release();
});

test('heavy-phase lock: a live owner is never stolen', async () => {
  const lockDir = makeLockDir();
  const livePid = 424242;
  seedLock(lockDir, { pid: livePid, worktree: '/live-holder', command: 'tests', startedAt: 't0' });

  const sentinel = new Error('gave up waiting');
  let polls = 0;
  await assert.rejects(
    acquireHeavyPhaseLock({
      lockDir,
      meta: { pid: 222, worktree: '/waiter', command: 'tests', startedAt: 't1' },
      isAlive: () => true, // holder is alive the whole time
      log: { error: () => {} },
      sleep: async () => {
        polls += 1;
        if (polls >= 5) throw sentinel; // break the otherwise-unbounded wait
      },
    }),
    (error) => error === sentinel,
  );

  assert.equal(readSeededMeta(lockDir).pid, livePid, 'the live holder was never displaced');
});

test('heavy-phase lock: a crashed holder does not wedge the next run', async () => {
  const lockDir = makeLockDir();
  const crashedPid = 999002;
  // Leftover lock from a process that died mid-heavy-phase without releasing.
  seedLock(lockDir, { pid: crashedPid, worktree: '/crashed', command: 'tests', startedAt: 't0' });

  let ran = false;
  await withHeavyPhaseLock(
    {
      lockDir,
      meta: { pid: 222, worktree: '/fresh', command: 'tests', startedAt: 't1' },
      isAlive: (pid) => pid !== crashedPid,
      log: { error: () => {} },
      sleep: async () => {},
    },
    async () => {
      ran = true;
      assert.equal(readSeededMeta(lockDir).pid, 222, 'fresh run holds the lock in-body');
    },
  );

  assert.ok(ran, 'the heavy body ran after reclaiming the crashed holder');
  assert.equal(existsSync(lockDir), false, 'the lock is released after the heavy body');
});

test('heavy-phase lock: a metaless orphan past the grace period is reclaimed', async () => {
  const lockDir = makeLockDir();
  // A holder crashed between mkdir(lockDir) and publishing meta.json, leaving a
  // metaless directory (and a leftover temp file) that no dead-PID reap can see.
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, 'meta.json.tmp-999001-abcd'), 'partial');
  const logs = [];
  const stat = () => ({ birthtimeMs: 1000, mtimeMs: 1000 });
  const now = () => 1000 + 60000; // 60s later: well past the 10s grace

  const handle = await acquireHeavyPhaseLock({
    lockDir,
    meta: { pid: 222, worktree: '/live', command: 'tests', startedAt: 't1' },
    isAlive: () => false, // the orphan's owner is gone; nobody is mid-write
    now,
    stat,
    log: { error: (m) => logs.push(m) },
    sleep: async () => {},
  });

  assert.equal(readSeededMeta(lockDir).pid, 222, 'the waiter acquired after reclaiming the orphan');
  assert.ok(
    logs.some((m) => /reclaimed metaless lock dir/.test(m)),
    'the metaless reclaim is reported',
  );
  handle.release();
});

test('heavy-phase lock: a fresh metaless dir is honored once its writer publishes', async () => {
  const lockDir = makeLockDir();
  // The writer has created the directory but not yet published meta.json.
  mkdirSync(lockDir, { recursive: true });
  const stat = () => ({ birthtimeMs: 5000, mtimeMs: 5000 });
  let clock = 5000; // now == birthtime: age 0, far under the 10s grace
  const now = () => clock;

  const writerMeta = { pid: 777, worktree: '/writer', command: 'tests', startedAt: 't0' };
  const sentinel = new Error('gave up waiting');
  let polls = 0;
  await assert.rejects(
    acquireHeavyPhaseLock({
      lockDir,
      meta: { pid: 222, worktree: '/waiter', command: 'tests', startedAt: 't1' },
      isAlive: () => true, // the writer is alive the whole time
      now,
      stat,
      log: { error: () => {} },
      sleep: async (ms) => {
        polls += 1;
        clock += ms;
        // The slow-but-alive writer finishes publishing before the grace elapses.
        if (polls === 1) writeFileSync(join(lockDir, 'meta.json'), `${JSON.stringify(writerMeta)}\n`);
        if (polls >= 5) throw sentinel; // break the otherwise-unbounded honor loop
      },
    }),
    (error) => error === sentinel,
  );

  assert.equal(
    readSeededMeta(lockDir).pid,
    777,
    'the fresh dir was never removed; the writer’s published lock is honored, not stolen',
  );
});

test('heavy-phase lock: a live reaper blocks a second metaless reclaimer', async () => {
  const lockDir = makeLockDir();
  // A metaless orphan, old enough to reclaim.
  mkdirSync(lockDir, { recursive: true });
  // A concurrent reaper already holds the single-owner reap mutex.
  const reapDir = `${lockDir}.reap`;
  mkdirSync(reapDir, { recursive: true });
  writeFileSync(join(reapDir, 'meta.json'), `${JSON.stringify({ pid: 555, startedAt: 't0' })}\n`);

  const stat = () => ({ birthtimeMs: 1000, mtimeMs: 1000 });
  const now = () => 1000 + 60000; // past the grace
  const sentinel = new Error('gave up waiting');
  let polls = 0;
  await assert.rejects(
    acquireHeavyPhaseLock({
      lockDir,
      meta: { pid: 222, worktree: '/waiter-b', command: 'tests', startedAt: 't1' },
      isAlive: (pid) => pid === 555, // the reaper holding the mutex is alive
      now,
      stat,
      log: { error: () => {} },
      sleep: async () => {
        polls += 1;
        if (polls >= 4) throw sentinel;
      },
    }),
    (error) => error === sentinel,
  );

  assert.equal(
    existsSync(join(lockDir, 'meta.json')),
    false,
    'the blocked waiter never removed the orphan or wrote its own meta',
  );
  assert.ok(existsSync(reapDir), 'the live reaper still owns the reap mutex');
});

test('heavy-phase lock: release refuses to remove a different owner', () => {
  const lockDir = makeLockDir();
  seedLock(lockDir, { pid: 333, worktree: '/other', command: 'tests', startedAt: 't9' });
  assert.throws(
    () => releaseHeavyPhaseLock({ lockDir, meta: { pid: 222, startedAt: 't1' } }),
    /owner changed/,
  );
  assert.equal(readSeededMeta(lockDir).pid, 333, 'the other owner is untouched');
  rmSync(lockDir, { recursive: true, force: true });
});

test('heavy-phase lock: describeLockWait and isProcessAlive report clearly', () => {
  const message = describeLockWait({
    holder: { pid: 5, worktree: '/w', command: 'tests', startedAt: '2026-07-21T00:00:00.000Z' },
    waitedMs: 65000,
    self: { pid: 6, worktree: '/x' },
  });
  assert.match(message, /held by pid 5/);
  assert.match(message, /waited 1m5s/);
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
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
  // The workflow-security scan is a step inside the always-run delta job, so it
  // enforces zizmor findings without adding a skippable ci-required dependency.
  assert.match(
    workflow,
    /node scripts\/ci\/run-zizmor-changed\.mjs --format=github --base "\$BASE_SHA" --head "\$HEAD_SHA"/,
  );
  assert.match(
    workflow,
    /npm run verify:commit-identities -- --base "\$BASE_SHA" --head "\$HEAD_SHA"/,
  );
});

test('trusted PR label automation has the write scope required by the labels API', () => {
  const workflow = readFileSync('.github/workflows/pr-labels.yml', 'utf8');
  const applyJob = workflow.slice(workflow.indexOf('  apply:'), workflow.indexOf('  catalog:'));

  assert.match(applyJob, /pull-requests: write/);
  assert.doesNotMatch(applyJob, /issues: write/);
  assert.match(applyJob, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
});

test('PR wait fails loudly when GitHub reports a different head than the attested SHA', async () => {
  await assert.rejects(
    waitForPr({
      reference: '191',
      expectedHead: HEAD,
      read: () => ({
        number: 191,
        headRefOid: `3${HEAD.slice(1)}`,
        statusCheckRollup: [],
      }),
    }),
    /PR head changed.*while waiting/i,
  );
});

test('PR wait fails loudly when a required check is skipped', async () => {
  await assert.rejects(
    waitForPr({
      reference: '191',
      expectedHead: HEAD,
      read: () => ({
        number: 191,
        headRefOid: HEAD,
        statusCheckRollup: [
          { name: 'ci-required', status: 'COMPLETED', conclusion: 'SKIPPED' },
          { name: 'Greptile Review', status: 'COMPLETED', conclusion: 'SUCCESS' },
        ],
      }),
    }),
    /ci-required concluded SKIPPED/i,
  );
});

test('ready-for-review CI runs use the exact PR head without label-triggered reruns', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

  assert.match(workflow, /types:\s*\[[^\]]*ready_for_review[^\]]*\]/);
  assert.doesNotMatch(workflow, /\b(?:labeled|unlabeled)\b/);
  assert.match(workflow, /HEAD_SHA:\s*\$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /ref:\s*\$\{\{ env\.HEAD_SHA \}\}/);
});
