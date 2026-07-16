import { EventEmitter } from 'node:events';
import { Events, type Client } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { DiscordEvidenceAuthorityChange } from '../../boundary/fleet-auth/discord-evidence-types.js';
import { DiscordEvidenceLifecycleEventSource } from './evidence-lifecycle-events.js';

const BOT_ID = '100000000000000001';
const HUMAN_ID = '100000000000000002';
const GUILD_ID = '100000000000000003';

describe('Discord observer authority event source', () => {
  it('distinguishes the bound bot from human subjects and reports transport loss', () => {
    const emitter = Object.assign(new EventEmitter(), { user: { id: BOT_ID } });
    const source = new DiscordEvidenceLifecycleEventSource(emitter as unknown as Client);
    const observed: DiscordEvidenceAuthorityChange[] = [];
    source.subscribeDiscordEvidenceLifecycle(event => { observed.push(event); });
    source.attach();

    emitter.emit(Events.GuildMemberUpdate, {}, { id: BOT_ID, guild: { id: GUILD_ID } });
    emitter.emit(Events.GuildMemberUpdate, {}, { id: HUMAN_ID, guild: { id: GUILD_ID } });
    emitter.emit(Events.GuildMemberRemove, { id: BOT_ID, guild: { id: GUILD_ID } });
    emitter.emit(Events.GuildUnavailable, { id: GUILD_ID });
    emitter.emit(Events.ShardDisconnect, {}, 0);
    emitter.emit(Events.ShardReady, 0, undefined);

    expect(observed).toEqual([
      { kind: 'observer', availability: 'current', guildId: GUILD_ID },
      { kind: 'member', guildId: GUILD_ID, providerSubjectId: HUMAN_ID },
      { kind: 'observer', availability: 'unavailable', guildId: GUILD_ID },
      { kind: 'observer', availability: 'unavailable', guildId: GUILD_ID },
      { kind: 'observer', availability: 'unavailable' },
      { kind: 'ready' },
    ]);
    source.close();
  });
});
