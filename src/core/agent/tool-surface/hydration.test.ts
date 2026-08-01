import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';
import {
  assertPolicyToolHydration,
  hydrateToolForCaller,
  type CallerHydratableTool,
} from './hydration.js';

function makeBeadsTool(
  actions: readonly string[],
  policyActions: readonly string[] = actions,
): CallerHydratableTool {
  return {
    name: 'beads',
    label: 'beads',
    description: 'tracked work test surface',
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
    const tool = makeBeadsTool(['ready', 'show']);
    expect(() => assertPolicyToolHydration(
      { core: [], extended: [tool] },
      [{ toolName: 'beads', enabled: true, allowedActions: ['ready', 'show'], source: 'test-policy' }],
    )).not.toThrow();
  });

  it('fails closed on a declared-versus-hydrated action divergence', () => {
    const tool = makeBeadsTool(['ready', 'show', 'close'], ['ready', 'show']);
    expect(() => assertPolicyToolHydration(
      { core: [], extended: [tool] },
      [{ toolName: 'beads', enabled: true, allowedActions: ['ready', 'show'], source: 'test-policy' }],
    )).toThrow(/hydration.*beads.*close/iu);
  });

  it('fails closed when policy enablement and tool registration diverge', () => {
    expect(() => assertPolicyToolHydration(
      { core: [], extended: [] },
      [{ toolName: 'beads', enabled: true, allowedActions: ['ready'], source: 'test-policy' }],
    )).toThrow(/beads.*not registered/iu);

    const tool = makeBeadsTool(['ready']);
    expect(() => assertPolicyToolHydration(
      { core: [], extended: [tool] },
      [{ toolName: 'beads', enabled: false, allowedActions: [], source: 'test-policy' }],
    )).toThrow(/beads.*registered.*disabled/iu);
  });

  it('hydrates a caller-specific tool without changing the companion instance', () => {
    const companionTool = makeBeadsTool(['ready']);
    companionTool.hydrateForCaller = caller => (
      caller.kind === 'shard' ? makeBeadsTool(['ready', 'close']) : companionTool
    );

    const shardTool = hydrateToolForCaller(companionTool, {
      kind: 'shard',
      shardId: 'shard-1',
    });

    expect(shardTool).not.toBe(companionTool);
    expect((shardTool.wiringMeta?.policyHydration?.allowedActions)).toEqual(['ready', 'close']);
    expect(companionTool.wiringMeta?.policyHydration?.allowedActions).toEqual(['ready']);
  });
});
