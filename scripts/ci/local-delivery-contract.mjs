import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectChangeScope } from './detect-change-scope.mjs';
import {
  EVALS_INPUTS,
  ROOT_BUILD_INPUTS,
  ROOT_LINT_INPUTS,
  ROOT_TEST_INPUTS,
  ROOT_TYPECHECK_INPUTS,
  SCRIPT_TEST_INPUTS,
  SEMGREP_RULE_INPUTS,
  specialistInputs,
} from './local-delivery-inputs.mjs';
import { buildRootValidationScope } from './local-delivery-scope.mjs';

export {
  GATE_VERSION,
  LOCAL_GATE_SCHEMA_VERSION,
  REMOTE_ATTESTATION_CONTEXT,
  STAGE_SCHEMA_VERSION,
  buildValidatedPushRefspec,
  createAttestation,
  createCanaryAttestation,
  evaluateRequiredChecks,
  gateCommandString,
  isStageReusable,
  parsePrePushUpdates,
  planPrePush,
  validateAttestation,
  validateRemoteAttestation,
} from './local-delivery-attestation.mjs';

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
export const HEAVY_PHASE_LOCK_DIR = join(tmpdir(), 'local-delivery-gate-heavy.lock');

// Root build (tsup) old-generation heap ceiling, in MB. tsup spawns the .d.ts
// rollup as a node worker_thread with no resourceLimits, so that worker's
// old-generation cap is derived from the parent --max-old-space-size. At 8192
// the derived cap sat right on the DTS working set and the root build flaked
// (ERR_WORKER_OUT_OF_MEMORY) once the bundled type graph grew. Measured peak
// RSS is ~5.5 GB and matches a passing main build, so this ceiling buys
// worker old-gen headroom, not real memory; do not lower it without
// re-verifying the DTS rollup has deterministic margin. GitHub trusts the exact
// local-gate attestation and deliberately does not repeat this build remotely.
export const ROOT_BUILD_NODE_HEAP_MB = 12288;

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
  const fullRoot = canary || scope.root_build_contract;
  const {
    changedRootTestFixtures,
    changedRootTests,
    companionIdTypes,
    rootIntegrationTests,
    rootProductTests,
    rootRuntimeBuild,
    rootScriptTests,
    rootTypecheck,
  } = buildRootValidationScope({ paths, fullRoot });
  const rootHygiene = fullRoot || scope.root_validation;
  const fullLint = fullRoot || matches(/^eslint[^/]*\.[cm]?[jt]s$/);
  const adminUi = canary || scope.admin_ui;
  const companionUi = canary || scope.companion_ui;
  const satelliteHub = canary || scope.satellite_hub;
  const evals = fullRoot || scope.evals;
  const ubsPaths = scannablePaths.filter((path) => /\.(?:[cm]?[jt]s|[jt]sx|svelte)$/.test(path));
  const workflowPaths = paths.filter((path) =>
    /^\.github\/(?:workflows\/.*\.ya?ml|actions\/.*\.ya?ml|dependabot\.yml)$/.test(path),
  );
  const plan = [
    command('ci-rules', 'npm', ['run', 'test:ci-rules'], { parallelSafe: true }),
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
      {
        parallelSafe: true,
        ...(canary ? { skip: true, skipReason: 'canary: origin/main has no diff to budget' } : {}),
      },
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
      {
        parallelSafe: true,
        ...(canary ? { skip: true, skipReason: 'canary: origin/main has no commit range' } : {}),
      },
    ),
    command('public-sanitize', 'npm', ['run', 'verify:public-sanitize'], { parallelSafe: true }),
    fullLint
      ? command('lint', 'npm', ['run', 'lint'], {
          nodeHeapMb: 6144,
          contentInputs: ROOT_LINT_INPUTS,
        })
      : command('lint-changed', 'npm', ['run', 'lint:changed', '--', '--base', base]),
    command('typecheck', 'npm', ['run', 'verify:typecheck-baseline'], {
      nodeHeapMb: 4096,
      skip: !rootTypecheck,
      contentInputs: ROOT_TYPECHECK_INPUTS,
    }),
    command('companion-id-types', 'npm', ['run', 'verify:companion-id-types'], {
      skip: fullRoot || !companionIdTypes,
      contentInputs: ROOT_BUILD_INPUTS,
    }),
    command('repository-hygiene', 'npm', ['run', 'verify:repository-hygiene:structural'], {
      skip: !rootHygiene,
    }),
    command(
      fullRoot ? 'build' : 'runtime-build',
      'npm',
      ['run', fullRoot ? 'build' : 'build:runtime'],
      {
        ...(fullRoot ? { nodeHeapMb: ROOT_BUILD_NODE_HEAP_MB } : {}),
        skip: !fullRoot && !rootRuntimeBuild,
        contentInputs: ROOT_BUILD_INPUTS,
      },
    ),
    command('startup-owner-files', 'npm', ['run', 'verify:startup-owner-files'], {
      parallelSafe: true,
    }),
    // Canary runs the semgrep ruleset self-test unconditionally (it validates the
    // committed rules, not a diff); otherwise it runs only when the rules change.
    command('semgrep-rules', 'npm', ['run', 'semgrep:test'], {
      skip: canary ? false : !matches(/^config\/semgrep\//),
      contentInputs: SEMGREP_RULE_INPUTS,
    }),
    command(
      'semgrep-diff',
      'npm',
      ['run', 'semgrep:diff', '--', base],
      {
        parallelSafe: true,
        ...(canary ? { skip: true, skipReason: 'canary: empty diff, nothing to scan' } : {}),
      },
    ),
    // Semgrep is the blocking security scanner. UBS remains complementary for
    // runtime bug classes without re-flagging literals and ordinary equality
    // throughout every touched file as security-critical false positives.
    command('ubs', 'ubs', ['--no-auto-update', '--skip-js=4,7', ...ubsPaths], {
      skip: ubsPaths.length === 0,
      parallelSafe: true,
      ...(canary ? { skipReason: 'canary: empty diff, no changed files to scan' } : {}),
    }),
    command('tests', 'npm', ['test', '--', '--maxWorkers=8', '--bail=1'], {
      skip: !fullRoot,
      phase: GATE_PHASE.HEAVY,
      contentInputs: ROOT_TEST_INPUTS,
    }),
    command('targeted-tests', 'npm', [
      'test',
      '--',
      ...changedRootTests,
      '--maxWorkers=8',
      '--bail=1',
    ], {
      skip: fullRoot || changedRootTests.length === 0,
      phase: GATE_PHASE.HEAVY,
      contentInputs: ROOT_TEST_INPUTS,
    }),
    command('related-tests', 'npm', [
      'exec',
      '--',
      'vitest',
      'related',
      ...changedRootTestFixtures,
      '--run',
      '--maxWorkers=8',
      '--bail=1',
    ], {
      skip: fullRoot || changedRootTestFixtures.length === 0,
      phase: GATE_PHASE.HEAVY,
      contentInputs: ROOT_TEST_INPUTS,
    }),
    command('unit-tests', 'npm', ['run', 'test:unit', '--', '--maxWorkers=8', '--bail=1'], {
      skip: fullRoot || !rootProductTests,
      phase: GATE_PHASE.HEAVY,
      contentInputs: ROOT_TEST_INPUTS,
    }),
    command('script-tests', 'npm', ['run', 'test:scripts', '--', '--maxWorkers=8', '--bail=1'], {
      skip: fullRoot || !rootScriptTests,
      phase: GATE_PHASE.HEAVY,
      contentInputs: SCRIPT_TEST_INPUTS,
    }),
    command(
      'integration-tests',
      'npm',
      ['run', 'test:integration', '--', '--maxWorkers=8', '--bail=1'],
      {
        skip: fullRoot || !rootIntegrationTests,
        phase: GATE_PHASE.HEAVY,
        contentInputs: ROOT_TEST_INPUTS,
      },
    ),
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
      /(?:^|\/)package(?:-lock)?\.json$|(?:^|\/)Dockerfile[^/]*$|^scripts\/verify-supply-chain\./,
    )
  ) {
    plan.push(
      command('supply-chain', 'npm', ['run', 'verify:supply-chain', '--', '--ref', base]),
    );
  }
  if (adminUi) {
    plan.push(command('garden-ui', 'npm', ['run', 'verify:garden-ui'], {
      contentInputs: specialistInputs('admin-ui'),
    }));
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
  if (companionUi) {
    plan.push(command('companion-ui', 'npm', ['run', 'verify:companion-ui'], {
      contentInputs: specialistInputs('companion-ui'),
    }));
  }
  if (satelliteHub) {
    plan.push(command('satellite-hub', 'npm', ['run', 'verify:satellite-hub'], {
      contentInputs: specialistInputs('apps/satellite-hub', { rootSource: false }),
    }));
  }
  if (evals) {
    plan.push(command('evals', 'npm', ['run', 'verify:evals'], {
      contentInputs: EVALS_INPUTS,
    }));
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
