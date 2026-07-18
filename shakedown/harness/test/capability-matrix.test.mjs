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

const apprenticePlan = buildCapabilityMatrixExecutionPlan({
  tier: 'apprentice',
  runToken: 'unit',
  discordTarget: '123456789012345678',
  emailTarget: 'matrix@example.test',
  dedicatedSinkConfirmation: 'dedicated-test-sinks',
});
assert.deepEqual(
  apprenticePlan.eligibilityOnly.map((entry) => entry.token),
  [
    'identity.write.runtime',
    'identity.write.base',
    'identity.write.operator',
    'memory.write',
    'lifecycle.restart',
    'lifecycle.rebuild',
  ],
  'stateful identity, scratchpad, and lifecycle probes use the production gate without executing',
);
assert.ok(
  apprenticePlan.executions.every((entry) => !entry.executionId.startsWith('lifecycle_')),
);
assert.ok(
  apprenticePlan.executions.every((entry) => (
    CAPABILITY_MATRIX_PROBES.find(
      (probe) => probe.executionId === entry.executionId,
    ).tokens.every((token) => CAPABILITY_MATRIX_TIER_TOKENS.apprentice.includes(token))
  )),
  'denied tools are never delegated to the adaptive model surface',
);

const autonomousPlan = buildCapabilityMatrixExecutionPlan({
  tier: 'autonomous',
  runToken: 'unit',
  discordTarget: '123456789012345678',
  emailTarget: 'matrix@example.test',
  dedicatedSinkConfirmation: 'dedicated-test-sinks',
});
assert.deepEqual(
  autonomousPlan.eligibilityOnly.map((entry) => entry.token),
  [
    'identity.write.runtime',
    'identity.write.base',
    'identity.write.operator',
    'memory.write',
    'lifecycle.restart',
    'lifecycle.rebuild',
  ],
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

const apprenticeOutcomes = Object.fromEntries(
  apprenticePlan.executions.map((execution) => {
    const probe = CAPABILITY_MATRIX_PROBES.find(
      (candidate) => candidate.executionId === execution.executionId,
    );
    return [
      execution.executionId,
      turn(probe.toolName, execution.args),
    ];
  }),
);
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

const malformedRefusalGrid = evaluateCapabilityMatrix({
  expectedTier: 'apprentice',
  observedTier: 'apprentice',
  executionPlan: apprenticePlan,
  outcomesByExecutionId: {
    ...apprenticeOutcomes,
  },
  gateObservationsByExecutionId: {
    ...apprenticeGates,
    world_control: {
      ...apprenticeGates.world_control,
      result: {
        ...apprenticeGates.world_control.result,
        details: {
          ...apprenticeGates.world_control.result.details,
          tier: 'nursery',
        },
      },
    },
  },
});
const malformedRefusal = malformedRefusalGrid.rows.find(
  (row) => row.token === 'world.control',
);
assert.equal(malformedRefusal.actual, 'malformed_production_gate');
assert.equal(malformedRefusal.matches, false);

const adaptiveAbsenceGrid = evaluateCapabilityMatrix({
  expectedTier: 'apprentice',
  observedTier: 'apprentice',
  executionPlan: apprenticePlan,
  outcomesByExecutionId: {
    ...apprenticeOutcomes,
    world_control: {
      snapshot: {
        adaptiveTools: {
          skipped: [{ toolName: 'world', missingTokens: ['world.control'] }],
        },
      },
    },
  },
  gateObservationsByExecutionId: {
    ...apprenticeGates,
    world_control: null,
  },
});
assert.equal(
  adaptiveAbsenceGrid.rows.find((row) => row.token === 'world.control').actual,
  'not_observed',
  'adaptive absence is never accepted as a capability refusal',
);

const wrongTier = evaluateCapabilityMatrix({
  expectedTier: 'apprentice',
  observedTier: 'nursery',
  executionPlan: apprenticePlan,
  outcomesByExecutionId: apprenticeOutcomes,
  gateObservationsByExecutionId: apprenticeGates,
});
assert.ok(wrongTier.mismatchCount > 0, 'apprentice grid must fail against a nursery runtime');
assert.equal(wrongTier.tierMatches, false);

const worldApprentice = apprenticeGrid.rows.find((row) => row.token === 'world.control');
assert.equal(worldApprentice.actual, 'refuse_capability');
const autonomousWorldPlan = autonomousPlan.executions.find(
  (entry) => entry.executionId === 'world_control',
);
const autonomousOutcomes = Object.fromEntries(
  autonomousPlan.executions.map((execution) => {
    return [
      execution.executionId,
      execution.executionId === 'world_control'
        ? turn(
            'world',
            autonomousWorldPlan.args,
            { isError: true },
            'world failed for action=control: affordance "__matrix_missing_affordance__" was not found',
            true,
          )
        : turn(
            CAPABILITY_MATRIX_PROBES.find(
              (candidate) => candidate.executionId === execution.executionId,
            ).toolName,
            execution.args,
          ),
    ];
  }),
);
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
