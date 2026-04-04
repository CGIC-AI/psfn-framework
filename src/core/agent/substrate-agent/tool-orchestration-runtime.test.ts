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
      loadedExtended: new Map([
        ['mu_tool', {
          toolName: 'mu_tool',
          source: 'autoload',
          activatedAt: 1,
          lastActivatedAt: 1,
        }],
      ]),
      promotedResolution: {
        activeNames: new Set<string>(),
        skipped: [],
      },
      classifyExtendedToolForTurn: () => 'overlay',
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(['alpha_tool', 'mu_tool', 'zeta_tool']);
    expect(result.snapshotTools.map((tool) => tool.toolName)).toEqual(['alpha_tool', 'mu_tool', 'zeta_tool']);
  });

  it('keeps core-over-extended collision semantics while still sorting the final tool list', () => {
    const result = resolveActiveTools({
      coreTools: [makeTool('shared_tool'), makeTool('beta_tool')],
      extendedTools: [makeTool('shared_tool'), makeTool('alpha_tool')],
      loadedExtended: new Map([
        ['shared_tool', {
          toolName: 'shared_tool',
          source: 'autoload',
          activatedAt: 1,
          lastActivatedAt: 1,
        }],
        ['alpha_tool', {
          toolName: 'alpha_tool',
          source: 'autoload',
          activatedAt: 1,
          lastActivatedAt: 1,
        }],
      ]),
      promotedResolution: {
        activeNames: new Set<string>(),
        skipped: [],
      },
      classifyExtendedToolForTurn: () => 'overlay',
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(['alpha_tool', 'beta_tool', 'shared_tool']);
    expect(result.snapshotTools).toEqual([
      { toolName: 'alpha_tool', source: 'autoload' },
      { toolName: 'beta_tool', source: 'core' },
      { toolName: 'shared_tool', source: 'core' },
    ]);
  });
});
