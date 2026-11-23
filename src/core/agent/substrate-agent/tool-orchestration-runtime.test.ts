import { describe, expect, it } from 'vitest';
import { fromPartial } from '@total-typescript/shoehorn';
import {
  inferToolConcurrencyClass,
  resolveActiveTools,
  selectHybridCodeModeWireTools,
} from './tool-orchestration-runtime.js';
import { buildToolUsageRanking } from '../tool-surface/usage-ranking.js';
import type { AgentTool } from '../../../boundary/pi-agent/index.js';

function makeTool(name: string) {
  return fromPartial<AgentTool<any>>({
    name,
    description: `${name} description`,
    parameters: {},
    execute: async () => ({
      role: 'tool',
      content: [{ type: 'text', text: 'ok' }],
    }),
  });
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

  it('breaks ties within a presentation band by durable usage, before alphabetical (b0yl.5)', () => {
    // All three names are non-canonical => same presentation band (unknown rank),
    // so usage frequency decides order among them.
    const usageRanking = buildToolUsageRanking(
      [{ toolName: 'zeta_tool', successes: 9, failures: 0, invocations: 9 }],
      0,
    );
    const result = resolveActiveTools({
      coreTools: [makeTool('zeta_tool'), makeTool('alpha_tool'), makeTool('mu_tool')],
      extendedTools: [],
      promotedResolution: { activeNames: new Set<string>(), orderedNames: [], skipped: [] },
      usageRanking,
    });
    // zeta_tool jumps ahead on usage; the unused pair falls back to alphabetical.
    expect(result.tools.map(tool => tool.name)).toEqual(['zeta_tool', 'alpha_tool', 'mu_tool']);
  });

  it('never lets usage move a tool across presentation bands (b0yl.5)', () => {
    // web (boundary band, rank 160) is heavily used; memory (memory band, rank 50)
    // is unused. Usage must not pull web ahead of the higher social/memory band.
    const usageRanking = buildToolUsageRanking(
      [{ toolName: 'web', successes: 100, failures: 0, invocations: 100 }],
      0,
    );
    const result = resolveActiveTools({
      coreTools: [makeTool('web'), makeTool('memory')],
      extendedTools: [],
      promotedResolution: { activeNames: new Set<string>(), orderedNames: [], skipped: [] },
      usageRanking,
    });
    expect(result.tools.map(tool => tool.name)).toEqual(['memory', 'web']);
  });

  it('never lets usage override an explicit pin (b0yl.5)', () => {
    // alpha_tool is heavily used but mu_tool is pinned first; the pin wins.
    const usageRanking = buildToolUsageRanking(
      [{ toolName: 'alpha_tool', successes: 50, failures: 0, invocations: 50 }],
      0,
    );
    const result = resolveActiveTools({
      coreTools: [makeTool('alpha_tool')],
      extendedTools: [makeTool('mu_tool')],
      promotedResolution: { activeNames: new Set(['mu_tool']), orderedNames: ['mu_tool'], skipped: [] },
      usageRanking,
    });
    expect(result.tools.map(tool => tool.name)).toEqual(['mu_tool', 'alpha_tool']);
  });

  it('ranks memory, journal, and orient ahead of asynchronous letters (e46hi)', () => {
    const result = resolveActiveTools({
      coreTools: [makeTool('letter'), makeTool('orient'), makeTool('journal'), makeTool('memory')],
      extendedTools: [],
      promotedResolution: { activeNames: new Set<string>(), orderedNames: [], skipped: [] },
    });
    expect(result.tools.map(tool => tool.name)).toEqual(['journal', 'memory', 'orient', 'letter']);
  });

  it('prunes per-companion disabledTools up front across core and extended catalogs and records skip telemetry', () => {
    const result = resolveActiveTools({
      coreTools: [makeTool('memory'), makeTool('web'), makeTool('file_editor')],
      extendedTools: [makeTool('shell'), makeTool('world'), makeTool('group_chat')],
      promotedResolution: {
        activeNames: new Set<string>(),
        orderedNames: [],
        skipped: [{ toolName: 'shell', source: 'extended', reason: 'disabled_by_override' }],
      },
      disabledTools: new Set(['web', 'shell', 'group_chat']),
    });

    expect(result.tools.map(tool => tool.name)).toEqual(['memory', 'file_editor', 'world']);
    expect(result.snapshotTools).toEqual([
      { toolName: 'memory', source: 'core' },
      { toolName: 'file_editor', source: 'core' },
      { toolName: 'world', source: 'extended' },
    ]);
    expect(result.counts).toEqual({ core: 2, extended: 1, total: 3 });
    expect(result.promotedSkipped).toEqual([
      { toolName: 'shell', source: 'extended', reason: 'disabled_by_override' },
      { toolName: 'web', source: 'core', reason: 'disabled_by_override' },
      { toolName: 'group_chat', source: 'extended', reason: 'disabled_by_override' },
    ]);
  });
});

describe('inferToolConcurrencyClass (e46hi)', () => {
  it('marks canonical pure read-only tools as read_only and keeps multiplexed or retired names exclusive', () => {
    expect(inferToolConcurrencyClass('tool_search')).toBe('read_only');
    expect(inferToolConcurrencyClass('subagent')).toBe('spawn_subagent');
    expect(inferToolConcurrencyClass('memory')).toBe('exclusive');
    expect(inferToolConcurrencyClass('repo')).toBe('exclusive');
    expect(inferToolConcurrencyClass('repo_status')).toBe('exclusive');
  });
});

describe('selectHybridCodeModeWireTools (b3h5p.4)', () => {
  it('projects active tools down to discovery, execute, permit-bound egress tools, and explicit requests when execute is active', () => {
    const active = [
      'memory', 'journal', 'orient', 'file_editor', 'shell', 'wiki',
      'tool_search', 'execute', 'toolset', 'notify', 'mcp', 'publication', 'response_control',
    ].map(makeTool);

    expect(selectHybridCodeModeWireTools(active).map(t => t.name)).toEqual([
      'tool_search',
      'execute',
      'notify',
      'mcp',
      'publication',
      'response_control',
    ]);

    expect(selectHybridCodeModeWireTools(active, {
      explicitlyRequestedToolNames: ['memory', 'file_editor'],
    }).map(t => t.name)).toEqual([
      'memory',
      'file_editor',
      'tool_search',
      'execute',
      'notify',
      'mcp',
      'publication',
      'response_control',
    ]);
  });

  it('passes through active tools unchanged when execute is not active (maintenance, ICP candidate, or disabledTools)', () => {
    const notifyOnly = [makeTool('notify')];
    expect(selectHybridCodeModeWireTools(notifyOnly).map(t => t.name)).toEqual(['notify']);

    const withoutExecute = ['memory', 'journal', 'tool_search'].map(makeTool);
    expect(selectHybridCodeModeWireTools(withoutExecute).map(t => t.name)).toEqual([
      'memory',
      'journal',
      'tool_search',
    ]);
  });
});
