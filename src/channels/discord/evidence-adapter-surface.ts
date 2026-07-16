import {
  Client,
  GatewayIntentBits,
  Partials,
} from 'discord.js';
import type {
  DiscordCompanionEvidenceObserverPort,
  DiscordEvidenceLifecycleEventSourcePort,
} from '../../boundary/fleet-auth/discord-evidence-types.js';
import { DiscordEvidenceLifecycleEventSource } from './evidence-lifecycle-events.js';
import { DiscordEvidenceObserver } from './evidence-observer.js';

/** Focused Discord-adapter boundary for fleet-auth evidence observation and invalidation. */
export class DiscordEvidenceAdapterSurface implements
  DiscordCompanionEvidenceObserverPort,
  DiscordEvidenceLifecycleEventSourcePort {
  private readonly events: DiscordEvidenceLifecycleEventSource | null;
  private readonly observer: DiscordEvidenceObserver;

  constructor(client: Client, enabled: boolean) {
    this.events = enabled ? new DiscordEvidenceLifecycleEventSource(client) : null;
    this.observer = new DiscordEvidenceObserver(client);
  }

  attach(): void {
    this.events?.attach();
  }

  subscribeDiscordEvidenceLifecycle(
    listener: Parameters<DiscordEvidenceLifecycleEventSourcePort['subscribeDiscordEvidenceLifecycle']>[0],
  ): () => void {
    if (!this.events) {
      throw new Error('Discord evidence lifecycle events are disabled for this adapter');
    }
    return this.events.subscribeDiscordEvidenceLifecycle(listener);
  }

  async observeDiscordEvidence(
    input: Parameters<DiscordCompanionEvidenceObserverPort['observeDiscordEvidence']>[0],
  ): Promise<unknown> {
    return await this.observer.observe(input);
  }

  close(): void {
    this.events?.close();
  }
}

/** Creates the Discord client and its evidence surface from one intent/partial composition. */
export function createDiscordClient(
  enableEvidenceLifecycle: boolean,
): [Client, DiscordEvidenceAdapterSurface] {
  const intents = [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions,
  ];
  const partials = [Partials.Channel, Partials.Message, Partials.Reaction];
  if (enableEvidenceLifecycle) {
    intents.push(GatewayIntentBits.GuildMembers);
    partials.push(Partials.GuildMember, Partials.ThreadMember);
  }
  const client = new Client({ intents, partials });
  return [client, new DiscordEvidenceAdapterSurface(client, enableEvidenceLifecycle)];
}
