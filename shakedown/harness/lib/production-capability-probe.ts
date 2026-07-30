#!/usr/bin/env node

import { Type } from '@sinclair/typebox';
import type { AgentTool } from '../../../src/boundary/pi-agent/index.js';
import { GatewayErrors } from '../../../src/boundary/gateway/protocol.js';
import { registerShardBackendMethods } from '../../../src/boundary/gateway/methods/shard-backends.js';
import type { GatewayMethodRuntime } from '../../../src/boundary/gateway/methods/types.js';
import type { CapabilityTier } from '../../../src/system/config/runtime-config-contracts.js';
import {
  evaluateToolCapabilityEligibility,
  gateToolWithCapabilities,
  type CapabilityAccess,
} from '../../../src/system/capabilities/gate.js';
import { withCapabilityRequirement } from '../../../src/system/capabilities/requirements.js';
import { resolveTierCapabilityTokens } from '../../../src/system/capabilities/tiers.js';
import { createSelfStatusTool } from '../../../src/core/tools/self-status.js';
import {
  buildCapabilityTierChange,
  formatCapabilityTierChangeNotice,
} from '../../../src/system/capabilities/change-notice.js';
import {
  CAPABILITY_MATRIX_PROBES,
  type CapabilityMatrixProbe,
} from './capability-matrix.mjs';

function parseTier(argv: string[]): Exclude<CapabilityTier, 'custom'> {
  const index = argv.indexOf('--tier');
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (value === 'nursery' || value === 'apprentice' || value === 'autonomous') {
    return value;
  }
  throw new Error(`--tier must be nursery, apprentice, or autonomous; got ${JSON.stringify(value)}`);
}

function accessForTier(tier: Exclude<CapabilityTier, 'custom'>): CapabilityAccess {
  const granted = new Set(resolveTierCapabilityTokens(tier));
  return {
    getTier: () => tier,
    getGrantedTokens: () => granted,
    has: (token) => granted.has(token),
  };
}

function gateArgs(probe: CapabilityMatrixProbe): Record<string, unknown> {
  if (probe.executionId === 'identity_write_runtime') {
    return { action: 'update_persona' };
  }
  return probe.args;
}

function createSentinelTool(
  probe: CapabilityMatrixProbe,
  markReached: () => void,
): AgentTool<any> {
  const tool: AgentTool<any> = {
    name: probe.toolName,
    label: probe.toolName,
    description: `Capability matrix production-gate probe for ${probe.executionId}`,
    parameters: Type.Object({}),
    execute: async () => {
      markReached();
      return {
        content: [{ type: 'text', text: 'production capability gate admitted sentinel' }],
        details: { gateAllowed: true },
      };
    },
  };
  if (probe.executionId === 'identity_write_base') {
    return withCapabilityRequirement(tool, 'identity.write.base');
  }
  if (probe.executionId === 'identity_write_operator') {
    return withCapabilityRequirement(tool, 'identity.write.operator');
  }
  return tool;
}

async function probeCapabilityGate(
  probe: CapabilityMatrixProbe,
  tier: Exclude<CapabilityTier, 'custom'>,
): Promise<Record<string, unknown>> {
  let handlerReached = false;
  const tool = createSentinelTool(probe, () => {
    handlerReached = true;
  });
  const args = gateArgs(probe);
  const access = accessForTier(tier);
  const eligibility = evaluateToolCapabilityEligibility(tool, args, access);
  const gated = gateToolWithCapabilities(tool, () => access);
  const result = await gated.execute(`matrix-${probe.executionId}`, args);
  return {
    executionId: probe.executionId,
    toolName: probe.toolName,
    args,
    eligibility,
    handlerReached,
    result: {
      text: result.content
        .filter((entry): entry is { type: 'text'; text: string } => entry.type === 'text')
        .map((entry) => entry.text)
        .join('\n'),
      details: result.details,
    },
  };
}

