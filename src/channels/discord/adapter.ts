import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type TextChannel,
} from 'discord.js';
import type { SubstrateMessage, SubstrateConfig } from '../../types.js';
import type { MessageHandler, ChannelAdapter } from '../types.js';
import type { SubstrateAgent } from '../../agent/substrate-agent.js';
import type { EventBus } from '../../event-bus.js';
import type { SessionStore } from '../../session/store.js';
import { createComponentLogger } from '../../logger.js';
import { DiscordVoiceRuntime } from './voice.js';

const log = createComponentLogger('Discord');

const TYPING_INTERVAL_MS = 9_000;
const MAX_DISCORD_LENGTH = 2000;
const STARTUP_BACKFILL_LIMIT = 100;
const BACKFILL_DEDUP_WINDOW = 500;
const DISCORD_CHANNEL_ID_PATTERN = /^\d{15,22}$/;

interface DiscordAdapterOptions {
  sessionStore?: SessionStore;
}

export class DiscordAdapter implements ChannelAdapter {
  readonly name = 'discord';

  private client: Client;
  private config: SubstrateConfig;
  private eventBus: EventBus;
  private sessionStore: SessionStore | null;
  private handler: MessageHandler | null = null;
  private voiceHandler: MessageHandler | null = null;
  private agent: SubstrateAgent | null = null;
  private processing = new Set<string>();
  private voice: DiscordVoiceRuntime;

