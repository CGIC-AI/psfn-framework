// ── Discord voice channels as Location-scoped presence surfaces (jp36.9.3) ──
//
// Ratified (design bible §17, §20.5; adjudication 2026-07-19): a Discord voice
// channel is presence-based — only those present while it is live share the
// context; scrollback does not exist. It therefore rides the existing
// `RoomContentWindowPort` seam exactly like a private Location room, rather than
// serving full channel history like an ordinary text channel. Voice is the test
// substrate for future virtual-environment Locations.
//
// FLOOR SOURCE: the bot's own voice-channel membership. Joining opens the window
// at the join time (`sinceMs`); leaving closes it; re-joining opens a NEW window
// (a fresh `sinceMs`), so transcripts from a prior visit are never re-served
// into the live context. This mirrors `OwnPresenceWindow` for virtual places —
// one clock, no scrollback — but is keyed on the `discord-voice:<id>` SESSION
// channel instead of a places-registry place, because a Discord voice turn
// carries no place binding today (`voice-turn-runtime.ts` mints
// `discord-voice:${channel.id}` with no `routing.satellite.placeId`).
//
// This port owns ONLY the `discord-voice:` channel family. Every other channel
// resolves `unwindowed` here so it can be composed with the companion-room port
// (see `composeRoomContentWindowPorts`).

import { toErrorMessage } from '../../shared/utils/errors.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { EventBus } from '../../shared/event-bus.js';
import type {
  RoomContentWindow,
  RoomContentWindowPort,
} from './room-content-window.js';

const log = createComponentLogger('VoicePresenceWindow');

/**
 * Session channelId prefix for a Discord voice turn. MUST mirror the value
 * produced in `src/channels/discord/voice-turn-runtime.ts`
 * (`discord-voice:${channel.id}`). The `channel.voice.start` / `channel.voice.end`
 * events carry the RAW guild voice channel id; the session channel prepends
 * this prefix, so the window key is composed with {@link composeDiscordVoiceChannelId}.
 */
export const DISCORD_VOICE_CHANNEL_PREFIX = 'discord-voice:';

/** True when a resolved session channelId belongs to the Discord voice family. */
export function isDiscordVoiceChannelId(channelId: string): boolean {
  return channelId.startsWith(DISCORD_VOICE_CHANNEL_PREFIX);
}

/** Compose the session channelId for a raw Discord voice channel id. */
export function composeDiscordVoiceChannelId(rawChannelId: string): string {
  return `${DISCORD_VOICE_CHANNEL_PREFIX}${rawChannelId}`;
}

export interface VoicePresenceWindowPort extends RoomContentWindowPort {
  /** Open the window for a session voice channel at `sinceMs` (join time). */
  enter(sessionChannelId: string, sinceMs: number): void;
  /**
   * Close the window. When `sessionChannelId` is given, close only if it is the
   * currently-open channel — a stale leave for a channel we already switched
   * away from must not clobber the live window.
   */
  leave(sessionChannelId?: string): void;
}

/**
 * A single-slot presence window over the bot's live Discord voice membership.
 * The runtime is in at most one voice channel at a time (one voice connection),
 * so exactly one window is ever open.
 */
export function createVoicePresenceWindowPort(): VoicePresenceWindowPort {
  let current: { channelId: string; sinceMs: number } | null = null;
  return {
    enter(sessionChannelId: string, sinceMs: number): void {
      current = { channelId: sessionChannelId, sinceMs };
    },
    leave(sessionChannelId?: string): void {
      if (sessionChannelId && (!current || current.channelId !== sessionChannelId)) {
        return;
      }
      current = null;
    },
    resolveWindow(channelId: string): RoomContentWindow {
      if (!isDiscordVoiceChannelId(channelId)) {
        // Not a voice channel — this port is a no-op; composition falls through
        // to the next port (e.g. the companion-room window).
        return { kind: 'unwindowed' };
      }
      // A voice channel is presence-windowed. Present in THIS channel right now
      // → windowed to the join time; otherwise closed. Fail closed: a voice
      // channel we are not currently in serves NOTHING back into live context —
      // no scrollback from a prior visit.
      if (current && current.channelId === channelId) {
        return { kind: 'windowed', floorMs: current.sinceMs };
      }
      return { kind: 'closed' };
    },
  };
}

export interface RegisterVoicePresenceWindowOptions {
  eventBus: EventBus;
  port: VoicePresenceWindowPort;
  /** Injectable clock (tests). Defaults to wall-clock `Date.now`. */
  now?: () => number;
}

/**
 * Subscribe the Discord voice join/leave lifecycle to the presence window.
 * `channel.voice.start` opens the window at the current clock (the join time);
 * `channel.voice.end` closes it. Returns an unsubscribe handle. A handler that
 * throws is logged loudly and never takes down the event bus.
 */
export function registerVoicePresenceWindow(
  options: RegisterVoicePresenceWindowOptions,
): () => void {
  const now = options.now ?? (() => Date.now());
  const offStart = options.eventBus.on('channel.voice.start', (event) => {
    try {
      options.port.enter(composeDiscordVoiceChannelId(event.channelId), now());
    } catch (error) {
      log.error('Failed to open voice presence window', {
        channelId: event.channelId,
        error: toErrorMessage(error),
      });
    }
  });
  const offEnd = options.eventBus.on('channel.voice.end', (event) => {
    try {
      options.port.leave(composeDiscordVoiceChannelId(event.channelId));
    } catch (error) {
      log.error('Failed to close voice presence window', {
        channelId: event.channelId,
        error: toErrorMessage(error),
      });
    }
  });
  return () => {
    offStart();
    offEnd();
  };
}
