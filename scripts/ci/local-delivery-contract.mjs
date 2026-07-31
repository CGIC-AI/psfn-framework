import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectChangeScope } from './detect-change-scope.mjs';

const SHA = /^[0-9a-f]{40}$/;
const ZERO_SHA = '0'.repeat(40);

// Bumped to 2 when stage-level attestation was introduced: the whole-gate
// attestation now also carries a gateVersion, so a v1 file (no gateVersion)
// must never validate against a v2 consumer. Fail closed on the older shape.
export const LOCAL_GATE_SCHEMA_VERSION = 2;
export const REMOTE_ATTESTATION_CONTEXT = 'local-gate/v1';

// Identity of the gate's own logic and command shapes. Bump this whenever the
// gate plan's semantics change (gates added/removed, a gate's command changes,
// or the meaning of a pass changes) so that every previously recorded stage
// result and whole-gate attestation is invalidated and forced to rerun. It is
// embedded in every stage record and in the final attestation; a mismatch is a
// hard reuse invalidation.
export const GATE_VERSION = 4;

// Schema version for a single per-stage record on disk. Independent of the
// whole-gate attestation schema so the two can evolve separately.
export const STAGE_SCHEMA_VERSION = 1;

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
    gateVersion: GATE_VERSION,
    head,
    base,
    baseRef,
    gates: [...gates],
    completedAt: new Date().toISOString(),
  };
}

