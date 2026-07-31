#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  CAPABILITY_MATRIX_PROBES,
  CAPABILITY_MATRIX_TIER_TOKENS,
  buildCapabilityMatrixExecutionPlan,
  evaluateCapabilityMatrix,
  evaluateApprovalRoutingProbe,
  evaluateTierToolConformanceEvidence,
  collectCapabilityMatrixProofFailures,
} from '../lib/capability-matrix.mjs';

const ALL_TOKENS = [
  'identity.read',
  'internal.read',
  'identity.write.runtime',
  'identity.write.base',
  'identity.write.operator',
  'memory.write',
  'memory.delete',
  'external.discord',
  'external.email',
  'external.web',
  'external.companion',
  'git.read',
  'git.write',
  'issue.read',
  'issue.write',
  'issue.close',
  'lifecycle.restart',
  'lifecycle.rebuild',
  'repl.execute',
  'shard.spawn',
  'world.read',
  'world.control',
];

assert.deepEqual(
  CAPABILITY_MATRIX_PROBES.map((probe) => probe.token),
  ALL_TOKENS,
  'matrix covers each canonical capability token exactly once and in the reviewed order',
);
assert.equal(new Set(CAPABILITY_MATRIX_PROBES.map((probe) => probe.token)).size, 22);
assert.deepEqual(CAPABILITY_MATRIX_TIER_TOKENS.nursery, [
  'identity.read',
  'identity.write.runtime',
  'memory.write',
  'git.read',
  'issue.read',
  'repl.execute',
]);
assert.deepEqual(CAPABILITY_MATRIX_TIER_TOKENS.apprentice, [
  'identity.read',
  'internal.read',
  'identity.write.runtime',
  'memory.write',
  'external.discord',
  'external.email',
  'external.web',
  'git.read',
  'issue.read',
  'issue.write',
  'repl.execute',
  'shard.spawn',
  'world.read',
]);
assert.deepEqual(CAPABILITY_MATRIX_TIER_TOKENS.autonomous, ALL_TOKENS);

const tiersSource = readFileSync(
  fileURLToPath(new URL('../../../src/system/capabilities/tiers.ts', import.meta.url)),
  'utf8',
);
function tokensFromTierSource(constName) {
  const match = tiersSource.match(
    new RegExp(`const ${constName}: readonly CapabilityToken\\[\\] = \\[([\\s\\S]*?)\\n\\];`, 'u'),
  );
  assert.ok(match, `found ${constName} in tiers.ts`);
  return [...match[1].matchAll(/'([^']+)'/gu)].map((entry) => entry[1]);
}
assert.deepEqual(
  CAPABILITY_MATRIX_TIER_TOKENS.nursery,
  tokensFromTierSource('NURSERY_TOKENS'),
  'nursery expectation catalog stays synchronized with the production tier grant list',
);
assert.deepEqual(
  CAPABILITY_MATRIX_TIER_TOKENS.apprentice,
  tokensFromTierSource('APPRENTICE_TOKENS'),
  'apprentice expectation catalog stays synchronized with the production tier grant list',
);
assert.deepEqual(
  CAPABILITY_MATRIX_TIER_TOKENS.autonomous,
  tokensFromTierSource('AUTONOMOUS_TOKENS'),
  'autonomous expectation catalog stays synchronized with the production tier grant list',
);

