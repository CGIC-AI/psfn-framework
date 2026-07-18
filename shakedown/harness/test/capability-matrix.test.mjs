#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CAPABILITY_MATRIX_PROBES,
  CAPABILITY_MATRIX_TIER_TOKENS,
  buildCapabilityMatrixExecutionPlan,
  evaluateCapabilityMatrix,
  evaluateApprovalRoutingProbe,
  evaluateTierToolConformanceEvidence,
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
};

// Rows that stay eligibility-only (never dispatched through the live agent):
// persona/scratchpad writes (durable identity/memory mutation even in the ALLOW
// case) and the operator-reserved lifecycle carve-out.
const ELIGIBILITY_ONLY_TOKENS = [
  'identity.write.runtime',
  'identity.write.base',
  'identity.write.operator',
  'memory.write',
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
  'stateful identity, scratchpad, and lifecycle probes use the production gate without executing',
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
  'autonomous stateful and lifecycle probes remain eligibility-only',
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

// Eligibility-only rows still resolve through the in-process production gate.
const baseRow = apprenticeGrid.rows.find((row) => row.token === 'identity.write.base');
assert.equal(baseRow.actual, 'refuse_capability');
assert.equal(baseRow.evidence, 'production_gate');
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

// A malformed PRODUCTION-GATE observation on an eligibility-only row is rejected.
const malformedGateGrid = evaluateCapabilityMatrix({
  expectedTier: 'apprentice',
  observedTier: 'apprentice',
  executionPlan: apprenticePlan,
  outcomesByExecutionId: apprenticeOutcomes,
  gateObservationsByExecutionId: {
    ...apprenticeGates,
    identity_write_base: {
      ...apprenticeGates.identity_write_base,
      result: {
        ...apprenticeGates.identity_write_base.result,
        details: {
          ...apprenticeGates.identity_write_base.result.details,
          tier: 'nursery',
        },
      },
    },
  },
});
const malformedGate = malformedGateGrid.rows.find((row) => row.token === 'identity.write.base');
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

for (const executionId of ['external_discord', 'external_email']) {
  const execution = autonomousPlan.executions.find(
    (entry) => entry.executionId === executionId,
  );
  const externalErrorGrid = evaluateCapabilityMatrix({
    expectedTier: 'autonomous',
    observedTier: 'autonomous',
    executionPlan: autonomousPlan,
    outcomesByExecutionId: {
      ...autonomousOutcomes,
      [executionId]: turn(
        execution.toolName,
        execution.args,
        { isError: true },
        'provider unavailable',
        true,
      ),
    },
    gateObservationsByExecutionId: autonomousGates,
  });
  const token = executionId === 'external_discord'
    ? 'external.discord'
    : 'external.email';
  assert.equal(
    externalErrorGrid.rows.find((row) => row.token === token).actual,
    'handler_error',
    `${token} generic handler errors are not accepted as ALLOW`,
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