export function validateAttestation(attestation, { head, base, gates, gateVersion = GATE_VERSION }) {
  if (!attestation || attestation.schemaVersion !== LOCAL_GATE_SCHEMA_VERSION) {
    return { valid: false, reason: 'Local gate attestation schema is missing or unsupported.' };
  }
  if (attestation.gateVersion !== gateVersion) {
    return { valid: false, reason: 'Local gate attestation gate version is stale.' };
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

// A canary attestation records that the FULL gate passed against origin/main
// itself (base == head, an empty diff). It is a distinct kind so it can never be
// mistaken for a branch attestation by validateAttestation, which requires a
// gates array this shape deliberately omits.
export function createCanaryAttestation({ base, mainRef }) {
  assertSha(base, 'base');
  if (!mainRef) throw new Error('mainRef is required');
  return {
    schemaVersion: LOCAL_GATE_SCHEMA_VERSION,
    kind: 'canary',
    gateVersion: GATE_VERSION,
    base,
    mainRef,
    completedAt: new Date().toISOString(),
  };
}

// Deterministic string identity of a gate's command, embedded in its stage
// record. Same head+base+gate-version already implies the same command, so this
// is defense in depth: any drift in the command shape (args, executable) that is
// not accompanied by a GATE_VERSION bump still invalidates reuse.
export function gateCommandString(gate) {
  return `${gate.executable} ${gate.args.join(' ')}`;
}

// A recorded stage result is reusable ONLY when it provably ran against the same
// exact head, base, gate version, AND command. Anything else — a changed head
// (a changed worktree produces a different head; the clean-tree guard forces
// commit-before-gate), a moved base, a bumped gate version, a corrupt/older
// record, or a drifted command — forces a rerun. There is no path-level
// cleverness: head-exact matching is the provable baseline.
export function isStageReusable(record, { head, base, gateVersion, command }) {
  return Boolean(
    record &&
      record.schemaVersion === STAGE_SCHEMA_VERSION &&
      record.gateVersion === gateVersion &&
      record.head === head &&
      record.base === base &&
      record.command === command,
  );
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
  isAncestor,
}) {
  const branchUpdates = updates.filter(({ remoteRef }) => remoteRef.startsWith('refs/heads/'));
  if (branchUpdates.length === 0) {
    return { action: 'allow', reason: 'No branch update requires validation.' };
  }
  if (branchUpdates.some(({ remoteRef }) => remoteRef === 'refs/heads/main')) {
    return { action: 'block', reason: 'Direct pushes to main are prohibited.' };
  }
  if (branchUpdates.some(({ localSha }) => localSha === ZERO_SHA)) {
    return {
      action: 'block',
      reason: 'Remote branch deletions are prohibited; preserve pushed checkpoints.',
    };
  }
  if (
    branchUpdates.length !== 1 ||
    branchUpdates[0].localSha !== head ||
    branchUpdates[0].remoteRef !== `refs/heads/${currentBranch}`
  ) {
    return {
      action: 'block',
      reason: 'Push exactly the checked-out branch HEAD to its same-name remote branch.',
    };
  }
  const [{ localSha, remoteSha }] = branchUpdates;
  if (remoteSha !== ZERO_SHA && !isAncestor(remoteSha, localSha)) {
    return {
      action: 'block',
      reason: 'Non-fast-forward checkpoint pushes are prohibited; pull/rebase without rewriting shared history.',
    };
  }
  return {
    action: 'allow',
    reason: 'Checkpoint push is a fast-forward update of the checked-out non-main branch.',
  };
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
  canary = false,
}) {
  const matches = (pattern) => paths.some((path) => pattern.test(path));
  const scope = detectChangeScope(paths);
  // Canary validates origin/main itself against an empty diff (base == head).
  // The whole-repo gates (lint, build, typecheck, repository-hygiene,
  // startup-owner-files, tests, ci-rules, and the semgrep ruleset self-test)
  // are meaningful independent of any diff, so canary forces them on. Every
  // diff-scoped gate is meaningless on an empty diff and is skipped EXPLICITLY
  // with a logged reason — never silently.
  const rootRuntime = canary || scope.root_runtime;
  const ubsPaths = scannablePaths.filter((path) => /\.(?:[cm]?[jt]s|[jt]sx|svelte)$/.test(path));
  const workflowPaths = paths.filter((path) =>
    /^\.github\/(?:workflows\/.*\.ya?ml|actions\/.*\.ya?ml|dependabot\.yml)$/.test(path),
  );
  const plan = [
    command('ci-rules', 'npm', ['run', 'test:ci-rules']),
    command(
      'change-budget',
      'npm',
      [
        'run',
        'verify:change-budget',
        '--',
        '--base',
        base,
        '--head',
        head,
        ...(changeBudgetException ? ['--exception'] : []),
      ],
      canary ? { skip: true, skipReason: 'canary: origin/main has no diff to budget' } : {},
    ),
    command(
      'commit-identities',
      'npm',
      [
        'run',
        'verify:commit-identities',
        '--',
        '--base',
        base,
        '--head',
        head,
      ],
      canary ? { skip: true, skipReason: 'canary: origin/main has no commit range' } : {},
    ),
    rootRuntime
      ? command('lint', 'npm', ['run', 'lint'], { nodeHeapMb: 6144 })
      : command('lint-changed', 'npm', ['run', 'lint:changed', '--', '--base', base]),
    ...(rootRuntime
      ? [
          command('build', 'npm', ['run', 'build'], { nodeHeapMb: 4096 }),
          command('typecheck', 'npm', ['run', 'verify:typecheck-baseline'], {
            nodeHeapMb: 4096,
          }),
          command('repository-hygiene', 'npm', ['run', 'verify:repository-hygiene']),
        ]
      : []),
    command('startup-owner-files', 'npm', ['run', 'verify:startup-owner-files']),
    // Canary runs the semgrep ruleset self-test unconditionally (it validates the
    // committed rules, not a diff); otherwise it runs only when the rules change.
    command('semgrep-rules', 'npm', ['run', 'semgrep:test'], {
      skip: canary ? false : !matches(/^\.semgrep\//),
    }),
    command(
      'semgrep-diff',
      'npm',
      ['run', 'semgrep:diff', '--', base],
      canary ? { skip: true, skipReason: 'canary: empty diff, nothing to scan' } : {},
    ),
    // Semgrep is the blocking security scanner. UBS remains complementary for
    // runtime bug classes without re-flagging literals and ordinary equality
    // throughout every touched file as security-critical false positives.
    command('ubs', 'ubs', ['--no-auto-update', '--skip-js=4,7', ...ubsPaths], {
      skip: ubsPaths.length === 0,
      ...(canary ? { skipReason: 'canary: empty diff, no changed files to scan' } : {}),
    }),
    command('tests', 'npm', ['test', '--', '--maxWorkers=8', '--bail=1'], {
      skip: !rootRuntime,
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
  if (
    matches(
      /^(?:src\/boundary\/fleet-auth\/garden-route-capabilities\.ts|admin-ui\/src\/lib\/api\/)/,
    )
  ) {
    plan.push(
      command(
        'garden-route-body-policy',
        'npm',
        ['run', 'test:garden:route-body-policy'],
      ),
    );
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