async function probeShardBackend(
  tier: Exclude<CapabilityTier, 'custom'>,
): Promise<Record<string, unknown>> {
  const methods = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
  const runtime = {
    target: {
      addMethod(name: string, handler: (params: Record<string, unknown>) => Promise<unknown>) {
        methods.set(name, handler);
      },
    },
    policyConfig: { workspacePath: process.cwd() },
    capabilityTierProvider: () => tier,
    authenticatedCompanionId: () => 'capability-matrix-probe',
    gated: (
      _method: string,
      handler: (params: Record<string, unknown>) => Promise<unknown>,
    ) => handler,
  } as unknown as GatewayMethodRuntime;
  registerShardBackendMethods(runtime);
  const handler = methods.get('shard.backend.request');
  if (!handler) throw new Error('shard.backend.request was not registered');
  const params = {
    shardId: `matrix-${tier}`,
    name: 'capability-matrix',
    backend: 'container',
    capabilityTier: tier,
  };
  try {
    const result = await handler(params);
    const status = (
      result
      && typeof result === 'object'
      && 'status' in result
    ) ? result.status : null;
    return {
      method: 'shard.backend.request',
      callerTier: tier,
      authoritativeTier: tier,
      actual: status === 'unavailable' ? 'accepted_unavailable' : 'malformed_acceptance',
      code: null,
    };
  } catch (error) {
    const code = (
      error
      && typeof error === 'object'
      && 'code' in error
      && typeof error.code === 'number'
    ) ? error.code : null;
    return {
      method: 'shard.backend.request',
      callerTier: tier,
      authoritativeTier: tier,
      actual: code === GatewayErrors.POLICY_DENIED ? 'policy_denied' : 'unexpected_error',
      code,
    };
  }
}

async function probeCompanionCapabilitySelfInspection(
  tier: Exclude<CapabilityTier, 'custom'>,
): Promise<Record<string, unknown>> {
  const grantedTokens = resolveTierCapabilityTokens(tier);
  const tool = createSelfStatusTool({
    config: {},
    now: () => 1_700_000_000_000,
    getCapabilityGrantSnapshot: () => ({
      tier,
      customTokens: [],
      grantedTokens,
    }),
  });
  const gated = gateToolWithCapabilities(tool, () => accessForTier(tier));
  const result = await gated.execute(`self-inspection-${tier}`, { action: 'capabilities' });
  const text = result.content
    .filter((entry): entry is { type: 'text'; text: string } => entry.type === 'text')
    .map(entry => entry.text)
    .join('\n');
  const payload = JSON.parse(text) as {
    capability?: {
      status?: string;
      tier?: string;
      grantedTokens?: unknown;
    };
  };
  const observedTokens = Array.isArray(payload.capability?.grantedTokens)
    ? payload.capability.grantedTokens
    : [];
  return {
    matches: payload.capability?.status === 'available'
      && payload.capability.tier === tier
      && JSON.stringify(observedTokens) === JSON.stringify(grantedTokens),
    tier: payload.capability?.tier ?? null,
    grantedTokens: observedTokens,
  };
}

function probeTierChangeNotice(
  tier: Exclude<CapabilityTier, 'custom'>,
): Record<string, unknown> {
  const previousTier = tier === 'nursery' ? 'autonomous' : 'nursery';
  const change = buildCapabilityTierChange(
    {
      tier: previousTier,
      customTokens: [],
      grantedTokens: resolveTierCapabilityTokens(previousTier),
    },
    {
      tier,
      customTokens: [],
      grantedTokens: resolveTierCapabilityTokens(tier),
    },
  );
  if (!change) throw new Error('Tier-change notice probe unexpectedly produced no change');
  const notice = formatCapabilityTierChangeNotice(change);
  return {
    matches:
      notice.includes(`[System notice: capability access changed]`)
      && notice.includes(`from "${previousTier}" to "${tier}"`)
      && notice.includes('Current granted capabilities:')
      && notice.includes('Newly granted:')
      && notice.includes('Withdrawn:')
      && notice.includes('not a fault in you'),
    previousTier,
    currentTier: tier,
    grantedTokens: change.granted,
    withdrawnTokens: change.withdrawn,
  };
}

async function main(): Promise<void> {
  const tier = parseTier(process.argv.slice(2));
  const gates = [];
  for (const probe of CAPABILITY_MATRIX_PROBES) {
    gates.push(await probeCapabilityGate(probe, tier));
  }
  const shardBackend = await probeShardBackend(tier);
  const selfInspection = await probeCompanionCapabilitySelfInspection(tier);
  const tierChangeNotice = probeTierChangeNotice(tier);
  process.stdout.write(`${JSON.stringify({
    tier,
    gates,
    shardBackend,
    selfInspection,
    tierChangeNotice,
  })}\n`);
}

await main();
