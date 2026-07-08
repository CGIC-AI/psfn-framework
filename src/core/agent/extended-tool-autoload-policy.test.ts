import { describe, it, expect } from 'vitest';
import {
  classifyExtendedToolForTurn,
  classifyToolForTurn,
  classifyTurnIntent,
  createDefaultExtendedToolAutoloadPolicy,
  DEFAULT_BACKGROUND_ONLY_EXTENDED_TOOLS,
  DEFAULT_EXTENDED_TOOL_AUTOLOAD_CANDIDATES,
  DEFAULT_EXTENDED_TOOL_AUTOLOAD_MAX,
  selectBoundedOverlayCandidates,
} from './extended-tool-autoload-policy.js';
import { assertNoRetiredFirstPartyToolAliases } from './tool-surface/registry.js';

describe('extended-tool-autoload-policy', () => {
  it('classifies development workflow turns as dev intent', () => {
    const intent = classifyTurnIntent({
      channelId: 'discord-dev',
      channelType: 'discord',
      content: 'Can you run repo diff and inspect this commit?',
    });
    expect(intent).toBe('dev');
  });

  it('classifies memory retrieval turns as memory intent', () => {
    const intent = classifyTurnIntent({
      channelId: 'api:session-1',
      channelType: 'api',
      content: 'Please recall memory notes from yesterday',
    });
    expect(intent).toBe('memory');
  });

  it('classifies routine orient and concern maintenance as memory intent instead of social fallback', () => {
    for (const content of [
      'Please list active concerns and resolve the hydration thread.',
      'Append this note to the goals block in orientation.',
      'Use values_list to review recent values reflections.',
    ]) {
      const intent = classifyTurnIntent({
        channelId: 'api:session-1',
        channelType: 'api',
        content,
      });
      expect(intent).toBe('memory');
    }
  });

  it('classifies internal and ops task turns as ops intent', () => {
    const internalIntent = classifyTurnIntent({
      channelId: 'internal:heartbeat',
      channelType: 'terminal',
      content: 'tick',
    });
    expect(internalIntent).toBe('ops');

    const taskKindIntent = classifyTurnIntent({
      channelId: 'discord-general',
      channelType: 'discord',
      content: 'quick update',
    }, 'maintenance');
    expect(taskKindIntent).toBe('ops');
  });

  it('classifies reflection turns onto the dedicated reflection intent', () => {
    const internalIntent = classifyTurnIntent({
      channelId: 'internal:reflection:musing',
      channelType: 'terminal',
      content: 'Reflect on the recent pattern.',
    });
    expect(internalIntent).toBe('reflection');

    const taskKindIntent = classifyTurnIntent({
      channelId: 'discord-general',
      channelType: 'discord',
      content: 'quiet background pass',
    }, 'reflection');
    expect(taskKindIntent).toBe('reflection');
  });

  it('falls back to social intent for casual conversation', () => {
    const intent = classifyTurnIntent({
      channelId: 'discord-lounge',
      channelType: 'discord',
      content: 'Hey, how is your day going?',
    });
    expect(intent).toBe('social');
  });

  it('keeps default candidate order and enforces bounded preload count', () => {
    const policy = createDefaultExtendedToolAutoloadPolicy(DEFAULT_EXTENDED_TOOL_AUTOLOAD_MAX);
    const devCandidates = policy.getCandidatesForIntent('dev');
    expect(devCandidates).toEqual(DEFAULT_EXTENDED_TOOL_AUTOLOAD_CANDIDATES.dev);
    expect(devCandidates.slice(0, policy.maxPreloadCount)).toHaveLength(1);
    expect(devCandidates[0]).toBe('beads');
  });

  it('supports disabling preloads by setting max count to zero', () => {
    const policy = createDefaultExtendedToolAutoloadPolicy(0);
    expect(policy.maxPreloadCount).toBe(0);
    expect(policy.getCandidatesForIntent('dev').slice(0, policy.maxPreloadCount)).toEqual([]);
  });

  it('does not reserve removed scheduler aliases as background-only tools', () => {
    expect(classifyExtendedToolForTurn('north_star')).toBe('overlay');
    expect(classifyExtendedToolForTurn('repo_status')).toBe('overlay');
    expect(DEFAULT_BACKGROUND_ONLY_EXTENDED_TOOLS.size).toBe(0);
  });

  it('keeps north_star as a single semantic memory-overlay candidate', () => {
    expect(DEFAULT_EXTENDED_TOOL_AUTOLOAD_CANDIDATES.memory).toEqual(expect.arrayContaining([
      'vault',
      'north_star',
    ]));
    expect(DEFAULT_EXTENDED_TOOL_AUTOLOAD_CANDIDATES.memory.filter(name => name === 'vault')).toHaveLength(1);
    expect(DEFAULT_EXTENDED_TOOL_AUTOLOAD_CANDIDATES.memory.filter(name => name === 'north_star')).toHaveLength(1);
  });

  it('keeps default autoload candidates on canonical tool names', () => {
    const candidates = Object.values(DEFAULT_EXTENDED_TOOL_AUTOLOAD_CANDIDATES).flat();
    expect(() => assertNoRetiredFirstPartyToolAliases(
      candidates,
      'default extended-tool autoload candidates',
    )).not.toThrow();
  });

  it('keeps social preload candidates free of the core image tools', () => {
    expect(DEFAULT_EXTENDED_TOOL_AUTOLOAD_MAX).toBe(4);
    // generate_image and selfie_create are core (always active) so the social
    // intent no longer autoloads an image surface.
    expect(DEFAULT_EXTENDED_TOOL_AUTOLOAD_CANDIDATES.social).toEqual(['vault']);

    const policy = createDefaultExtendedToolAutoloadPolicy(DEFAULT_EXTENDED_TOOL_AUTOLOAD_MAX);
    const selection = policy.selectOverlayCandidates('social', [
      'vault',
    ]);

    expect(selection.selected).toEqual(['vault']);
    expect(selection.skipped).toEqual([]);
  });

  it('keeps reflection intent free of overlay preload candidates', () => {
    expect(DEFAULT_EXTENDED_TOOL_AUTOLOAD_CANDIDATES.reflection).toEqual([]);
    const policy = createDefaultExtendedToolAutoloadPolicy(2);
    const selection = policy.selectOverlayCandidates('reflection', [
      'heartbeat_update_policy',
      'beads',
      'vault',
    ]);
    expect(selection.selected).toEqual([]);
    expect(selection.skipped).toEqual([]);
  });

  it('does not autoload analysis_workbench for routine orient, concern, scheduler, or simple lookup turns', () => {
    const policy = createDefaultExtendedToolAutoloadPolicy(3);
    const cases = [
      {
        content: 'List active concerns and resolve the hydration thread.',
        taskKind: undefined,
      },
      {
        content: 'Append this to the persona orientation block.',
        taskKind: undefined,
      },
      {
        content: 'List schedule templates and show the next heartbeat.',
        taskKind: undefined,
      },
      {
        content: 'Simple lookup: show the latest session note.',
        taskKind: undefined,
      },
      {
        content: 'Run routine maintenance.',
        taskKind: 'maintenance',
      },
    ] as const;

    for (const entry of cases) {
      const intent = policy.classifyIntent({
        channelId: 'api:routine',
        channelType: 'api',
        content: entry.content,
      }, entry.taskKind);
      const selection = policy.selectOverlayCandidates(intent, [
        'analysis_workbench',
        'beads',
        'vault',
        'north_star',
        'generate_image',
      ]);

      expect(selection.candidates).not.toContain('analysis_workbench');
      expect(selection.selected).not.toContain('analysis_workbench');
    }
  });

  it('classifies tools with explicit core, overlay, and background semantics', () => {
    expect(classifyToolForTurn('repo_status', { coreToolNames: ['repo_status'] })).toBe('core');
    expect(classifyToolForTurn('schedule', { coreToolNames: ['schedule'] })).toBe('core');
    // No extended tools default to background-only since the scheduler
    // consolidation, but an explicit configuration still classifies them.
    expect(classifyToolForTurn('schedule_task')).toBe('overlay');
    expect(classifyToolForTurn('schedule_task', { backgroundOnlyToolNames: ['schedule_task'] })).toBe('background');
    expect(classifyToolForTurn('repo_diff')).toBe('overlay');
    expect(classifyToolForTurn('   ')).toBe('background');
  });

  it('selects bounded overlay tools deterministically from registered candidates', () => {
    const selection = selectBoundedOverlayCandidates(
      ['beads', 'repo_apply_patch', 'repo_commit', 'repo_open_pr'],
      ['beads', 'repo_apply_patch', 'repo_commit', 'repo_open_pr'],
      3,
    );
    expect(selection.maxCount).toBe(3);
    expect(selection.selected).toEqual(['beads', 'repo_apply_patch', 'repo_commit']);
    expect(selection.skipped).toEqual([
      {
        toolName: 'repo_open_pr',
        reason: 'budget_exhausted',
      },
    ]);
  });

  it('fails closed for invalid or non-overlay candidate metadata', () => {
    const selection = selectBoundedOverlayCandidates(
      ['repo_status', '', '   ', 'schedule', 'repo_status'],
      ['repo_status', 'schedule'],
      3,
      { coreToolNames: ['schedule'] },
    );
    expect(selection.selected).toEqual(['repo_status']);
    expect(selection.skipped).toEqual([
      {
        toolName: '',
        reason: 'invalid_metadata',
      },
      {
        toolName: '   ',
        reason: 'invalid_metadata',
      },
      {
        toolName: 'schedule',
        reason: 'not_overlay_eligible',
      },
      {
        toolName: 'repo_status',
        reason: 'duplicate_candidate',
      },
    ]);
  });

  it('fails closed by excluding core-classified tools from overlay selection', () => {
    const selection = selectBoundedOverlayCandidates(
      ['repo_status', 'repo_diff'],
      ['repo_status', 'repo_diff'],
      2,
      { coreToolNames: ['repo_status'] },
    );
    expect(selection.selected).toEqual(['repo_diff']);
    expect(selection.skipped).toEqual([
      {
        toolName: 'repo_status',
        reason: 'not_overlay_eligible',
      },
    ]);
  });

  it('exposes policy-level overlay selection for turn intent', () => {
    const policy = createDefaultExtendedToolAutoloadPolicy(2);
    const selection = policy.selectOverlayCandidates('ops', [
      'beads',
    ]);
    expect(selection.maxCount).toBe(2);
    expect(selection.selected).toEqual(['beads']);
    expect(selection.skipped).toEqual([]);
  });
});
