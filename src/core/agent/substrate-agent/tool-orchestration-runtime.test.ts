import { describe, expect, it } from 'vitest';
import { resolveActiveTools } from './tool-orchestration-runtime.js';

function makeTool(name: string) {
  return {
    name,
    description: `${name} description`,
    parameters: {},
    execute: async () => ({
      role: 'tool',
      content: [{ type: 'text', text: 'ok' }],
    }),
  } as any;
}

describe('resolveActiveTools', () => {
  it('orders provider-bound active tools deterministically after collision resolution', () => {
    const result = resolveActiveTools({
      coreTools: [makeTool('zeta_tool'), makeTool('alpha_tool')],
      extendedTools: [makeTool('mu_tool')],
      promotedResolution: {
        activeNames: new Set<string>(),
        orderedNames: [],
        skipped: [],
      },
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(['alpha_tool', 'mu_tool', 'zeta_tool']);
    expect(result.snapshotTools.map((tool) => tool.toolName)).toEqual(['alpha_tool', 'mu_tool', 'zeta_tool']);
  });

  it('keeps core-over-extended collision semantics while still sorting the final tool list', () => {
    const result = resolveActiveTools({
      coreTools: [makeTool('shared_tool'), makeTool('beta_tool')],
      extendedTools: [makeTool('shared_tool'), makeTool('alpha_tool')],
      promotedResolution: {
        activeNames: new Set<string>(),
        orderedNames: [],
        skipped: [],
      },
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(['alpha_tool', 'beta_tool', 'shared_tool']);
    expect(result.snapshotTools).toEqual([
      { toolName: 'alpha_tool', source: 'extended' },
      { toolName: 'beta_tool', source: 'core' },
      { toolName: 'shared_tool', source: 'core' },
    ]);
  });

  it('uses persisted pins for ordering only and keeps every unpinned tool callable', () => {
    const result = resolveActiveTools({
      coreTools: [makeTool('alpha_tool')],
      extendedTools: [makeTool('zeta_tool'), makeTool('mu_tool')],
      promotedResolution: {
        activeNames: new Set(['zeta_tool']),
        orderedNames: ['zeta_tool'],
        skipped: [],
      },
    });

    expect(result.tools.map(tool => tool.name)).toEqual(['zeta_tool', 'alpha_tool', 'mu_tool']);
    expect(result.snapshotTools).toEqual([
      { toolName: 'zeta_tool', source: 'extended' },
      { toolName: 'alpha_tool', source: 'core' },
      { toolName: 'mu_tool', source: 'extended' },
    ]);
    expect(result.counts).toEqual({ core: 1, extended: 2, total: 3 });
  });
});