  constructor(config: SubstrateConfig, eventBus: EventBus, options: DiscordAdapterOptions = {}) {
    this.config = config;
    this.eventBus = eventBus;
    this.sessionStore = options.sessionStore ?? null;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildVoiceStates,
      ],
    });

    this.voice = new DiscordVoiceRuntime({
      client: this.client,
      config,
      eventBus,
      getHandler: () => this.voiceHandler ?? this.handler,
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Set a separate handler for voice messages (e.g. reverse RPC to agent in gateway mode) */
  setVoiceHandler(handler: MessageHandler): void {
    this.voiceHandler = handler;
  }

  /** Set direct agent reference for steering support */
  setAgent(agent: SubstrateAgent): void {
    this.agent = agent;
    this.handler = (msg) => agent.handleMessage(msg);
  }

  async init(): Promise<void> {
    this.client.on(Events.MessageCreate, (msg) => {
      this.onDiscordMessage(msg).catch(err => {
        log.error('Message handling error', { error: String(err) });
      });
    });

    this.client.once(Events.ClientReady, (c) => {
      log.info(`Logged in as ${c.user.tag}`);
    });

    this.voice.init();
  }

  async start(): Promise<void> {
    if (!this.config.discordToken) {
      throw new Error('DISCORD_TOKEN is required');
    }
    await this.client.login(this.config.discordToken);
    if (this.config.discordBackfillOnStartup !== false) {
      await this.backfillOnStartup();
    }
  }

  async stop(): Promise<void> {
    await this.voice.stop();
    this.client.destroy();
  }

  async send(channelId: string, content: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;

    const chunks = splitMessage(content);
    for (const chunk of chunks) {
      await (channel as TextChannel).send(chunk);
    }
  }

  private async onDiscordMessage(msg: Message): Promise<void> {
    // Ignore self
    if (msg.author.id === this.config.discordBotId) return;
    if (msg.author.bot) return;
    if (!this.handler) return;

    // Respond to DMs always, guild messages only when mentioned
    const isDM = !msg.guild;
    const isMentioned = msg.mentions.has(this.config.discordBotId);
    if (!isDM && !isMentioned) return;

    const channelId = msg.channelId;

    // Strip bot mention from content
    let content = msg.content
      .replace(new RegExp(`<@!?${this.config.discordBotId}>`, 'g'), '')
      .trim();
    if (!content) content = '(empty message)';

    const substrateMsg: SubstrateMessage = {
      id: msg.id,
      channelId,
      channelType: 'discord',
      isDirectMessage: isDM,
      authorId: msg.author.id,
      authorName: msg.author.displayName ?? msg.author.username,
      content,
      timestamp: msg.createdAt,
    };

    // If already processing this channel, steer (interrupt) instead of dropping
    if (this.processing.has(channelId)) {
      if (this.agent) {
        log.debug('Steering message into active stream', { channelId });
        this.agent.steer(substrateMsg);
      }
      return;
    }
    this.processing.add(channelId);

    // Start typing indicator
    const typingInterval = this.startTyping(msg);

    try {
      await this.eventBus.emit('message.received', { message: substrateMsg });

      const response = await this.handler(substrateMsg);

      await this.send(channelId, response.content);
      await this.eventBus.emit('message.sent', { response });

    } catch (error) {
      log.error('Error processing message', { error: String(error) });
      try {
        await msg.reply('Something went wrong. Please try again.');
      } catch { /* ignore reply errors */ }
    } finally {
      clearInterval(typingInterval);
      this.processing.delete(channelId);
    }
  }

  private startTyping(msg: Message): ReturnType<typeof setInterval> {
    const channel = msg.channel;
    if ('sendTyping' in channel) {
      (channel as TextChannel).sendTyping().catch(() => {});
    }
    return setInterval(() => {
      if ('sendTyping' in channel) {
        (channel as TextChannel).sendTyping().catch(() => {});
      }
    }, TYPING_INTERVAL_MS);
  }

  private async backfillOnStartup(): Promise<void> {
    if (!this.sessionStore) return;

    const sessionChannelIds = this.sessionStore.listChannels()
      .filter(channel => channel.messageCount > 0)
      .map(channel => channel.channelId)
      .filter(channelId => this.toDiscordChannelId(channelId) !== null);

    for (const sessionChannelId of sessionChannelIds) {
      const discordChannelId = this.toDiscordChannelId(sessionChannelId);
      if (!discordChannelId) continue;

      try {
        const channel = await this.client.channels.fetch(discordChannelId);
        if (!channel?.isTextBased()) continue;

        const cursor = this.findBackfillCursor(sessionChannelId);
        const options: { limit: number; after?: string } = { limit: STARTUP_BACKFILL_LIMIT };
        if (cursor) options.after = cursor;

        const messages = await (channel as TextChannel).messages.fetch(options);
        if (messages.size === 0) continue;

        const dedupIds = this.sessionStore.getRecentDiscordMessageIds(sessionChannelId, BACKFILL_DEDUP_WINDOW);
        const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        for (const msg of sorted) {
          if (msg.author.bot) continue;
          if (dedupIds.has(msg.id)) continue;

          this.sessionStore.append({
            channelId: sessionChannelId,
            role: 'user',
            content: msg.content.trim() || '(empty message)',
            authorId: msg.author.id,
            authorName: msg.author.displayName ?? msg.author.username,
            timestamp: msg.createdTimestamp,
            discordMessageId: msg.id,
          });
          dedupIds.add(msg.id);
        }
      } catch (err) {
        log.warn('Discord startup backfill failed for channel', {
          channelId: sessionChannelId,
          error: String(err),
        });
      }
    }
  }

  private findBackfillCursor(sessionChannelId: string): string | undefined {
    const last = this.sessionStore?.getLastEntry(sessionChannelId);
    if (last?.discordMessageId) return last.discordMessageId;

    const recent = this.sessionStore?.getRecent(sessionChannelId, BACKFILL_DEDUP_WINDOW) ?? [];
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].discordMessageId) return recent[i].discordMessageId;
    }
    return undefined;
  }

  private toDiscordChannelId(sessionChannelId: string): string | null {
    if (sessionChannelId.startsWith('discord:')) {
      const value = sessionChannelId.slice('discord:'.length);
      return DISCORD_CHANNEL_ID_PATTERN.test(value) ? value : null;
    }
    return DISCORD_CHANNEL_ID_PATTERN.test(sessionChannelId) ? sessionChannelId : null;
  }
}

function splitMessage(content: string): string[] {
  if (content.length <= MAX_DISCORD_LENGTH) return [content];

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > MAX_DISCORD_LENGTH) {
    // Try to split at sentence boundary
    let splitIdx = remaining.lastIndexOf('. ', MAX_DISCORD_LENGTH - 1);
    if (splitIdx === -1 || splitIdx < MAX_DISCORD_LENGTH / 2) {
      // Try newline
      splitIdx = remaining.lastIndexOf('\n', MAX_DISCORD_LENGTH - 1);
    }
    if (splitIdx === -1 || splitIdx < MAX_DISCORD_LENGTH / 2) {
      // Try space
      splitIdx = remaining.lastIndexOf(' ', MAX_DISCORD_LENGTH - 1);
    }
    if (splitIdx === -1) {
      splitIdx = MAX_DISCORD_LENGTH - 1;
    }

    chunks.push(remaining.slice(0, splitIdx + 1));
    remaining = remaining.slice(splitIdx + 1);
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
