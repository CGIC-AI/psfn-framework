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
  promptLayerId: 'runtime-layer',
  baseLayerId: 'base-layer',
  operatorLayerId: 'operator-layer',
});
assert.deepEqual(
  apprenticePlan.eligibilityOnly.map((entry) => entry.token),
  ['lifecycle.restart', 'lifecycle.rebuild'],
  'non-autonomous lifecycle probes assert denied eligibility without dispatching a live restart',
);
assert.ok(
  apprenticePlan.executions.every((entry) => !entry.executionId.startsWith('lifecycle_')),
);
assert.deepEqual(
  apprenticePlan.executions
    .filter((entry) => entry.executionId === 'identity_write_base'
      || entry.executionId === 'identity_write_operator')
    .map((entry) => entry.args.layer_id),
  ['base-layer', 'operator-layer'],
  'base/operator probes resolve their actual per-layer capability without mutating a real stage',
);

const autonomousPlan = buildCapabilityMatrixExecutionPlan({
  tier: 'autonomous',
  runToken: 'unit',
  promptLayerId: 'runtime-layer',
  baseLayerId: 'base-layer',
  operatorLayerId: 'operator-layer',
});
assert.deepEqual(
  autonomousPlan.eligibilityOnly.map((entry) => entry.token),
  ['lifecycle.restart', 'lifecycle.rebuild'],
  'autonomous lifecycle probes are eligibility-only and never execute live',
);
assert.ok(
  autonomousPlan.executions.every((entry) => !entry.executionId.startsWith('lifecycle_')),
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

function reversibleTurn(execution) {
  if (execution.executionId === 'identity_write_runtime') {
    return {
      status: 'completed',
      toolCalls: [
        {
          toolName: 'identity',
          arguments: execution.args,
          details: {},
          resultText: JSON.stringify({
            action: 'toggle_layer',
            layerId: execution.args.layer_id,
            previousEnabled: true,
            enabled: false,
          }),
          isError: false,
        },
        {
          toolName: 'identity',
          arguments: execution.args,
          details: {},
          resultText: JSON.stringify({
            action: 'toggle_layer',
            layerId: execution.args.layer_id,
            previousEnabled: false,
            enabled: true,
          }),
          isError: false,
        },
      ],
    };
  }
  if (execution.executionId === 'memory_write') {
    return {
      status: 'completed',
      toolCalls: [
        {
          toolName: 'scratchpad',
          arguments: execution.args,
          details: {},
          resultText: 'Scratchpad entry added (id: scratch-unit).',
          isError: false,
        },
        {
          toolName: 'scratchpad',
          arguments: { action: 'remove', id: 'scratch-unit' },
          details: {},
          resultText: 'Scratchpad entry removed (id: scratch-unit).',
          isError: false,
        },
      ],
    };
  }
  return null;
}

const apprenticeOutcomes = Object.fromEntries(
  apprenticePlan.executions.map((execution) => {
    const probe = CAPABILITY_MATRIX_PROBES.find(
      (candidate) => candidate.executionId === execution.executionId,
    );
    const granted = probe.tokens.every((token) =>
      CAPABILITY_MATRIX_TIER_TOKENS.apprentice.includes(token));
    const reversible = granted ? reversibleTurn(execution) : null;
    return [
      execution.executionId,
      reversible ?? turn(
          probe.toolName,
          execution.args,
          granted
            ? {}
            : {
                isError: true,
                capabilityDenied: true,
                tier: 'apprentice',
                missingTokens: probe.tokens.filter(
                  (token) => !CAPABILITY_MATRIX_TIER_TOKENS.apprentice.includes(token),
                ),
              },
          granted ? 'handler reached' : 'Capability denied',
          !granted,
        ),
    ];
  }),
);

const apprenticeGrid = evaluateCapabilityMatrix({
  expectedTier: 'apprentice',
  observedTier: 'apprentice',
  executionPlan: apprenticePlan,
  outcomesByExecutionId: apprenticeOutcomes,
});
assert.equal(apprenticeGrid.mismatchCount, 0);
assert.equal(apprenticeGrid.rows.length, 22);

const malformedRefusalGrid = evaluateCapabilityMatrix({
  expectedTier: 'apprentice',
  observedTier: 'apprentice',
  executionPlan: apprenticePlan,
  outcomesByExecutionId: {
    ...apprenticeOutcomes,
    world_control: turn(
      'world',
      apprenticePlan.executions.find(
        (execution) => execution.executionId === 'world_control',
      ).args,
      {
        isError: true,
        capabilityDenied: true,
        tier: 'nursery',
        missingTokens: ['world.control'],
      },
      'Capability denied',
      true,
    ),
  },
});
const malformedRefusal = malformedRefusalGrid.rows.find(
  (row) => row.token === 'world.control',
);
assert.equal(malformedRefusal.actual, 'malformed_capability_refusal');
assert.equal(malformedRefusal.matches, false);

for (const executionId of ['identity_write_runtime', 'memory_write']) {
  const incompleteCleanupGrid = evaluateCapabilityMatrix({
    expectedTier: 'apprentice',
    observedTier: 'apprentice',
    executionPlan: apprenticePlan,
    outcomesByExecutionId: {
      ...apprenticeOutcomes,
      [executionId]: turn(
        CAPABILITY_MATRIX_PROBES.find((probe) => probe.executionId === executionId).toolName,
        apprenticePlan.executions.find((execution) => execution.executionId === executionId).args,
      ),
    },
  });
  const incompleteRow = incompleteCleanupGrid.rows.find(
    (row) => row.token === (
      executionId === 'identity_write_runtime' ? 'identity.write.runtime' : 'memory.write'
    ),
  );
  assert.equal(incompleteRow.actual, 'cleanup_not_observed');
  assert.equal(incompleteRow.matches, false);
}

const wrongTier = evaluateCapabilityMatrix({
  expectedTier: 'apprentice',
  observedTier: 'nursery',
  executionPlan: apprenticePlan,
  outcomesByExecutionId: apprenticeOutcomes,
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
    const reversible = reversibleTurn(execution);
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
        : reversible ?? turn(
            CAPABILITY_MATRIX_PROBES.find(
              (candidate) => candidate.executionId === execution.executionId,
            ).toolName,
            execution.args,
          ),
    ];
  }),
);
const autonomousGrid = evaluateCapabilityMatrix({
  expectedTier: 'autonomous',
  observedTier: 'autonomous',
  executionPlan: autonomousPlan,
  outcomesByExecutionId: autonomousOutcomes,
});
assert.equal(autonomousGrid.mismatchCount, 0);
assert.equal(
  autonomousGrid.rows.find((row) => row.token === 'world.control').actual,
  'refuse_runtime_fence',
);

