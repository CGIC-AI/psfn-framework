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
    this.on(Events.GuildAvailable, guild => { this.emitObserverCurrent(guild.id); });
    this.on(Events.GuildCreate, guild => { this.emitObserverCurrent(guild.id); });
    this.on(Events.GuildDelete, guild => { this.emitObserverUnavailable(guild.id); });
    this.on(Events.GuildUnavailable, guild => { this.emitObserverUnavailable(guild.id); });
    this.on(Events.GuildUpdate, (_oldGuild, guild) => {
      this.emit({ kind: 'guild', guildId: guild.id });
    });
    this.on(Events.GuildMemberAdd, member => {
      this.emitMemberOrObserver(member.guild.id, member.id, 'current');
    });
    this.on(Events.GuildMemberAvailable, member => {
      this.emitMemberOrObserver(member.guild.id, member.id, 'current');
    });
    this.on(Events.GuildMemberRemove, member => {
      this.emitMemberOrObserver(member.guild.id, member.id, 'unavailable');
    });
    this.on(Events.GuildMemberUpdate, (_oldMember, member) => {
      this.emitMemberOrObserver(member.guild.id, member.id, 'current');
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
      this.emitMemberOrObserver(member.thread.guildId, member.id, 'current');
    });
    this.on(Events.ThreadMembersUpdate, (added, removed, thread) => {
      for (const member of [...added.values(), ...removed.values()]) {
        this.emitMemberOrObserver(
          thread.guildId,
          member.id,
          removed.has(member.id) ? 'unavailable' : 'current',
        );
      }
      this.emitThread(thread.guildId, thread.id);
    });
    this.on(Events.Invalidated, () => { this.emitObserverUnavailable(); });
    this.on(Events.ShardDisconnect, () => { this.emitObserverUnavailable(); });
    this.on(Events.ShardError, () => { this.emitObserverUnavailable(); });
    this.on(Events.ShardReconnecting, () => { this.emitObserverUnavailable(); });
    this.on(Events.ShardReady, () => { this.emit({ kind: 'ready' }); });
    this.on(Events.ShardResume, () => { this.emit({ kind: 'ready' }); });
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

  private emitMemberOrObserver(
    guildId: string,
    providerSubjectId: string,
    observerAvailability: 'current' | 'unavailable',
  ): void {
    if (providerSubjectId === this.client.user?.id) {
      this.emit({ kind: 'observer', availability: observerAvailability, guildId });
      return;
    }
    this.emit({ kind: 'member', guildId, providerSubjectId });
  }

  private emitObserverCurrent(guildId: string): void {
    this.emit({ kind: 'observer', availability: 'current', guildId });
  }

  private emitObserverUnavailable(guildId?: string): void {
    this.emit({
      kind: 'observer',
      availability: 'unavailable',
      ...(guildId ? { guildId } : {}),
    });
  }

  private emitThread(guildId: string, channelId: string): void {
    this.emit({ kind: 'channel', guildId, channelId });
  }

  private emit(event: DiscordEvidenceAuthorityChange): void {
    for (const listener of this.listeners) listener(event);
  }
}
