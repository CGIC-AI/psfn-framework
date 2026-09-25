// Autonomous room-reply outbound routing (psfn-framework-ze2fx).
//
// The agent's speaking-arbiter egress lease delivers an appraised room reply
// through the gateway. Discord keeps its account-routed `discord.send`; this
// registry resolves the other group-capable connectors to their existing
// outbound adapters: the Telegram dock, and each external adapter's bounded
// outbound queue (drained by its bridge with `channel_pull_outbound`).
//
// Fail closed: a channel id no registered target owns, a target owned by a
// different companion, or an unattributed call on a fleet gateway is refused
// before anything is sent.

import type { ChannelOutboundDock } from '../../channels/backplane/types.js';

type RoomReplyChannelType = 'telegram' | 'external';

/** Telegram adapter channel ids are `telegram:<chatId>[:<threadId>]`. */
const TELEGRAM_CHANNEL_ID_PREFIX = 'telegram:';

export interface RoomReplyOutboundTarget {
  channelType: RoomReplyChannelType;
  /** Channel ids this target delivers to all start with this prefix. */
  channelIdPrefix: string;
  /** Companion that owns the surface; undefined only in single-companion mode. */
  ownerCompanionId?: string;
  dock: ChannelOutboundDock;
}

/**
 * Targets for the configured group-capable connectors. Telegram is included
 * only when its owning companion is known on a fleet gateway; an unowned
 * surface is left out, so its room replies are refused rather than misrouted.
 */
export function resolveRoomReplyOutboundTargets(input: {
  multiCompanion: boolean;
  telegram?: ChannelOutboundDock;
  telegramCompanionId?: string;
  externalAdapters: ReadonlyArray<ChannelOutboundDock & {
    ownerCompanionId: string;
    channelIdPrefix: string;
  }>;
}): RoomReplyOutboundTarget[] {
  const targets: RoomReplyOutboundTarget[] = input.externalAdapters.map(adapter => ({
    channelType: 'external',
    channelIdPrefix: adapter.channelIdPrefix,
    ownerCompanionId: adapter.ownerCompanionId,
    dock: adapter,
  }));
  if (input.telegram && (input.telegramCompanionId || !input.multiCompanion)) {
    targets.push({
      channelType: 'telegram',
      channelIdPrefix: TELEGRAM_CHANNEL_ID_PREFIX,
      ...(input.telegramCompanionId ? { ownerCompanionId: input.telegramCompanionId } : {}),
      dock: input.telegram,
    });
  }
  return targets;
}

export class RoomReplyOutboundRefusedError extends Error {
  constructor(readonly reasonCode: string) {
    super(`Room reply outbound refused: ${reasonCode}`);
    this.name = 'RoomReplyOutboundRefusedError';
  }
}

export interface GatewayRoomReplyOutbound {
  send(input: {
    channelType: RoomReplyChannelType;
    channelId: string;
    content: string;
    companionId: string | undefined;
  }): Promise<void>;
}

export function createGatewayRoomReplyOutbound(options: {
  targets: readonly RoomReplyOutboundTarget[];
  multiCompanion: boolean;
}): GatewayRoomReplyOutbound {
  for (const target of options.targets) {
    if (options.multiCompanion && !target.ownerCompanionId) {
      throw new Error(
        `Room reply outbound target ${target.channelType}:${target.channelIdPrefix} has no owning companion`,
      );
    }
  }
  return {
    async send(input) {
      if (options.multiCompanion && !input.companionId) {
        throw new RoomReplyOutboundRefusedError('missing_companion_attribution');
      }
      const matches = options.targets.filter(target => (
        target.channelType === input.channelType
        && input.channelId.startsWith(target.channelIdPrefix)
        && input.channelId.length > target.channelIdPrefix.length
      ));
      if (matches.length !== 1) {
        throw new RoomReplyOutboundRefusedError(matches.length === 0 ? 'unknown_channel' : 'ambiguous_channel');
      }
      const target = matches[0]!;
      if (target.ownerCompanionId && input.companionId && target.ownerCompanionId !== input.companionId) {
        throw new RoomReplyOutboundRefusedError('channel_not_owned_by_companion');
      }
      await target.dock.outbound.sendText({ channelId: input.channelId }, input.content);
    },
  };
}
