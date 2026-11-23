import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';
import {
  assertPolicyToolHydration,
  hydrateToolForCaller,
  type CallerHydratableTool,
} from './hydration.js';

function makeHydratableTool(
  actions: readonly string[],
  policyActions: readonly string[] = actions,
): CallerHydratableTool {
  return {
    name: 'north_star',
    label: 'north_star',
    description: 'long-horizon intent test surface',
    parameters: Type.Object({
      action: Type.Union(actions.map(action => Type.Literal(action))),
    }),
    execute: async () => ({ content: [], details: {} }),
    wiringMeta: {
      policyHydration: {
        source: 'test-policy',
        allowedActions: [...policyActions],
      },
    },
  };
}

describe('policy tool hydration reconciliation', () => {
  it('accepts an exact policy-to-schema action match', () => {
    const tool = makeHydratableTool(['list', 'create']);
    expect(() => assertPolicyToolHydration(
      { core: [], extended: [tool] },
      [{ toolName: 'north_star', enabled: true, allowedActions: ['list', 'create'], source: 'test-policy' }],
    )).not.toThrow();
  });

  it('fails closed on a declared-versus-hydrated action divergence', () => {
    const tool = makeHydratableTool(['list', 'create', 'delete'], ['list', 'create']);
    expect(() => assertPolicyToolHydration(
      { core: [], extended: [tool] },
      [{ toolName: 'north_star', enabled: true, allowedActions: ['list', 'create'], source: 'test-policy' }],
    )).toThrow(/hydration.*north_star.*delete/iu);
  });

  it('fails closed when policy enablement and tool registration diverge', () => {
    expect(() => assertPolicyToolHydration(
      { core: [], extended: [] },
      [{ toolName: 'north_star', enabled: true, allowedActions: ['list'], source: 'test-policy' }],
    )).toThrow(/north_star.*not registered/iu);

    const tool = makeHydratableTool(['list']);
    expect(() => assertPolicyToolHydration(
      { core: [], extended: [tool] },
      [{ toolName: 'north_star', enabled: false, allowedActions: [], source: 'test-policy' }],
    )).toThrow(/north_star.*registered.*disabled/iu);
  });

  it('hydrates a caller-specific tool without changing the companion instance', () => {
    const companionTool = makeHydratableTool(['list']);
    companionTool.hydrateForCaller = caller => (
      caller.kind === 'shard' ? makeHydratableTool(['list', 'delete']) : companionTool
    );

    const shardTool = hydrateToolForCaller(companionTool, {
      kind: 'shard',
      shardId: 'shard-1',
    });

    expect(shardTool).not.toBe(companionTool);
    expect((shardTool.wiringMeta?.policyHydration?.allowedActions)).toEqual(['list', 'delete']);
    expect(companionTool.wiringMeta?.policyHydration?.allowedActions).toEqual(['list']);
  });
});
