import { describe, expect, it } from 'vitest';
import { resolveChannelResponseStyle } from '../../../system/trust/policy.js';
import { isOwnTimeReasoningLane, resolveReasoningEffortLane } from './lanes.js';

describe('resolveReasoningEffortLane', () => {
  it.each([
    ['discord-channel-1', 'chat'],
    ['api:session-1', 'chat'],
    ['openwebui:chat-1', 'chat'],
    ['discord-voice:guild:user', 'chat'],
    ['internal:social-outreach:contact-1', 'chat'],
    ['internal:free-time:idle', 'freeTime'],
    ['internal:free-time:quiet-hours', 'freeTime'],
    ['internal:reflection:daily-review', 'reflection'],
    ['internal:reflection:dream-pass', 'reflection'],
    ['internal:reflection:temporal-wakeup', 'reflection'],
    ['internal:heartbeat', 'reflection'],
    ['internal:heartbeat:custom', 'reflection'],
    ['internal:world-exploration', 'selfDirected'],
    ['internal:planned:prompt-1', 'selfDirected'],
    ['shard:worker-1', null],
    ['subagent:researcher', null],
    ['internal:free-time:', null],
    ['internal:reflection:', null],
    ['internal:cogsec-review', null],
    ['internal:tool-conformance', null],
    ['internal:scheduler', null],
    ['', null],
  ] as const)('%s -> %s', (channelId, lane) => {
    expect(resolveReasoningEffortLane({ channelId })).toBe(lane);
  });

  it('has no lane without a channel', () => {
    expect(resolveReasoningEffortLane(undefined)).toBeNull();
    expect(resolveReasoningEffortLane({})).toBeNull();
  });

  it('treats every lane but chat as the companion\'s own time', () => {
    expect(isOwnTimeReasoningLane('chat')).toBe(false);
    expect(isOwnTimeReasoningLane(null)).toBe(false);
    expect(isOwnTimeReasoningLane('freeTime')).toBe(true);
    expect(isOwnTimeReasoningLane('reflection')).toBe(true);
    expect(isOwnTimeReasoningLane('selfDirected')).toBe(true);
  });
});

describe('the concise nudge is for conversation, not own time', () => {
  it('own-time internal turns are expressive; other internal turns stay concise', () => {
    expect(resolveChannelResponseStyle('internal:free-time:idle', { channelType: 'terminal', ownTime: true }))
      .toBe('expressive');
    expect(resolveChannelResponseStyle('internal:cogsec-review', { channelType: 'terminal', ownTime: false }))
      .toBe('concise');
    expect(resolveChannelResponseStyle('discord-channel-1', { channelType: 'discord_text' })).toBe('concise');
  });

  it('an owner override still wins', () => {
    expect(resolveChannelResponseStyle('internal:free-time:idle', {
      ownTime: true,
      overrides: { prefix: { 'internal:free-time:': 'concise' } },
    })).toBe('concise');
  });
});