const wrongScopedArgsGrid = evaluateCapabilityMatrix({
  expectedTier: 'autonomous',
  observedTier: 'autonomous',
  executionPlan: autonomousPlan,
  outcomesByExecutionId: {
    ...autonomousOutcomes,
    identity_write_base: turn(
      'identity',
      { action: 'cancel_stage', stage_id: 'different-stage' },
      {},
      'Stage not found',
      true,
    ),
  },
});
const wrongScopedArgs = wrongScopedArgsGrid.rows.find(
  (row) => row.token === 'identity.write.base',
);
assert.equal(wrongScopedArgs.actual, 'not_observed');
assert.equal(wrongScopedArgs.matches, false);

const routed = evaluateApprovalRoutingProbe({
  tier: 'apprentice',
  turnRecord: turn(
    'fs',
    { action: 'read', path: '../matrix-unit' },
    { isError: true },
    'Your action is pending operator approval (id: approval-1).',
    true,
  ),
  pendingEntries: [{ id: 'approval-1', method: 'fs.read', scope: '../matrix-unit' }],
  scope: '../matrix-unit',
});
assert.equal(routed.expected, 'route_approval');
assert.equal(routed.actual, 'route_approval');
assert.equal(routed.matches, true);
assert.equal(routed.queueObserved, true);
assert.equal(routed.refusalObserved, true);
assert.equal(routed.expectedGatewayCode, -32000);

const missingQueue = evaluateApprovalRoutingProbe({
  tier: 'apprentice',
  turnRecord: turn(
    'fs',
    { action: 'read', path: '../matrix-unit' },
    { isError: true },
    'Your action is pending operator approval (id: approval-1).',
    true,
  ),
  pendingEntries: [],
  scope: '../matrix-unit',
});
assert.equal(missingQueue.actual, 'approval_refusal_without_queue');
assert.equal(missingQueue.matches, false);

const direct = evaluateApprovalRoutingProbe({
  tier: 'autonomous',
  turnRecord: turn(
    'fs',
    { action: 'read', path: '../matrix-unit' },
    { isError: true },
    'fs read failed: path is outside the Personal Workspace',
    true,
  ),
  pendingEntries: [],
  scope: '../matrix-unit',
});
assert.equal(direct.expected, 'direct_execution');
assert.equal(direct.actual, 'direct_execution');
assert.equal(direct.matches, true);
assert.equal(direct.queueObserved, false);

console.log('capability matrix contract tests passed');
