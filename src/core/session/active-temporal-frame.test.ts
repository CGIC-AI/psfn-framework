import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildActiveTemporalFrame } from './active-temporal-frame.js';
import type { SessionEntry } from './types.js';

const HOUR_MS = 60 * 60_000;
const LAST_ACTIVITY_AT = Date.parse('2026-06-10T20:00:00.000Z');
const ACTIVE_TURN_AT = Date.parse('2026-06-11T08:30:00.000Z');

function conversationalEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    id: 1,
    channelId: 'api:main',
    role: 'assistant',
    content: 'Previous exchange',
    timestamp: LAST_ACTIVITY_AT,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv('TZ', 'UTC');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildActiveTemporalFrame', () => {
  it('collapses every unsent idle-time change into the one frame derived for the active turn', () => {
    const result = buildActiveTemporalFrame({
      enabled: true,
      minIdleMs: 2 * HOUR_MS,
      channelId: 'api:main',
      sourceChannelId: 'api:main',
      recentEntries: [
        conversationalEntry(),
        conversationalEntry({ id: 2, role: 'user', timestamp: ACTIVE_TURN_AT }),
      ],
      currentTurnEntryId: 2,
      nowMs: ACTIVE_TURN_AT,
    });

    expect(result).toMatchObject({
      fired: true,
      observedAt: ACTIVE_TURN_AT,
      lastActivityAt: LAST_ACTIVITY_AT,
      idleGapMs: ACTIVE_TURN_AT - LAST_ACTIVITY_AT,
    });
    expect(result?.noteText).toContain('source="active_turn" persistence="ephemeral"');
    expect(result?.noteText).toContain(`<elapsed_since_last_activity_ms>${ACTIVE_TURN_AT - LAST_ACTIVITY_AT}`);
    expect(result?.noteText).toContain('no idle-time frames are queued or replayed');
  });

  it('uses the latest prior row when deferred persistence means no current entry exists yet', () => {
    const result = buildActiveTemporalFrame({
      enabled: true,
      minIdleMs: 2 * HOUR_MS,
      channelId: 'api:main',
      sourceChannelId: 'api:main',
      recentEntries: [conversationalEntry()],
      nowMs: ACTIVE_TURN_AT,
    });

    expect(result).toMatchObject({
      fired: true,
      lastActivityAt: LAST_ACTIVITY_AT,
      idleGapMs: ACTIVE_TURN_AT - LAST_ACTIVITY_AT,
    });
  });

  it('does not fabricate a deferred-persistence gap from an older row when the latest prior row is recent', () => {
    const recentPriorAt = ACTIVE_TURN_AT - 10 * 60_000;
    const result = buildActiveTemporalFrame({
      enabled: true,
      minIdleMs: 2 * HOUR_MS,
      channelId: 'api:main',
      sourceChannelId: 'api:main',
      recentEntries: [
        conversationalEntry(),
        conversationalEntry({ id: 2, role: 'user', timestamp: recentPriorAt }),
      ],
      nowMs: ACTIVE_TURN_AT,
    });

    expect(result).toBeUndefined();
  });

  it('does not create a frame below the idle threshold or for internal/public surfaces', () => {
    const base = {
      enabled: true,
      minIdleMs: 24 * HOUR_MS,
      recentEntries: [conversationalEntry()],
      nowMs: ACTIVE_TURN_AT,
    } as const;

    expect(buildActiveTemporalFrame({
      ...base,
      channelId: 'api:main',
      sourceChannelId: 'api:main',
    })).toBeUndefined();
    expect(buildActiveTemporalFrame({
      ...base,
      minIdleMs: 2 * HOUR_MS,
      channelId: 'internal:reflection:daily',
      sourceChannelId: 'internal:reflection:daily',
    })).toBeUndefined();
    expect(buildActiveTemporalFrame({
      ...base,
      minIdleMs: 2 * HOUR_MS,
      channelId: 'twitter:timeline',
      sourceChannelId: 'twitter:timeline',
      channelMeta: { privacyLevel: 'public' },
    })).toBeUndefined();
  });
});
