import { describe, expect, it } from 'vitest';
import {
  composeCompanionDmChannelId,
  composeCompanionRoomChannelId,
  isCompanionChannelId,
  parseCompanionChannelId,
} from './companion-channels.js';

describe('companion channel identifiers (W6)', () => {
  it('composes and parses a room channelId', () => {
    const channelId = composeCompanionRoomChannelId('living_room');
    expect(channelId).toBe('companion-room:living_room');
    expect(parseCompanionChannelId(channelId)).toEqual({ kind: 'room', placeId: 'living_room' });
    expect(isCompanionChannelId(channelId)).toBe(true);
  });

  it('rejects invalid room placeIds fail-closed', () => {
    expect(() => composeCompanionRoomChannelId('')).toThrow();
    expect(() => composeCompanionRoomChannelId('has:colon')).toThrow();
    expect(() => composeCompanionRoomChannelId('  padded  ')).not.toThrow(); // trimmed
    expect(parseCompanionChannelId('companion-room:')).toBeNull();
    expect(parseCompanionChannelId('companion-room:a:b')).toBeNull();
  });

  it('normalizes DM pair ordering so both sides share one channelId', () => {
    const ab = composeCompanionDmChannelId('bbbb-companion', 'aaaa-companion');
    const ba = composeCompanionDmChannelId('aaaa-companion', 'bbbb-companion');
    expect(ab).toBe(ba);
    expect(ab).toBe('companion-dm:aaaa-companion:bbbb-companion');
    expect(parseCompanionChannelId(ab)).toEqual({
      kind: 'dm',
      participants: ['aaaa-companion', 'bbbb-companion'],
    });
  });

  it('rejects self-DMs and malformed DM channelIds', () => {
    expect(() => composeCompanionDmChannelId('same', 'same')).toThrow();
    expect(() => composeCompanionDmChannelId('', 'other')).toThrow();
    // Non-canonical (unsorted) spelling is rejected, never silently normalized:
    // two spellings of one conversation must not split into two fatigue budgets.
    expect(parseCompanionChannelId('companion-dm:bbbb:aaaa')).toBeNull();
    expect(parseCompanionChannelId('companion-dm:same:same')).toBeNull();
    expect(parseCompanionChannelId('companion-dm:only-one')).toBeNull();
    expect(parseCompanionChannelId('companion-dm:a:b:c')).toBeNull();
  });

  it('returns null for non-companion channels', () => {
    expect(parseCompanionChannelId('discord:general')).toBeNull();
    expect(parseCompanionChannelId('internal:heartbeat')).toBeNull();
    expect(isCompanionChannelId('discord:general')).toBe(false);
  });
});
