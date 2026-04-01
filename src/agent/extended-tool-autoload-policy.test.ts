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
    expect(devCandidates.slice(0, policy.maxPreloadCount)).toHaveLength(DEFAULT_EXTENDED_TOOL_AUTOLOAD_MAX);
    expect(devCandidates[0]).toBe('repo_apply_patch');
    expect(devCandidates[1]).toBe('repo_commit');
    expect(devCandidates[2]).toBe('repo_create_branch');
  });

  it('supports disabling preloads by setting max count to zero', () => {
    const policy = createDefaultExtendedToolAutoloadPolicy(0);
    expect(policy.maxPreloadCount).toBe(0);
    expect(policy.getCandidatesForIntent('dev').slice(0, policy.maxPreloadCount)).toEqual([]);
  });

  it('classifies background-only tools as non-overlay', () => {
    expect(classifyExtendedToolForTurn('schedule_task')).toBe('background');
    expect(classifyExtendedToolForTurn('heartbeat_run_template')).toBe('background');
    expect(classifyExtendedToolForTurn('north_star')).toBe('overlay');
    expect(classifyExtendedToolForTurn('repo_status')).toBe('overlay');
    expect(DEFAULT_BACKGROUND_ONLY_EXTENDED_TOOLS.has('schedule_task')).toBe(true);
  });

  it('keeps north_star as a single semantic memory-overlay candidate', () => {
    expect(DEFAULT_EXTENDED_TOOL_AUTOLOAD_CANDIDATES.memory).toContain('north_star');
    expect(DEFAULT_EXTENDED_TOOL_AUTOLOAD_CANDIDATES.memory.filter(name => name === 'north_star')).toHaveLength(1);
  });

  it('classifies tools with explicit core, overlay, and background semantics', () => {
    expect(classifyToolForTurn('repo_status', { coreToolNames: ['repo_status'] })).toBe('core');
    expect(classifyToolForTurn('schedule_task')).toBe('background');
    expect(classifyToolForTurn('repo_diff')).toBe('overlay');
    expect(classifyToolForTurn('   ')).toBe('background');
  });

  it('selects bounded overlay tools deterministically from registered candidates', () => {
    const selection = selectBoundedOverlayCandidates(
      ['repo_apply_patch', 'repo_commit', 'repo_create_branch', 'repo_open_pr'],
      ['repo_apply_patch', 'repo_commit', 'repo_create_branch', 'repo_open_pr'],
      3,
    );
    expect(selection.maxCount).toBe(3);
    expect(selection.selected).toEqual(['repo_apply_patch', 'repo_commit', 'repo_create_branch']);
    expect(selection.skipped).toEqual([
      {
        toolName: 'repo_open_pr',
        reason: 'budget_exhausted',
      },
    ]);
  });

  it('fails closed for invalid or non-overlay candidate metadata', () => {
    const selection = selectBoundedOverlayCandidates(
      ['repo_status', '', '   ', 'schedule_task', 'repo_status'],
      ['repo_status', 'schedule_task'],
      3,
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
        toolName: 'schedule_task',
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
      'heartbeat_update_policy',
      'heartbeat_run_template',
      'schedule_task',
      'issue_sync',
    ]);
    expect(selection.maxCount).toBe(2);
    expect(selection.selected).toEqual(['heartbeat_update_policy', 'issue_sync']);
    expect(selection.skipped).toEqual(expect.arrayContaining([
      expect.objectContaining({
        toolName: 'heartbeat_run_template',
        reason: 'not_overlay_eligible',
      }),
      expect.objectContaining({
        toolName: 'schedule_task',
        reason: 'not_overlay_eligible',
      }),
    ]));
  });
});
