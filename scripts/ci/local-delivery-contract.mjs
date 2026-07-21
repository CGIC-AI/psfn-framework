import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectChangeScope } from './detect-change-scope.mjs';

const SHA = /^[0-9a-f]{40}$/;
const ZERO_SHA = '0'.repeat(40);

export const LOCAL_GATE_SCHEMA_VERSION = 1;
export const REMOTE_ATTESTATION_CONTEXT = 'local-gate/v1';

// Two-phase execution of the local gate. Preflight gates are cheap and
// parallel-safe across independent worktrees (they take no machine lock).
// The heavy phase is the full product/Postgres test suite; it is serialized
// machine-wide by a single lock so concurrent worktrees do not contend for
// the same finite resources. The phase tag lives on each planned gate so the
// attestation gate list (membership and order) is unchanged.
export const GATE_PHASE = Object.freeze({ PREFLIGHT: 'preflight', HEAVY: 'heavy' });

// Fixed, worktree-independent rendezvous for the heavy-phase lock. A directory
// (mkdir is atomic and fails when it already exists) rather than a file so the
// holder's metadata and the reap mutex live beside it.
export const HEAVY_PHASE_LOCK_DIR = join(tmpdir(), 'psfn-local-gate-heavy.lock');

function assertSha(value, name) {
  if (!SHA.test(value)) throw new Error(`${name} must be a lowercase 40-character git SHA`);
}

export function createAttestation({ head, base, baseRef, gates }) {
  assertSha(head, 'head');
  assertSha(base, 'base');
  if (!baseRef) throw new Error('baseRef is required');
  if (!Array.isArray(gates) || gates.length === 0) throw new Error('gates must be non-empty');
  return {
    schemaVersion: LOCAL_GATE_SCHEMA_VERSION,
    head,
    base,
    baseRef,
    gates: [...gates],
    completedAt: new Date().toISOString(),
  };
}

export function validateAttestation(attestation, { head, base, gates }) {
  if (!attestation || attestation.schemaVersion !== LOCAL_GATE_SCHEMA_VERSION) {
    return { valid: false, reason: 'Local gate attestation schema is missing or unsupported.' };
  }
  if (attestation.head !== head) {
    return { valid: false, reason: 'Local gate attestation head does not match the exact HEAD.' };
  }
  if (attestation.base !== base) {
    return { valid: false, reason: 'Local gate attestation base is stale.' };
  }
  if (!Array.isArray(gates) || JSON.stringify(attestation.gates) !== JSON.stringify(gates)) {
    return { valid: false, reason: 'Local gate attestation does not contain the exact gate plan.' };
  }
  return { valid: true, reason: '' };
}

export function validateRemoteAttestation(statuses, base, expectedActor) {
  assertSha(base, 'base');
  if (!expectedActor) throw new Error('Trusted local-gate status issuer is not configured');
  const expectedDescription = `base=${base}`;
  const status = statuses.find(({ context }) => context === REMOTE_ATTESTATION_CONTEXT);
  if (!status) throw new Error(`Missing ${REMOTE_ATTESTATION_CONTEXT} commit status`);
  if (status.creator?.login !== expectedActor) {
    throw new Error(`${REMOTE_ATTESTATION_CONTEXT} was not created by the trusted issuer`);
  }
  if (status.state !== 'success' || status.description !== expectedDescription) {
    throw new Error(`${REMOTE_ATTESTATION_CONTEXT} does not attest the exact base`);
  }
  return status;
}

export function buildValidatedPushRefspec(head, branch) {
  assertSha(head, 'head');
  if (!branch || branch === 'main' || /\s/.test(branch)) {
    throw new Error('A valid PR branch is required for the attested push');
  }
  return `${head}:refs/heads/${branch}`;
}

export function parsePrePushUpdates(input) {
  return input
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
      if (!localRef || !localSha || !remoteRef || !remoteSha) {
        throw new Error(`Malformed pre-push update: ${line}`);
      }
      return { localRef, localSha, remoteRef, remoteSha };
    });
}

