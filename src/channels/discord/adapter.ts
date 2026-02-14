import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type TextChannel,
} from 'discord.js';
import type { SubstrateMessage, SubstrateConfig } from '../../types.js';
import type { MessageHandler, ChannelAdapter } from '../types.js';
import type { EventBus } from '../../event-bus.js';
import { createComponentLogger } from '../../logger.js';

const log = createComponentLogger('Discord');

const TYPING_INTERVAL_MS = 9_000;
const MAX_DISCORD_LENGTH = 2000;

export class DiscordAdapter implements ChannelAdapter {
  readonly name = 'discord';

  private client: Client;
  private config: SubstrateConfig;
  private eventBus: EventBus;
  private handler: MessageHandler | null = null;
  private processing = new Set<string>();

  constructor(config: SubstrateConfig, eventBus: EventBus) {
    this.config = config;
    this.eventBus = eventBus;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
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
  }

  async start(): Promise<void> {
    if (!this.config.discordToken) {
      throw new Error('DISCORD_TOKEN is required');
    }
    await this.client.login(this.config.discordToken);
  }

  async stop(): Promise<void> {
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

    // Per-channel serialization — skip if already processing this channel
    const channelId = msg.channelId;
    if (this.processing.has(channelId)) return;
    this.processing.add(channelId);

    // Start typing indicator
    const typingInterval = this.startTyping(msg);

    try {
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
