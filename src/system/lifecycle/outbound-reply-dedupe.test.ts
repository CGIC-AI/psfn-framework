import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OUTBOUND_REPLY_DEDUPE_WINDOW_MS,
  OutboundReplyDeduper,
} from './outbound-reply-dedupe.js';

function makeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('OutboundReplyDeduper', () => {
  it('flags a candidate reply that exactly matches a recently delivered reply on the same channel', () => {
    const clock = makeClock();
    const deduper = new OutboundReplyDeduper({ now: clock.now });

    deduper.noteDelivered({
      channelId: 'discord:general',
      content: 'I hit a wall on that tool, let me try again.',
      sourceTurnId: 'turn-1',
      senderKind: 'discord_inbound_reply',
    });

    clock.advance(65_000);
    const decision = deduper.evaluate({
      channelId: 'discord:general',
      content: 'I hit a wall on that tool, let me try again.',
    });

    expect(decision).not.toBeNull();
    expect(decision?.priorSourceTurnId).toBe('turn-1');
    expect(decision?.priorSenderKind).toBe('discord_inbound_reply');
    expect(decision?.ageMs).toBe(65_000);
  });

  it('ignores whitespace-only differences when matching', () => {
    const deduper = new OutboundReplyDeduper();
    deduper.noteDelivered({
      channelId: 'discord:general',
      content: 'hello   there\nfriend',
      senderKind: 'discord_inbound_reply',
    });

    expect(
      deduper.evaluate({ channelId: 'discord:general', content: 'hello there friend' }),
    ).not.toBeNull();
  });

  it('does not flag different reply text', () => {
    const deduper = new OutboundReplyDeduper();
    deduper.noteDelivered({
      channelId: 'discord:general',
      content: 'first reply',
      senderKind: 'discord_inbound_reply',
    });

    expect(
      deduper.evaluate({ channelId: 'discord:general', content: 'a genuinely different follow-up' }),
    ).toBeNull();
  });

  it('scopes matches per channel', () => {
    const deduper = new OutboundReplyDeduper();
    deduper.noteDelivered({
      channelId: 'discord:general',
      content: 'same text',
      senderKind: 'discord_inbound_reply',
    });

    expect(deduper.evaluate({ channelId: 'discord:other', content: 'same text' })).toBeNull();
    expect(deduper.evaluate({ channelId: 'discord:general', content: 'same text' })).not.toBeNull();
  });

  it('expires records after the dedupe window', () => {
    const clock = makeClock();
    const deduper = new OutboundReplyDeduper({ now: clock.now });
    deduper.noteDelivered({
      channelId: 'discord:general',
      content: 'stale reply',
      senderKind: 'discord_inbound_reply',
    });

    clock.advance(DEFAULT_OUTBOUND_REPLY_DEDUPE_WINDOW_MS + 1);

    expect(deduper.evaluate({ channelId: 'discord:general', content: 'stale reply' })).toBeNull();
  });

  it('never records or matches empty content', () => {
    const deduper = new OutboundReplyDeduper();
    deduper.noteDelivered({ channelId: 'discord:general', content: '   ', senderKind: 'x' });
    expect(deduper.evaluate({ channelId: 'discord:general', content: '   ' })).toBeNull();
  });

  it('returns the most recent matching record', () => {
    const clock = makeClock();
    const deduper = new OutboundReplyDeduper({ now: clock.now });
    deduper.noteDelivered({
      channelId: 'discord:general',
      content: 'echo',
      sourceTurnId: 'turn-old',
      senderKind: 'discord_inbound_reply',
    });
    clock.advance(1_000);
    deduper.noteDelivered({
      channelId: 'discord:general',
      content: 'echo',
      sourceTurnId: 'turn-new',
      senderKind: 'deferred_tool_handoff',
    });

    const decision = deduper.evaluate({ channelId: 'discord:general', content: 'echo' });
    expect(decision?.priorSourceTurnId).toBe('turn-new');
    expect(decision?.priorSenderKind).toBe('deferred_tool_handoff');
  });
});