export function planPrePush({
  updates,
  head,
  currentBranch,
  attestationValid,
  gateActive,
}) {
  const branchUpdates = updates.filter(
    ({ localSha, remoteRef }) => localSha !== ZERO_SHA && remoteRef.startsWith('refs/heads/'),
  );
  if (branchUpdates.length === 0) {
    return { action: 'allow', reason: 'No branch update requires validation.' };
  }
  if (branchUpdates.some(({ remoteRef }) => remoteRef === 'refs/heads/main')) {
    return { action: 'block', reason: 'Direct pushes to main are prohibited.' };
  }
  if (
    branchUpdates.length !== 1 ||
    branchUpdates[0].localSha !== head ||
    branchUpdates[0].remoteRef !== `refs/heads/${currentBranch}`
  ) {
    return {
      action: 'block',
      reason: 'Push exactly the checked-out branch HEAD so the local attestation is unambiguous.',
    };
  }
  if (attestationValid) {
    return { action: 'allow', reason: 'Exact-HEAD local gate attestation is current.' };
  }
  if (gateActive) {
    return {
      action: 'block',
      reason: 'Local gate recursion detected without a valid exact-HEAD attestation.',
    };
  }
  return { action: 'run-gate', reason: 'Exact-HEAD local gate attestation is missing or stale.' };
}

function command(name, executable, args, options = {}) {
  return { name, executable, args, phase: GATE_PHASE.PREFLIGHT, ...options };
}

// Split a built gate plan into its execution phases without changing the
// membership or ordering of either subset relative to the plan. Every gate
// carries a phase; anything not explicitly tagged heavy is preflight.
export function partitionGatePlan(plan) {
  const preflight = plan.filter((gate) => (gate.phase ?? GATE_PHASE.PREFLIGHT) !== GATE_PHASE.HEAVY);
  const heavy = plan.filter((gate) => gate.phase === GATE_PHASE.HEAVY);
  return { preflight, heavy };
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (hours || minutes) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join('');
}

// Human-facing diagnostic printed by a waiter while the heavy-phase lock is
// held elsewhere: who holds it, from where, since when, and how long we have
// been blocked. A person watching a stalled gate must identify the blocker at
// a glance.
export function describeLockWait({ holder, waitedMs, self }) {
  const holderPid = holder?.pid ?? 'unknown';
  const holderWorktree = holder?.worktree ?? 'unknown worktree';
  const holderCommand = holder?.command ?? 'unknown command';
  const heldSince = holder?.startedAt ? `since ${holder.startedAt}` : 'since an unknown time';
  const selfPid = self?.pid ?? 'unknown';
  const selfWorktree = self?.worktree ?? 'unknown worktree';
  return (
    `heavy-phase lock held by pid ${holderPid} (${holderWorktree}, cmd: ${holderCommand}) ` +
    `${heldSince}; pid ${selfPid} (${selfWorktree}) has waited ${formatDuration(waitedMs)}`
  );
}