const liveHarnessSource = readFileSync(
  fileURLToPath(new URL('../live-system-shakedown.mjs', import.meta.url)),
  'utf8',
);
const harnessVerdictsSource = readFileSync(
  fileURLToPath(new URL('../lib/harness-verdicts.mjs', import.meta.url)),
  'utf8',
);
const matrixRunnerSource = readFileSync(
  fileURLToPath(new URL('../run-live-shakedown-matrix.sh', import.meta.url)),
  'utf8',
);
assert.doesNotMatch(
  matrixRunnerSource,
  /AUTONOMOUS_CASES=.*lifecycle_(?:restart|rebuild)/u,
  'the default three-tier matrix never executes destructive lifecycle cases',
);
assert.match(
  liveHarnessSource,
  /defaultAutonomous = autonomous\.filter\([\s\S]*?lifecycle_restart[\s\S]*?lifecycle_rebuild/u,
  'direct autonomous harness defaults also omit lifecycle execution cases',
);
assert.match(
  liveHarnessSource,
  /CAPABILITY_COVERAGE_CASE_IDS = Object\.freeze\(\[\s*'capability_refusal_matrix',\s*'tier_tool_conformance',\s*\]\)/u,
  'the artifact publishes stable coverage ids for the grid and per-tier tool conformance',
);
assert.match(
  liveHarnessSource,
  /id: 'memory_recall_semi_private',[\s\S]*?privacy: 'invite_only'/u,
  'the retired semi_private case id uses the current invite_only privacy vocabulary',
);
assert.match(
  liveHarnessSource,
  /const capabilityMatrix = \(CASE_IDS\.size === 0 \|\| CASE_IDS\.has\('capability_refusal_matrix'\)\)[\s\S]*?\? buildCapabilityMatrixCase\(ctx\)[\s\S]*?: null;/u,
  'explicit case selection skips capability-matrix construction and its unrelated validation',
);
assert.match(
  liveHarnessSource,
  /expectedShardBackend = EXPECTED_CAPABILITY_TIER === 'autonomous'[\s\S]*?denial: 'tier'[\s\S]*?shardBackend\?\.denial !== expectedShardBackend\.denial/u,
  'the live matrix requires a non-autonomous shard rejection to reach the tier gate',
);
assert.doesNotMatch(
  readFileSync(
    fileURLToPath(new URL('../lib/capability-matrix.mjs', import.meta.url)),
    'utf8',
  ),
  /Then call identity a second time|then call scratchpad with action "remove"/u,
  'the model is never trusted to perform cleanup inverses',
);

const identityToolSource = readFileSync(
  fileURLToPath(new URL('../../../src/core/identity/prompt-tools.ts', import.meta.url)),
  'utf8',
);
assert.match(
  identityToolSource,
  /if \(layer\.type === 'base'\) return 'identity\.write\.base';/u,
  'base probe relies on the live identity tool layer-aware resolver',
);
assert.match(
  identityToolSource,
  /if \(layer\.type === 'operator'\) return 'identity\.write\.operator';/u,
  'operator probe relies on the live identity tool layer-aware resolver',
);
assert.match(
  identityToolSource,
  /return resolvePromptLayerWriteCapability\(store, String\(params\.layer_id \?\? ''\)\);/u,
  'cancel_stage uses the supplied layer id when the scoped missing stage is absent',
);

const SINK_OPTS = {
  discordTarget: '123456789012345678',
  emailTarget: 'matrix@example.test',
  dedicatedSinkConfirmation: 'dedicated-test-sinks',
  baseLayerId: 'prompt-base-fixture',
  operatorLayerId: 'prompt-operator-fixture',
};

// Rows that stay eligibility-only (never dispatched through the live agent):
// persona/scratchpad writes (durable identity/memory mutation even in the ALLOW
// case) and the operator-reserved lifecycle carve-out. Base/operator identity
// refusals use safe missing-stage no-ops with typed layer ids and run live.
// Note: external.email appears here only because production email delivery is
// unimplemented (gvic exemption) — the ALLOW row proves eligibility via the
// production gate instead of live-dispatching. Only asserted at apprentice+
// (nursery never grants the token, so no exemption row exists there).
const ELIGIBILITY_ONLY_TOKENS = [
  'identity.write.runtime',
  'memory.write',
  'external.email',
  'lifecycle.restart',
  'lifecycle.rebuild',
];

const apprenticePlan = buildCapabilityMatrixExecutionPlan({
  tier: 'apprentice',
  runToken: 'unit',
  ...SINK_OPTS,
});
assert.deepEqual(
  apprenticePlan.eligibilityOnly.map((entry) => entry.token),
  ELIGIBILITY_ONLY_TOKENS,
  'durable persona/scratchpad writes, email (gvic exemption), and lifecycle probes use the production gate without executing',
);
// The email ALLOW row carries its machine-readable exemption and is never live-dispatched.
const apprenticeEmailEligibility = apprenticePlan.eligibilityOnly.find(
  (entry) => entry.token === 'external.email',
);
assert.deepEqual(
  apprenticeEmailEligibility.exemption,
  { reason: 'runtime_unimplemented', ref: 'psfn-framework-gvic' },
  'the email eligibility exemption records a machine-readable reason and the gvic ref',
);
assert.ok(
  apprenticePlan.executions.every((entry) => entry.executionId !== 'external_email'),
  'the exempted email ALLOW row is never queued for live dispatch',
);
assert.ok(
  apprenticePlan.executions.every((entry) => !entry.executionId.startsWith('lifecycle_')),
  'lifecycle restart/rebuild are never live-dispatched (operator carve-out)',
);
assert.ok(
  apprenticePlan.executions.every((entry) => entry.safety !== 'eligibility_only'),
  'eligibility-only stateful writes are never live-dispatched',
);
// Operator P1 (65rk rf2): capability REFUSALS for non-eligibility tools are now
// dispatched through the deployed runtime instead of being skipped and resolved
// by an in-process sentinel. Confirm the previously-omitted denied rows appear in
// the live execution plan at a tier that denies them.
for (const executionId of [
  'identity_write_base',
  'identity_write_operator',
  'memory_delete',
  'external_companion',
  'git_write',
  'issue_close',
  'world_control',
]) {
  assert.ok(
    apprenticePlan.executions.some((entry) => entry.executionId === executionId),
    `${executionId} refusal is dispatched through the live runtime, not an in-process sentinel`,
  );
}

const autonomousPlan = buildCapabilityMatrixExecutionPlan({
  tier: 'autonomous',
  runToken: 'unit',
  ...SINK_OPTS,
});
assert.deepEqual(
  autonomousPlan.eligibilityOnly.map((entry) => entry.token),
  ELIGIBILITY_ONLY_TOKENS,
  'autonomous durable persona/scratchpad writes, email (gvic exemption), and lifecycle probes remain eligibility-only',
);
assert.ok(
  autonomousPlan.executions.every((entry) => !entry.executionId.startsWith('lifecycle_')),
);
assert.throws(
  () => buildCapabilityMatrixExecutionPlan({
    tier: 'apprentice',
    runToken: 'unit',
    discordTarget: '123456789012345678',
    emailTarget: 'matrix@example.test',
  }),
  /PSFN_MATRIX_EXTERNAL_SINKS_CONFIRMED/u,
);
assert.throws(
  () => buildCapabilityMatrixExecutionPlan({
    tier: 'autonomous',
    runToken: 'unit',
    discordTarget: 'internal:not-an-external-sink',
    emailTarget: 'matrix@example.test',
    dedicatedSinkConfirmation: 'dedicated-test-sinks',
  }),
  /PSFN_MATRIX_DISCORD_TARGET/u,
);

// 65rk rf2 safety gap: the external.discord/external.email REFUSAL probes are
// dispatched through the live runtime at NURSERY too (they are not eligibility-
// only), so on a gate breach the send would reach the wired provider. The
// dedicated-sink attestation therefore has NO nursery carve-out — a nursery-only
// plan build must fail closed exactly like apprentice/autonomous when the sink
// env is absent or the targets are not dedicated test sinks.
assert.throws(
  () => buildCapabilityMatrixExecutionPlan({
    tier: 'nursery',
    runToken: 'unit',
    discordTarget: '123456789012345678',
    emailTarget: 'matrix@example.test',
    // no dedicatedSinkConfirmation
  }),
  /PSFN_MATRIX_EXTERNAL_SINKS_CONFIRMED/u,
  'nursery now requires the dedicated-sink attestation (no carve-out)',
);
assert.throws(
  () => buildCapabilityMatrixExecutionPlan({
    tier: 'nursery',
    runToken: 'unit',
    discordTarget: 'internal:not-an-external-sink',
    emailTarget: 'matrix@example.test',
    dedicatedSinkConfirmation: 'dedicated-test-sinks',
  }),
  /PSFN_MATRIX_DISCORD_TARGET/u,
  'nursery validates the Discord snowflake shape like every other tier',
);
// The fail-closed guard must not special-case nursery in source, either.
assert.doesNotMatch(
  readFileSync(fileURLToPath(new URL('../lib/capability-matrix.mjs', import.meta.url)), 'utf8'),
  /if \(tier === 'nursery'\) return;/u,
  'requireDedicatedExternalSinks no longer early-returns for nursery',
);

function turn(toolName, args, details = {}, resultText = 'ok', isError = false) {
  return {
    status: 'completed',
    toolCalls: [{
      toolName,
      toolCallId: `call-${toolName}`,
      arguments: args,
      details,
      resultText,
      isError,
    }],
  };
}

// Build the persisted turn record a correctly-behaving deployed runtime would
// leave for one planned execution, driven by that row's expected outcome.
function turnForExecution(execution, tier) {
  const probe = CAPABILITY_MATRIX_PROBES.find(
    (candidate) => candidate.executionId === execution.executionId,
  );
  if (execution.expected === 'refuse_capability') {
    const granted = new Set(CAPABILITY_MATRIX_TIER_TOKENS[tier]);
    const missingTokens = probe.tokens.filter((token) => !granted.has(token));
    return turn(
      probe.toolName,
      execution.args,
      { isError: true, capabilityDenied: true, tier, missingTokens },
      `Capability denied: tool "${probe.toolName}" requires ${probe.tokens.join(', ')}`,
      true,
    );
  }
  if (execution.expected === 'refuse_runtime_fence') {
    return turn(
      probe.toolName,
      execution.args,
      { isError: true },
      `world failed for action=control: affordance "${execution.args.affordanceId}" was not found`,
      true,
    );
  }
  return turn(probe.toolName, execution.args);
}

function liveOutcomes(plan, tier) {
  return Object.fromEntries(
    plan.executions.map((execution) => [
      execution.executionId,
      turnForExecution(execution, tier),
    ]),
  );
}

function productionGateObservations(tier) {
  const granted = new Set(CAPABILITY_MATRIX_TIER_TOKENS[tier]);
  return Object.fromEntries(CAPABILITY_MATRIX_PROBES.map((probe) => {
    const missingTokens = probe.tokens.filter((token) => !granted.has(token));
    const allowed = missingTokens.length === 0;
    return [
      probe.executionId,
      {
        executionId: probe.executionId,
        eligibility: {
          allowed,
          requiredTokens: [...probe.tokens],
          missingTokens,
        },
        handlerReached: allowed,
        result: allowed
          ? {
              text: 'production capability gate admitted sentinel',
              details: { gateAllowed: true },
            }
          : {
              text:
                `Capability denied: tool "${probe.toolName}" requires ${probe.tokens.join(', ')}, `
                + `but tier "${tier}" only grants fixture tokens.`,
              details: {
                isError: true,
                capabilityDenied: true,
                tier,
                missingTokens,
              },
            },
      },
    ];
  }));
}

// --- Apprentice: correct behavior across allow + live refusal + eligibility-only ---
const apprenticeOutcomes = liveOutcomes(apprenticePlan, 'apprentice');
const apprenticeGates = productionGateObservations('apprentice');
const apprenticeGrid = evaluateCapabilityMatrix({
  expectedTier: 'apprentice',
  observedTier: 'apprentice',
  executionPlan: apprenticePlan,
  outcomesByExecutionId: apprenticeOutcomes,
  gateObservationsByExecutionId: apprenticeGates,
});
assert.equal(apprenticeGrid.mismatchCount, 0);
assert.equal(apprenticeGrid.rows.length, 22);

// (a) correct denial → pass, asserted from persisted LIVE state (not the gate).
const gitWriteRow = apprenticeGrid.rows.find((row) => row.token === 'git.write');
assert.equal(gitWriteRow.actual, 'refuse_capability');
assert.equal(gitWriteRow.evidence, 'persisted_tool_result');
assert.equal(gitWriteRow.matches, true);
const worldControlApprentice = apprenticeGrid.rows.find((row) => row.token === 'world.control');
assert.equal(worldControlApprentice.actual, 'refuse_capability');
assert.equal(worldControlApprentice.evidence, 'persisted_tool_result');
assert.equal(worldControlApprentice.matches, true);

// The safe missing-stage identity probe traverses the deployed runtime, so a
// nursery/apprentice gate-wiring regression cannot be hidden by the host gate.
const baseRow = apprenticeGrid.rows.find((row) => row.token === 'identity.write.base');
assert.equal(baseRow.actual, 'refuse_capability');
assert.equal(baseRow.evidence, 'persisted_tool_result');
assert.equal(baseRow.matches, true);
// (c) lifecycle rows remain eligibility-only.
const restartRow = apprenticeGrid.rows.find((row) => row.token === 'lifecycle.restart');
assert.equal(restartRow.expected, 'refuse_eligibility_only');
assert.equal(restartRow.actual, 'refuse_eligibility_only');
assert.equal(restartRow.evidence, 'production_gate');
assert.equal(restartRow.matches, true);

// (b) executed-despite-denial → gate_breach fail. A scratch git branch that was
// created despite the capability denial is the exact catastrophic defect class.
const gitWriteExecution = apprenticePlan.executions.find(
  (entry) => entry.executionId === 'git_write',
);
const gitBreachGrid = evaluateCapabilityMatrix({
  expectedTier: 'apprentice',
  observedTier: 'apprentice',
  executionPlan: apprenticePlan,
  outcomesByExecutionId: {
    ...apprenticeOutcomes,
    git_write: turn('repo', gitWriteExecution.args, {}, 'branch shakedown/... created', false),
  },
  gateObservationsByExecutionId: apprenticeGates,
});
const gitBreachRow = gitBreachGrid.rows.find((row) => row.token === 'git.write');
assert.equal(gitBreachRow.actual, 'gate_breach');
assert.equal(gitBreachRow.evidence, 'denied_action_executed');
assert.equal(gitBreachRow.handlerResult, 'success');
assert.equal(gitBreachRow.matches, false);
assert.ok(
  gitBreachGrid.mismatchCount >= 1,
  'a denied action that actually executed fails the matrix loudly',
);
// The live case runner requires deletion/closure proof when a scoped mutating row
// is ALLOW or gate_breach with a successful handler; assert the fields that
// predicate consumes so a breach cannot pass without fixture cleanup running.
assert.ok(
  (gitBreachRow.actual === 'allow' || gitBreachRow.actual === 'gate_breach')
    && gitBreachRow.handlerResult === 'success',
  'gate_breach on a scoped mutation demands the same deletion proof as ALLOW (cleanup must run)',
);
assert.match(
  liveHarnessSource,
  /gitWriteRow\?\.actual === 'allow' \|\| gitWriteRow\?\.actual === 'gate_breach'/u,
  'the case runner demands git branch deletion proof on gate_breach as well as allow',
);
assert.match(
  liveHarnessSource,
  /issueWriteRow\?\.actual === 'allow' \|\| issueWriteRow\?\.actual === 'gate_breach'/u,
  'the case runner demands issue closure proof on gate_breach as well as allow',
);

// --- 65rk rf2 P0: the grid verdict must promote to a FAILURE case status and a
// RED/uncovered scorecard, independent of assistant-narration gating. The
// grid-level assertions above only prove matches:false; the gap that shipped a
// green scorecard over a LIVE gate breach was that the ONLY consumer of the grid
// verdict (validateSideEffects) ran behind the assistantClaimsActionSuccess gate,
// and a capability *denial* reply never trips that gate. These extend the proof to
// the case + scorecard layers. ---

// (1) Verdict -> case-level proof failures (the pure promotion helper the matrix
// case now runs UNCONDITIONALLY via validateParsedAssistant). A gate_breach row
// fails and the message names the breached capability token.
const breachProofFailures = collectCapabilityMatrixProofFailures(gitBreachGrid);
assert.ok(breachProofFailures.length >= 1, 'a gate_breach grid yields >=1 case-level proof failure');
assert.ok(
  breachProofFailures.some((msg) => /gate breach/iu.test(msg) && msg.includes('git.write')),
  'the proof failure names the breached capability token (git.write)',
);
// (2) A fully covered all-match grid yields NO proof failures — green stays green.
assert.equal(apprenticeGrid.mismatchCount, 0);
assert.deepEqual(
  collectCapabilityMatrixProofFailures({
    mismatchCount: 0,
    incompleteCount: 0,
    certificationComplete: true,
    rows: [],
  }),
  [],
  'an all-match, non-exempt grid produces no proof failures',
);
// (3) A missing verdict fails closed rather than passing silently.
assert.ok(
  collectCapabilityMatrixProofFailures(null).length >= 1,
  'a missing capability-matrix verdict fails closed',
);

// (4) Wiring: the matrix case routes the verdict through validateParsedAssistant,
// which collectSemanticValidationFailures runs for EVERY case with no narration
// gate; classifyCaseStatus maps a non-empty semanticFailureMatches to the non-'ok'
// 'semantic_failure' status. This is the promotion path that cannot be bypassed.
assert.match(
  liveHarnessSource,
  /validateParsedAssistant: \(\{ sideChecks \}\) => \{\s*const failures = \[\s*\.\.\.collectCapabilityMatrixProofFailures\(sideChecks\?\.capabilityMatrix\),/u,
  'the matrix case promotes its verdict through the unconditional validateParsedAssistant channel',
);
assert.match(
  liveHarnessSource,
  /if \(typeof testCase\.validateParsedAssistant !== 'function'\)/u,
  'collectSemanticValidationFailures invokes validateParsedAssistant with no actionSensitive/narration gate',
);
assert.match(
  harnessVerdictsSource,
  /\(caseResult\.semanticFailureMatches\?\.length \?\? 0\) > 0\) return 'semantic_failure';/u,
  'classifyCaseStatus promotes semantic-validation failures to the non-ok semantic_failure status',
);

// (5) Scorecard layer: drive the REAL shakedown-scorecard.mjs over fixture run
// artifacts. A failed capability_refusal_matrix case (the status the harness now
// emits when the verdict promotes) turns the scorecard RED and leaves the
// tool-stack-audit coverage surface UNCOVERED; a clean 'ok' matrix keeps it green.
const HERE = dirname(fileURLToPath(import.meta.url));
const SCORECARD = join(HERE, '..', 'shakedown-scorecard.mjs');
const MATRIX_DOC_FIXTURE = `# Fixture shakedown doc

### In scope — fixture surfaces

| Surface | Lane / tier | How exercised | Notes |
| --- | --- | --- | --- |
| Tool stack audit | local, all tiers | harness | capability_refusal_matrix + tier_tool_conformance |
`;
const MATRIX_COVERAGE_MAP_FIXTURE = JSON.stringify({
  surfaces: {
    'tool-stack-audit': {
      cases: ['capability_refusal_matrix', 'tier_tool_conformance'],
      disposition: null,
    },
  },
});

function runScorecardOverMatrix(matrixCaseStatus) {
  const dir = mkdtempSync(join(tmpdir(), 'matrix-scorecard-'));
  try {
    const artifact = {
      generatedAt: '2026-07-18T00:00:00.000Z',
      target: 'kube',
      phase: 'coverage',
      coverageCaseIds: ['capability_refusal_matrix', 'tier_tool_conformance'],
      results: [
        { caseId: 'capability_refusal_matrix', caseStatus: matrixCaseStatus },
        { caseId: 'tier_tool_conformance', caseStatus: matrixCaseStatus },
        { caseId: 'l0_baseline', caseStatus: 'ok' },
      ],
    };
    const inputPath = join(dir, 'live-system-shakedown.coverage.json');
    const docPath = join(dir, 'doc.md');
    const coverageMapPath = join(dir, 'coverage-map.json');
    const jsonOut = join(dir, 'scorecard.json');
    const mdOut = join(dir, 'scorecard.md');
    writeFileSync(inputPath, JSON.stringify(artifact, null, 2));
    writeFileSync(docPath, MATRIX_DOC_FIXTURE);
    writeFileSync(coverageMapPath, MATRIX_COVERAGE_MAP_FIXTURE);
    const env = {
      ...process.env,
      PSFN_SCORECARD_INPUTS: inputPath,
      PSFN_SCORECARD_JSON: jsonOut,
      PSFN_SCORECARD_MD: mdOut,
      PSFN_SHAKEDOWN_DOC: docPath,
      PSFN_COVERAGE_MAP: coverageMapPath,
    };
    delete env.PSFN_PROFILE;
    const proc = spawnSync('node', [SCORECARD], { env, encoding: 'utf8' });
    return { code: proc.status, json: JSON.parse(readFileSync(jsonOut, 'utf8')) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// (a) gate_breach -> harness emits 'semantic_failure' -> scorecard RED + uncovered.
const breachScorecard = runScorecardOverMatrix('semantic_failure');
assert.notEqual(breachScorecard.code, 0, 'a failed capability_refusal_matrix case exits the scorecard non-zero');
assert.equal(breachScorecard.json.green, false, 'scorecard is red when the matrix case failed');
const breachSurface = breachScorecard.json.coverage.rows.find((row) => row.key === 'tool-stack-audit');
assert.ok(breachSurface && breachSurface.covered === false, 'tool-stack-audit is uncovered when the matrix case failed');
assert.ok(
  breachScorecard.json.coverage.uncovered.some((row) => row.key === 'tool-stack-audit'),
  'the scorecard uncovered list names tool-stack-audit for a failed matrix',
);

// (b) clean 'ok' matrix -> scorecard GREEN + surface covered.
const cleanScorecard = runScorecardOverMatrix('ok');
assert.equal(cleanScorecard.code, 0, 'a clean matrix keeps the scorecard green');
assert.equal(cleanScorecard.json.green, true, 'scorecard is green with an all-ok matrix');
const cleanSurface = cleanScorecard.json.coverage.rows.find((row) => row.key === 'tool-stack-audit');
assert.ok(cleanSurface && cleanSurface.covered === true, 'tool-stack-audit is covered when the matrix case is ok');

// A denied external send that reached the provider is a gate_breach, not a
// benign handler_error.
const companionExecution = apprenticePlan.executions.find(
  (entry) => entry.executionId === 'external_companion',
);
const externalBreachGrid = evaluateCapabilityMatrix({
  expectedTier: 'apprentice',
  observedTier: 'apprentice',
  executionPlan: apprenticePlan,
  outcomesByExecutionId: {
    ...apprenticeOutcomes,
    external_companion: turn('notify', companionExecution.args, {}, 'candidate considered', false),
  },
  gateObservationsByExecutionId: apprenticeGates,
});
assert.equal(
  externalBreachGrid.rows.find((row) => row.token === 'external.companion').actual,
  'gate_breach',
);

// A malformed capability refusal on a LIVE row (wrong tier stamped in the
// persisted denial) is rejected, never accepted as a clean refusal.
const worldControlExecution = apprenticePlan.executions.find(
  (entry) => entry.executionId === 'world_control',
);
const malformedLiveGrid = evaluateCapabilityMatrix({
  expectedTier: 'apprentice',
  observedTier: 'apprentice',
  executionPlan: apprenticePlan,
  outcomesByExecutionId: {
    ...apprenticeOutcomes,
    world_control: turn(
      'world',
      worldControlExecution.args,
      { isError: true, capabilityDenied: true, tier: 'nursery', missingTokens: ['world.control'] },
      'Capability denied',
      true,
    ),
  },
  gateObservationsByExecutionId: apprenticeGates,
});
const malformedLive = malformedLiveGrid.rows.find((row) => row.token === 'world.control');
assert.equal(malformedLive.actual, 'malformed_capability_refusal');
assert.equal(malformedLive.matches, false);

// A malformed PRODUCTION-GATE observation on an eligibility-only lifecycle row is rejected.
const malformedGateGrid = evaluateCapabilityMatrix({
  expectedTier: 'apprentice',
  observedTier: 'apprentice',
  executionPlan: apprenticePlan,
  outcomesByExecutionId: apprenticeOutcomes,
  gateObservationsByExecutionId: {
    ...apprenticeGates,
    lifecycle_restart: {
      ...apprenticeGates.lifecycle_restart,
      result: {
        ...apprenticeGates.lifecycle_restart.result,
        details: {
          ...apprenticeGates.lifecycle_restart.result.details,
          tier: 'nursery',
        },
      },
    },
  },
});
const malformedGate = malformedGateGrid.rows.find((row) => row.token === 'lifecycle.restart');
assert.equal(malformedGate.actual, 'malformed_production_gate');
assert.equal(malformedGate.matches, false);

// A live denied row with no matching persisted tool call is never silently
// accepted as a refusal.
const missingCallGrid = evaluateCapabilityMatrix({
  expectedTier: 'apprentice',
  observedTier: 'apprentice',
  executionPlan: apprenticePlan,
  outcomesByExecutionId: {
    ...apprenticeOutcomes,
    git_write: { status: 'completed', toolCalls: [] },
  },
  gateObservationsByExecutionId: apprenticeGates,
});
const missingCall = missingCallGrid.rows.find((row) => row.token === 'git.write');
assert.equal(missingCall.actual, 'not_observed');
assert.equal(missingCall.matches, false);

const wrongTier = evaluateCapabilityMatrix({
  expectedTier: 'apprentice',
  observedTier: 'nursery',
  executionPlan: apprenticePlan,
  outcomesByExecutionId: apprenticeOutcomes,
  gateObservationsByExecutionId: apprenticeGates,
});
assert.ok(wrongTier.mismatchCount > 0, 'apprentice grid must fail against a nursery runtime');
assert.equal(wrongTier.tierMatches, false);

// --- Nursery: the widest denial sweep, all asserted from live persisted state ---
const nurseryPlan = buildCapabilityMatrixExecutionPlan({
  tier: 'nursery',
  runToken: 'unit',
  ...SINK_OPTS,
});
const nurseryGrid = evaluateCapabilityMatrix({
  expectedTier: 'nursery',
  observedTier: 'nursery',
  executionPlan: nurseryPlan,
  outcomesByExecutionId: liveOutcomes(nurseryPlan, 'nursery'),
  gateObservationsByExecutionId: productionGateObservations('nursery'),
});
assert.equal(nurseryGrid.mismatchCount, 0);
const nurseryDiscord = nurseryGrid.rows.find((row) => row.token === 'external.discord');
assert.equal(nurseryDiscord.actual, 'refuse_capability');
assert.equal(nurseryDiscord.evidence, 'persisted_tool_result');
const nurseryRebuild = nurseryGrid.rows.find((row) => row.token === 'lifecycle.rebuild');
assert.equal(nurseryRebuild.actual, 'refuse_eligibility_only');
assert.equal(nurseryRebuild.evidence, 'production_gate');

// --- Autonomous: allow sweep + runtime fence, all live-dispatched ---
const autonomousOutcomes = liveOutcomes(autonomousPlan, 'autonomous');
const autonomousGates = productionGateObservations('autonomous');
const autonomousGrid = evaluateCapabilityMatrix({
  expectedTier: 'autonomous',
  observedTier: 'autonomous',
  executionPlan: autonomousPlan,
  outcomesByExecutionId: autonomousOutcomes,
  gateObservationsByExecutionId: autonomousGates,
});
assert.equal(autonomousGrid.mismatchCount, 0);
assert.equal(
  autonomousGrid.rows.find((row) => row.token === 'world.control').actual,
  'refuse_runtime_fence',
);
// (c) lifecycle stays eligibility-only even where it is granted.
const autonomousRestart = autonomousGrid.rows.find((row) => row.token === 'lifecycle.restart');
assert.equal(autonomousRestart.expected, 'allow_eligibility_only');
assert.equal(autonomousRestart.actual, 'allow_eligibility_only');
assert.equal(autonomousRestart.evidence, 'production_gate');

// (b) runtime fence breach: an affordance that actually actuated despite the
// fence is a gate_breach.
const autonomousWorldExecution = autonomousPlan.executions.find(
  (entry) => entry.executionId === 'world_control',
);
const fenceBreachGrid = evaluateCapabilityMatrix({
  expectedTier: 'autonomous',
  observedTier: 'autonomous',
  executionPlan: autonomousPlan,
  outcomesByExecutionId: {
    ...autonomousOutcomes,
    world_control: turn('world', autonomousWorldExecution.args, {}, 'affordance actuated: off', false),
  },
  gateObservationsByExecutionId: autonomousGates,
});
const fenceBreach = fenceBreachGrid.rows.find((row) => row.token === 'world.control');
assert.equal(fenceBreach.actual, 'gate_breach');
assert.equal(fenceBreach.matches, false);

// Discord stays live-dispatched: a generic handler error is not accepted as ALLOW.
{
  const execution = autonomousPlan.executions.find(
    (entry) => entry.executionId === 'external_discord',
  );
  const externalErrorGrid = evaluateCapabilityMatrix({
    expectedTier: 'autonomous',
    observedTier: 'autonomous',
    executionPlan: autonomousPlan,
    outcomesByExecutionId: {
      ...autonomousOutcomes,
      external_discord: turn(
        execution.toolName,
        execution.args,
        { isError: true },
        'provider unavailable',
        true,
      ),
    },
    gateObservationsByExecutionId: autonomousGates,
  });
  assert.equal(
    externalErrorGrid.rows.find((row) => row.token === 'external.discord').actual,
    'handler_error',
    'external.discord generic handler errors are not accepted as ALLOW',
  );
}

// Email is an eligibility-only exemption (gvic): its gate expectation can match,
// but the known-unimplemented handler keeps release certification incomplete and
// produces a case-level proof failure so coverage cannot be awarded.
for (const tier of ['apprentice', 'autonomous']) {
  const plan = tier === 'apprentice' ? apprenticePlan : autonomousPlan;
  const outcomes = tier === 'apprentice' ? apprenticeOutcomes : autonomousOutcomes;
  const grid = evaluateCapabilityMatrix({
    expectedTier: tier,
    observedTier: tier,
    executionPlan: plan,
    outcomesByExecutionId: outcomes,
    gateObservationsByExecutionId: productionGateObservations(tier),
  });
  const emailRow = grid.rows.find((row) => row.token === 'external.email');
  assert.equal(emailRow.expected, 'allow_eligibility_only', `${tier} email is downgraded to eligibility-only`);
  assert.equal(emailRow.actual, 'allow_eligibility_only', `${tier} email proves eligibility via the production gate`);
  assert.equal(emailRow.matches, true, `${tier} email eligibility exemption matches`);
  assert.equal(emailRow.evidence, 'production_gate', `${tier} email is never live-dispatched`);
  assert.deepEqual(
    emailRow.exemption,
    { reason: 'runtime_unimplemented', ref: 'psfn-framework-gvic' },
    `${tier} email row records the machine-readable exemption`,
  );
  assert.equal(grid.mismatchCount, 0, `${tier} eligibility expectations still match`);
  assert.equal(grid.incompleteCount, 1, `${tier} grid records one unimplemented exemption`);
  assert.equal(grid.certificationComplete, false, `${tier} exemption prevents certification`);
  assert.match(
    collectCapabilityMatrixProofFailures(grid).join('\n'),
    /incomplete.*external\.email.*psfn-framework-gvic/iu,
    `${tier} exemption becomes an unconditional case-level failure`,
  );
}

const wrongScopedArgsGrid = evaluateCapabilityMatrix({
  expectedTier: 'autonomous',
  observedTier: 'autonomous',
  executionPlan: autonomousPlan,
  outcomesByExecutionId: {
    ...autonomousOutcomes,
    git_read: turn(
      'repo',
      { action: 'inspect', target: 'different-target' },
      {},
      'ok',
      false,
    ),
  },
  gateObservationsByExecutionId: autonomousGates,
});
const wrongScopedArgs = wrongScopedArgsGrid.rows.find(
  (row) => row.token === 'git.read',
);
assert.equal(wrongScopedArgs.actual, 'not_observed');
assert.equal(wrongScopedArgs.matches, false);

const routed = evaluateApprovalRoutingProbe({
  tier: 'apprentice',
  turnRecord: turn(
    'fs',
    { action: 'read', path: '../matrix-unit' },
    { isError: true, gatewayErrorCode: -32000 },
    'Your action is pending operator approval (id: approval-1).',
    true,
  ),
  confirmationSurface: {
    ok: true,
    status: 200,
    body: {
      available: true,
      entries: [{ id: 'approval-1', method: 'fs.read', scope: '../matrix-unit' }],
    },
  },
  scope: '../matrix-unit',
});
assert.equal(routed.expected, 'route_approval');
assert.equal(routed.actual, 'route_approval');
assert.equal(routed.matches, true);
assert.equal(routed.queueObserved, true);
assert.equal(routed.refusalObserved, true);
assert.equal(routed.expectedGatewayCode, -32000);
assert.equal(routed.observedGatewayCode, -32000);
assert.equal(routed.confirmationSurfaceValid, true);

const missingQueue = evaluateApprovalRoutingProbe({
  tier: 'apprentice',
  turnRecord: turn(
    'fs',
    { action: 'read', path: '../matrix-unit' },
    { isError: true, gatewayErrorCode: -32000 },
    'Your action is pending operator approval (id: approval-1).',
    true,
  ),
  confirmationSurface: {
    ok: true,
    status: 200,
    body: { available: true, entries: [] },
  },
  scope: '../matrix-unit',
});
assert.equal(missingQueue.actual, 'approval_refusal_without_queue');
assert.equal(missingQueue.matches, false);

const missingCode = evaluateApprovalRoutingProbe({
  tier: 'apprentice',
  turnRecord: turn(
    'fs',
    { action: 'read', path: '../matrix-unit' },
    { isError: true },
    'Your action is pending operator approval (id: approval-1).',
    true,
  ),
  confirmationSurface: {
    ok: true,
    status: 200,
    body: {
      available: true,
      entries: [{ id: 'approval-1', method: 'fs.read', scope: '../matrix-unit' }],
    },
  },
  scope: '../matrix-unit',
});
assert.equal(missingCode.actual, 'approval_route_without_gateway_code');
assert.equal(missingCode.matches, false);

const directTurn = turn(
  'fs',
  { action: 'read', path: '../matrix-unit' },
  { isError: true },
  'fs read failed: path is outside the Personal Workspace',
  true,
);
const direct = evaluateApprovalRoutingProbe({
  tier: 'autonomous',
  turnRecord: directTurn,
  confirmationSurface: {
    ok: true,
    status: 200,
    body: { available: true, entries: [] },
  },
  scope: '../matrix-unit',
});
assert.equal(direct.expected, 'direct_execution');
assert.equal(direct.actual, 'direct_execution');
assert.equal(direct.matches, true);
assert.equal(direct.queueObserved, false);

const malformedSurface = evaluateApprovalRoutingProbe({
  tier: 'autonomous',
  turnRecord: directTurn,
  confirmationSurface: {
    ok: true,
    status: 200,
    body: { entries: [] },
  },
  scope: '../matrix-unit',
});
assert.equal(malformedSurface.actual, 'confirmation_surface_unavailable');
assert.equal(malformedSurface.matches, false);

const conformanceRun = {
  ok: true,
  status: 200,
  body: {
    schemaVersion: 1,
    ranAt: 123,
    trigger: 'manual',
    results: [{ toolName: 'identity', probeKind: 'read_only', ok: true, durationMs: 1 }],
  },
};
const conformance = evaluateTierToolConformanceEvidence({
  expectedTier: 'apprentice',
  observedTier: 'apprentice',
  runResponse: conformanceRun,
  latestResponse: { ok: true, status: 200, body: conformanceRun.body },
});
assert.equal(conformance.caseId, 'tier_tool_conformance');
assert.equal(conformance.matches, true);
assert.equal(conformance.probeCount, 1);

const staleConformance = evaluateTierToolConformanceEvidence({
  expectedTier: 'apprentice',
  observedTier: 'nursery',
  runResponse: conformanceRun,
  latestResponse: {
    ok: true,
    status: 200,
    body: { ...conformanceRun.body, ranAt: 122 },
  },
});
assert.equal(staleConformance.matches, false);
assert.equal(staleConformance.tierMatches, false);
assert.equal(staleConformance.latestMatches, false);

console.log('capability matrix contract tests passed');
