// ── Discord voice channels are Location-scoped presence surfaces (jp36.9.3) ──
//
// Regression coverage for the §20.5 Location matrix, applied to Discord voice:
//  - ordinary Discord-like (non-voice) channels remain unwindowed
//  - a voice channel is CLOSED while absent (not joined / after leave)
//  - entry opens the window at `since` (the join time)
//  - exit/re-entry starts a NEW window (a fresh floor; no prior-visit scrollback)
//  - the join/leave EVENT lifecycle drives the window
//  - composition with the companion-room port keeps families disjoint

import { describe, it, expect, vi } from 'vitest';
import type { EventBus } from '../../shared/event-bus.js';
import type { RoomContentWindow, RoomContentWindowPort } from './room-content-window.js';
import { composeRoomContentWindowPorts } from './room-content-window.js';
import {
  composeDiscordVoiceChannelId,
  createVoicePresenceWindowPort,
  isDiscordVoiceChannelId,
  registerVoicePresenceWindow,
} from './voice-presence-window.js';

const VOICE = composeDiscordVoiceChannelId('guild-1'); // 'discord-voice:guild-1'
const OTHER_VOICE = composeDiscordVoiceChannelId('guild-2');
const JOIN_MS = Date.parse('2026-07-08T12:00:00Z');

describe('createVoicePresenceWindowPort', () => {
  it('leaves non-voice channels unwindowed (ordinary Discord/telegram/api/room untouched)', () => {
    const port = createVoicePresenceWindowPort();
    port.enter(VOICE, JOIN_MS); // even while a voice window is open
    for (const channelId of [
      'discord:123456',
      'discord:123456:thread-9',
      'telegram:42',
      'api:test',
      'companion-room:den',
    ]) {
      expect(port.resolveWindow(channelId)).toEqual({ kind: 'unwindowed' });
    }
  });

  it('is CLOSED for a voice channel while absent (never joined — fail closed)', () => {
    const port = createVoicePresenceWindowPort();
    expect(port.resolveWindow(VOICE)).toEqual({ kind: 'closed' });
  });

  it('entry opens the window at the join time (since)', () => {
    const port = createVoicePresenceWindowPort();
    port.enter(VOICE, JOIN_MS);
    expect(port.resolveWindow(VOICE)).toEqual({ kind: 'windowed', floorMs: JOIN_MS });
  });

  it('closes a DIFFERENT voice channel while present in another (fail closed)', () => {
    const port = createVoicePresenceWindowPort();
    port.enter(VOICE, JOIN_MS);
    expect(port.resolveWindow(OTHER_VOICE)).toEqual({ kind: 'closed' });
  });

  it('exit closes the window (no scrollback after leaving)', () => {
    const port = createVoicePresenceWindowPort();
    port.enter(VOICE, JOIN_MS);
    port.leave();
    expect(port.resolveWindow(VOICE)).toEqual({ kind: 'closed' });
  });

  it('re-entry starts a NEW window with a fresh floor', () => {
    const port = createVoicePresenceWindowPort();
    port.enter(VOICE, JOIN_MS);
    port.leave(VOICE);
    const rejoinMs = JOIN_MS + 5 * 60_000;
    port.enter(VOICE, rejoinMs);
    // The floor moved forward: transcripts before the re-join are excluded.
    expect(port.resolveWindow(VOICE)).toEqual({ kind: 'windowed', floorMs: rejoinMs });
  });

  it('a stale leave for a different channel does not clobber the live window', () => {
    const port = createVoicePresenceWindowPort();
    port.enter(VOICE, JOIN_MS);
    // Late `channel.voice.end` for a channel we already switched away from.
    port.leave(OTHER_VOICE);
    expect(port.resolveWindow(VOICE)).toEqual({ kind: 'windowed', floorMs: JOIN_MS });
  });
});

// ── Event lifecycle wiring ──

interface FakeBus {
  handlers: Map<string, Array<(event: unknown) => void>>;
  eventBus: EventBus;
  emit(event: string, payload: unknown): void;
}