export function buildGatePlan({
  paths,
  scannablePaths = paths,
  base = 'origin/main',
  head = 'HEAD',
  changeBudgetException = false,
}) {
  const matches = (pattern) => paths.some((path) => pattern.test(path));
  const scope = detectChangeScope(paths);
  const ubsPaths = scannablePaths.filter((path) => /\.(?:[cm]?[jt]s|[jt]sx|svelte)$/.test(path));
  const workflowPaths = paths.filter((path) =>
    /^\.github\/(?:workflows\/.*\.ya?ml|actions\/.*\.ya?ml|dependabot\.yml)$/.test(path),
  );
  const plan = [
    command('ci-rules', 'npm', ['run', 'test:ci-rules']),
    command('change-budget', 'npm', [
      'run',
      'verify:change-budget',
      '--',
      '--base',
      base,
      '--head',
      head,
      ...(changeBudgetException ? ['--exception'] : []),
    ]),
    scope.root_runtime
      ? command('lint', 'npm', ['run', 'lint'], { nodeHeapMb: 4096 })
      : command('lint-changed', 'npm', ['run', 'lint:changed', '--', '--base', base]),
    ...(scope.root_runtime
      ? [
          command('build', 'npm', ['run', 'build'], { nodeHeapMb: 4096 }),
          command('typecheck', 'npm', ['run', 'verify:typecheck-baseline'], {
            nodeHeapMb: 4096,
          }),
          command('repository-hygiene', 'npm', ['run', 'verify:repository-hygiene']),
        ]
      : []),
    command('semgrep-rules', 'npm', ['run', 'semgrep:test'], {
      skip: !matches(/^\.semgrep\//),
    }),
    command('semgrep-diff', 'npm', ['run', 'semgrep:diff', '--', base]),
    // Semgrep is the blocking security scanner. UBS remains complementary for
    // runtime bug classes without re-flagging literals and ordinary equality
    // throughout every touched file as security-critical false positives.
    command('ubs', 'ubs', ['--no-auto-update', '--skip-js=4,7', ...ubsPaths], {
      skip: ubsPaths.length === 0,
    }),
    command('tests', 'npm', ['test', '--', '--maxWorkers=4'], {
      skip: !scope.root_runtime,
      phase: GATE_PHASE.HEAVY,
    }),
  ];

  if (
    matches(
      /^(?:\.env\.example|src\/shared\/contracts\/runtime\.ts|src\/system\/config\/|src\/system\/settings(?:\.ts|\/)|src\/operator\/garden\/.*settings|admin-ui\/src\/.*settings)/,
    )
  ) {
    plan.push(command('settings-contract', 'npm', ['run', 'verify:settings-contract']));
  }
  if (
    matches(
      /(?:^|\/)package(?:-lock)?\.json$|(?:^|\/)Dockerfile[^/]*$|^deploy\/helm\/|^scripts\/verify-supply-chain\./,
    )
  ) {
    plan.push(
      command('supply-chain', 'npm', ['run', 'verify:supply-chain', '--', '--ref', base]),
    );
  }
  if (matches(/^(?:deploy\/helm\/|docker\/|scripts\/(?:verify-(?:helm|k8s|kube)|ops\/ship-kube))/)) {
    plan.push(
      command('deployment-contracts', 'npm', ['run', 'verify:deployment-contracts']),
    );
  }
  if (matches(/^admin-ui\//)) {
    plan.push(command('garden-ui', 'npm', ['run', 'verify:garden-ui']));
  }
  if (matches(/^companion-ui\//)) {
    plan.push(command('companion-ui', 'npm', ['run', 'verify:companion-ui']));
  }
  if (matches(/^\.github\/(?:workflows\/|actions\/)|^\.github\/dependabot\.yml$/)) {
    plan.push(
      command('changed-workflow-analysis', 'node', [
        'scripts/ci/run-zizmor-changed.mjs',
        ...workflowPaths,
      ]),
    );
  }
  return plan;
}

export function assessHookInstallation({ hooksPath, existingHooks }) {
  if (hooksPath && hooksPath !== '.githooks') {
    return {
      allowed: false,
      reason: `Refusing to replace custom hooksPath: ${hooksPath}`,
    };
  }
  if (!hooksPath && existingHooks.length > 0) {
    return {
      allowed: false,
      reason: `Refusing to disable existing hooks: ${existingHooks.join(', ')}`,
    };
  }
  return { allowed: true, reason: '' };
}

export function evaluateRequiredChecks({ expectedHead, actualHead, checks }) {
  if (actualHead !== expectedHead) {
    return {
      state: 'failed',
      reason: `PR head changed from ${expectedHead.slice(0, 12)} to ${actualHead.slice(0, 12)} while waiting.`,
    };
  }

  for (const requiredName of ['ci-required', 'Greptile Review']) {
    const check = checks.find(({ name }) => name === requiredName);
    if (!check || check.status !== 'COMPLETED') {
      return { state: 'pending', reason: `${requiredName} has not completed.` };
    }
    if (check.conclusion !== 'SUCCESS') {
      return {
        state: 'failed',
        reason: `${requiredName} concluded ${check.conclusion || 'without a result'}.`,
      };
    }
  }
  return { state: 'passed', reason: 'ci-required and Greptile Review passed.' };
}
