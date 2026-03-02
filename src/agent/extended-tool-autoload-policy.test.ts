import { describe, it, expect } from 'vitest';
import {
  classifyTurnIntent,
  createDefaultExtendedToolAutoloadPolicy,
  DEFAULT_EXTENDED_TOOL_AUTOLOAD_CANDIDATES,
  DEFAULT_EXTENDED_TOOL_AUTOLOAD_MAX,
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
    expect(devCandidates[0]).toBe('repo_status');
    expect(devCandidates[1]).toBe('repo_diff');
    expect(devCandidates[2]).toBe('repo_apply_patch');
  });

  it('supports disabling preloads by setting max count to zero', () => {
    const policy = createDefaultExtendedToolAutoloadPolicy(0);
    expect(policy.maxPreloadCount).toBe(0);
    expect(policy.getCandidatesForIntent('dev').slice(0, policy.maxPreloadCount)).toEqual([]);
  });
});
