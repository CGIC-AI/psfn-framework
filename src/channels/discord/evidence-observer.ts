import { randomUUID } from 'node:crypto';
import {
  ChannelType,
  OverwriteType,
  type Client,
  type Guild,
  type GuildMember,
} from 'discord.js';
import type { DiscordEvidenceTarget } from '../../boundary/fleet-auth/discord-evidence-types.js';
import { isRecord } from '../../shared/utils/types.js';

export interface DiscordEvidenceObservationInput {
  providerSubjectId: string;
  targets: readonly DiscordEvidenceTarget[];
}

function discordApiErrorCode(error: unknown): number | undefined {
  if (!isRecord(error) || typeof error.code !== 'number') return undefined;
  return error.code;
}

/** Collects complete current Discord permission inputs without making a PSFN decision. */
export class DiscordEvidenceObserver {
  constructor(private readonly client: Client) {}

  async observe(input: DiscordEvidenceObservationInput): Promise<unknown> {
    const botUserId = this.client.user?.id;
    if (!this.client.isReady() || !botUserId) return { status: 'bot_absent' };
    const observedAt = new Date().toISOString();
    const observations: unknown[] = [];
    for (const target of input.targets) {
      let guild: Guild;
      try {
        guild = await this.client.guilds.fetch(target.guildId);
        await guild.roles.fetch();
        await guild.members.fetchMe();
      } catch (error) {
        const code = discordApiErrorCode(error);
        if (code === 10_004 || code === 50_001 || code === 50_013) {
          return { status: 'bot_absent', observationId: randomUUID() };
        }
        throw error;
      }
      let member: GuildMember;
      try {
        member = await guild.members.fetch(input.providerSubjectId);
      } catch (error) {
        if (discordApiErrorCode(error) === 10_007) {
          observations.push({
            status: 'membership_removed',
            guildId: target.guildId,
            ...(target.channelId ? { requestedChannelId: target.channelId } : {}),
          });
          continue;
        }
        throw error;
      }
      const memberRoles = [...member.roles.cache.values()]
        .filter(role => role.id !== guild.id)
        .sort((left, right) => left.id.localeCompare(right.id));
      const base = {
        status: 'current',
        guildId: target.guildId,
        ...(target.channelId ? { requestedChannelId: target.channelId } : {}),
        member: {
          roleIds: memberRoles.map(role => role.id),
          guildOwner: member.id === guild.ownerId,
        },
        guildPermissions: {
          everyoneRoleId: guild.id,
          everyonePermissions: guild.roles.everyone.permissions.bitfield.toString(),
          roles: memberRoles.map(role => ({
            roleId: role.id,
            permissions: role.permissions.bitfield.toString(),
          })),
        },
      };
      if (!target.channelId) {
        observations.push(base);
        continue;
      }
      const requested = await this.client.channels.fetch(target.channelId, { force: true });
      if (!requested || requested.isDMBased() || requested.guildId !== guild.id) {
        observations.push({ status: 'incomplete', guildId: target.guildId });
        continue;
      }
      if (requested.isThread() && !requested.parentId) {
        observations.push({ status: 'incomplete', guildId: target.guildId });
        continue;
      }
      const permissionChannel = requested.isThread()
        ? await this.client.channels.fetch(requested.parentId, { force: true })
        : requested;
      if (!permissionChannel || permissionChannel.isDMBased()
        || permissionChannel.isThread() || permissionChannel.guildId !== guild.id) {
        observations.push({ status: 'incomplete', guildId: target.guildId });
        continue;
      }
      const overwrites = [...permissionChannel.permissionOverwrites.cache.values()];
      const toPermissionPair = (overwrite: typeof overwrites[number]) => ({
        allow: overwrite.allow.bitfield.toString(),
        deny: overwrite.deny.bitfield.toString(),
      });
      const everyoneOverwrite = overwrites.find(overwrite => overwrite.id === guild.id);
      const memberOverwrite = overwrites.find(overwrite => (
        overwrite.type === OverwriteType.Member && overwrite.id === input.providerSubjectId
      ));
      const channelInput = {
        kind: requested.isThread()
          ? (requested.type === ChannelType.PrivateThread ? 'private_thread' : 'public_thread')
          : 'guild_channel',
        id: requested.id,
        permissionChannelId: permissionChannel.id,
        ...(requested.isThread() ? { parentChannelId: permissionChannel.id } : {}),
        overwritesComplete: true,
        everyoneOverwrite: everyoneOverwrite ? toPermissionPair(everyoneOverwrite) : null,
        roleOverwrites: overwrites
          .filter(overwrite => overwrite.type === OverwriteType.Role && overwrite.id !== guild.id)
          .map(overwrite => ({ roleId: overwrite.id, ...toPermissionPair(overwrite) }))
          .sort((left, right) => left.roleId.localeCompare(right.roleId)),
        memberOverwrite: memberOverwrite ? toPermissionPair(memberOverwrite) : null,
      };
      if (requested.isThread() && requested.type === ChannelType.PrivateThread) {
        let threadMember: boolean;
        try {
          await requested.members.fetch(input.providerSubjectId);
          threadMember = true;
        } catch (error) {
          if (discordApiErrorCode(error) !== 10_007) throw error;
          threadMember = false;
        }
        observations.push({
          ...base,
          channel: { ...channelInput, threadMembershipObserved: true, threadMember },
        });
      } else {
        observations.push({ ...base, channel: channelInput });
      }
    }
    return {
      status: 'observed',
      providerSubjectId: input.providerSubjectId,
      observedAt,
      observationId: randomUUID(),
      botUserId,
      targets: observations,
    };
  }
}