function makeFakeBus(): FakeBus {
  const handlers = new Map<string, Array<(event: unknown) => void>>();
  const eventBus = {
    on(event: string, handler: (event: unknown) => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const current = handlers.get(event) ?? [];
        handlers.set(event, current.filter((h) => h !== handler));
      };
    },
  } as unknown as EventBus;
  return {
    handlers,
    eventBus,
    emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
  };
}

describe('registerVoicePresenceWindow', () => {
  it('opens on channel.voice.start (join clock) and closes on channel.voice.end', () => {
    const bus = makeFakeBus();
    const port = createVoicePresenceWindowPort();
    const clock = vi.fn(() => JOIN_MS);
    const unsubscribe = registerVoicePresenceWindow({ eventBus: bus.eventBus, port, now: clock });

    // Joined the raw guild voice channel `guild-1`.
    bus.emit('channel.voice.start', { guildId: 'g', channelId: 'guild-1', userId: 'u' });
    expect(port.resolveWindow(VOICE)).toEqual({ kind: 'windowed', floorMs: JOIN_MS });

    // Left.
    bus.emit('channel.voice.end', { guildId: 'g', channelId: 'guild-1', userId: 'u', reason: 'target-left' });
    expect(port.resolveWindow(VOICE)).toEqual({ kind: 'closed' });

    unsubscribe();
    expect(bus.handlers.get('channel.voice.start')).toEqual([]);
    expect(bus.handlers.get('channel.voice.end')).toEqual([]);
  });

  it('re-open after a rejoin advances the floor via the clock', () => {
    const bus = makeFakeBus();
    const port = createVoicePresenceWindowPort();
    let now = JOIN_MS;
    registerVoicePresenceWindow({ eventBus: bus.eventBus, port, now: () => now });

    bus.emit('channel.voice.start', { guildId: 'g', channelId: 'guild-1', userId: 'u' });
    bus.emit('channel.voice.end', { guildId: 'g', channelId: 'guild-1', userId: 'u', reason: 'channel-empty' });
    now = JOIN_MS + 90_000;
    bus.emit('channel.voice.start', { guildId: 'g', channelId: 'guild-1', userId: 'u' });

    expect(port.resolveWindow(VOICE)).toEqual({ kind: 'windowed', floorMs: JOIN_MS + 90_000 });
  });
});

// ── Composition ──

describe('composeRoomContentWindowPorts (voice + companion-room families)', () => {
  // A stand-in for the companion-room port: owns only `companion-room:` ids.
  function companionRoomLike(window: RoomContentWindow): RoomContentWindowPort {
    return {
      resolveWindow: (channelId) =>
        channelId.startsWith('companion-room:') ? window : { kind: 'unwindowed' },
    };
  }

  it('voice port owns the discord-voice family; companion-room owns its own', () => {
    const voice = createVoicePresenceWindowPort();
    voice.enter(VOICE, JOIN_MS);
    const room = companionRoomLike({ kind: 'closed' });
    const composed = composeRoomContentWindowPorts([voice, room]);

    // Voice channel → voice verdict (companion-room is unwindowed for it).
    expect(composed.resolveWindow(VOICE)).toEqual({ kind: 'windowed', floorMs: JOIN_MS });
    // Companion room → companion-room verdict (voice is unwindowed for it).
    expect(composed.resolveWindow('companion-room:den')).toEqual({ kind: 'closed' });
    // Neither family → unwindowed.
    expect(composed.resolveWindow('discord:777')).toEqual({ kind: 'unwindowed' });
  });

  it('first non-unwindowed port wins; all-unwindowed stays unwindowed', () => {
    const voice = createVoicePresenceWindowPort(); // closed for VOICE (absent)
    const room = companionRoomLike({ kind: 'unwindowed' });
    const composed = composeRoomContentWindowPorts([voice, room]);
    expect(composed.resolveWindow(VOICE)).toEqual({ kind: 'closed' });
    expect(composed.resolveWindow('api:x')).toEqual({ kind: 'unwindowed' });
  });
});

describe('voice channel id helpers', () => {
  it('composes and recognizes the discord-voice session prefix', () => {
    expect(composeDiscordVoiceChannelId('abc')).toBe('discord-voice:abc');
    expect(isDiscordVoiceChannelId('discord-voice:abc')).toBe(true);
    expect(isDiscordVoiceChannelId('discord:abc')).toBe(false);
  });
});
