import { Events, type Client } from 'discord.js';
import type {
  DiscordEvidenceAuthorityChange,
  DiscordEvidenceLifecycleEventSourcePort,
} from '../../boundary/fleet-auth/discord-evidence-types.js';

/** Translates discord.js cache invalidation events into bounded authority-change notices. */
export class DiscordEvidenceLifecycleEventSource implements DiscordEvidenceLifecycleEventSourcePort {
  private readonly listeners = new Set<(event: DiscordEvidenceAuthorityChange) => void>();
  private readonly detach: Array<() => void> = [];
  private attached = false;

  constructor(private readonly client: Client) {}

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.on(Events.ClientReady, () => { this.emit({ kind: 'ready' }); });
    this.on(Events.GuildAvailable, guild => { this.emit({ kind: 'guild', guildId: guild.id }); });
    this.on(Events.GuildCreate, guild => { this.emit({ kind: 'guild', guildId: guild.id }); });
    this.on(Events.GuildDelete, guild => { this.emit({ kind: 'guild', guildId: guild.id }); });
    this.on(Events.GuildUnavailable, guild => { this.emit({ kind: 'guild', guildId: guild.id }); });
    this.on(Events.GuildUpdate, (_oldGuild, guild) => {
      this.emit({ kind: 'guild', guildId: guild.id });
    });
    this.on(Events.GuildMemberAdd, member => { this.emitMember(member.guild.id, member.id); });
    this.on(Events.GuildMemberAvailable, member => { this.emitMember(member.guild.id, member.id); });
    this.on(Events.GuildMemberRemove, member => { this.emitMember(member.guild.id, member.id); });
    this.on(Events.GuildMemberUpdate, (_oldMember, member) => {
      this.emitMember(member.guild.id, member.id);
    });
    this.on(Events.GuildRoleCreate, role => { this.emit({ kind: 'guild', guildId: role.guild.id }); });
    this.on(Events.GuildRoleDelete, role => { this.emit({ kind: 'guild', guildId: role.guild.id }); });
    this.on(Events.GuildRoleUpdate, (_oldRole, role) => {
      this.emit({ kind: 'guild', guildId: role.guild.id });
    });
    this.on(Events.ChannelCreate, channel => {
      this.emit({ kind: 'channel', guildId: channel.guildId, channelId: channel.id });
    });
    this.on(Events.ChannelDelete, (channel) => {
      if (!channel.isDMBased()) {
        this.emit({ kind: 'channel', guildId: channel.guildId, channelId: channel.id });
      }
    });
    this.on(Events.ChannelUpdate, (_oldChannel, channel) => {
      if (!channel.isDMBased()) {
        this.emit({ kind: 'channel', guildId: channel.guildId, channelId: channel.id });
      }
    });
    this.on(Events.ThreadCreate, thread => { this.emitThread(thread.guildId, thread.id); });
    this.on(Events.ThreadDelete, thread => { this.emitThread(thread.guildId, thread.id); });
    this.on(Events.ThreadUpdate, (_oldThread, thread) => {
      this.emitThread(thread.guildId, thread.id);
    });
    this.on(Events.ThreadMemberUpdate, (_oldMember, member) => {
      this.emitMember(member.thread.guildId, member.id);
    });
    this.on(Events.ThreadMembersUpdate, (added, removed, thread) => {
      for (const member of [...added.values(), ...removed.values()]) {
        this.emitMember(thread.guildId, member.id);
      }
      this.emitThread(thread.guildId, thread.id);
    });
  }

  subscribeDiscordEvidenceLifecycle(
    listener: (event: DiscordEvidenceAuthorityChange) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  close(): void {
    for (const detach of this.detach.splice(0)) detach();
    this.listeners.clear();
    this.attached = false;
  }

  private on<K extends keyof import('discord.js').ClientEvents>(
    event: K,
    listener: (...args: import('discord.js').ClientEvents[K]) => void,
  ): void {
    this.client.on(event, listener);
    this.detach.push(() => { this.client.off(event, listener); });
  }

  private emitMember(guildId: string, providerSubjectId: string): void {
    this.emit({ kind: 'member', guildId, providerSubjectId });
  }

  private emitThread(guildId: string, channelId: string): void {
    this.emit({ kind: 'channel', guildId, channelId });
  }

  private emit(event: DiscordEvidenceAuthorityChange): void {
    for (const listener of this.listeners) listener(event);
  }
}
