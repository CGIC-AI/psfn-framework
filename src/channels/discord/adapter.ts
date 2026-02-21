import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  type TextChannel,
} from 'discord.js';
import type { SubstrateMessage, SubstrateConfig } from '../../types.js';
import type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelConfigAdapter,
  ChannelGatewayAdapter,
  ChannelOutboundAdapter,
  ChannelPromptAdapter,
  ChannelSecurityAdapter,
  ChannelStreamingAdapter,
  ChannelThreadingAdapter,
  MessageHandler,
  OutboundContext,
} from '../types.js';
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
type StatusKind = 'compaction' | 'retry';
type QueueTelemetryPhase = 'acquired' | 'contended' | 'released';

interface DiscordAdapterOptions {
  sessionStore?: SessionStore;
}

export class DiscordAdapter implements ChannelAdapter {
  readonly id = 'discord';
  readonly name = this.id;
  readonly meta = {
    label: 'Discord',
    emoji: ':speech_balloon:',
  };
  readonly capabilities: ChannelCapabilities = {
    chatTypes: ['direct', 'channel', 'thread'],
    media: true,
    reactions: true,
    threads: true,
    streaming: true,
    promptChannelType: 'discord_text',
  };
  readonly config: ChannelConfigAdapter;
  readonly outbound: ChannelOutboundAdapter;
  readonly gateway: ChannelGatewayAdapter;
  readonly security: ChannelSecurityAdapter;
  readonly streaming: ChannelStreamingAdapter;
  readonly threading: ChannelThreadingAdapter;
  readonly prompt: ChannelPromptAdapter;

  private client: Client;
  private runtimeConfig: SubstrateConfig;
  private eventBus: EventBus;
  private sessionStore: SessionStore | null;
  private handler: MessageHandler | null = null;
  private voiceHandler: MessageHandler | null = null;
  private agent: SubstrateAgent | null = null;
  private processing = new Set<string>();
  private lockStartedAt = new Map<string, number>();
  private lockContention = new Map<string, number>();
  private voice: DiscordVoiceRuntime;
  private statusMessages = new Map<string, Message>();
  private statusUnsubscribers: Array<() => void> = [];

  constructor(config: SubstrateConfig, eventBus: EventBus, options: DiscordAdapterOptions = {}) {
    this.runtimeConfig = config;
    this.eventBus = eventBus;
    this.sessionStore = options.sessionStore ?? null;
    this.config = {
      enabled: Boolean(config.discordToken),
      accountId: config.discordBotId || undefined,
      connectionLabel: 'discord',
    };
    this.outbound = {
      textChunkLimit: MAX_DISCORD_LENGTH,
      sendText: async (ctx: OutboundContext, text: string): Promise<void> => {
        await this.send(ctx.channelId, text);
      },
    };
    this.gateway = this;
    this.security = {
      supportsDirectMessages: true,
      requiresMentionForChannelMessages: true,
    };
    this.streaming = {
      typingIntervalMs: TYPING_INTERVAL_MS,
      sendTyping: async (channelId: string): Promise<void> => {
        await this.sendTypingToChannel(channelId);
      },
    };
    this.threading = {
      toThreadChannelId: (channelId: string, threadId: string): string => `${channelId}:${threadId}`,
      fromThreadChannelId: (channelId: string): string | null => {
        const idx = channelId.indexOf(':');
        if (idx <= 0 || idx >= channelId.length - 1) return null;
        return channelId.slice(idx + 1);
      },
    };
    this.prompt = {
      resolveChannelType: (message: SubstrateMessage): string | undefined => {
        if (message.channelId.startsWith('discord-voice:')) return 'discord_voice';
        return 'discord_text';
      },
    };
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
    this.registerStatusListeners();
  }

  async start(): Promise<void> {
    if (!this.runtimeConfig.discordToken) {
      throw new Error('DISCORD_TOKEN is required');
    }
    await this.client.login(this.runtimeConfig.discordToken);
    if (this.runtimeConfig.discordBackfillOnStartup !== false) {
      await this.backfillOnStartup();
    }
  }

  async stop(): Promise<void> {
    for (const unsub of this.statusUnsubscribers) unsub();
    this.statusUnsubscribers = [];
    await this.clearAllStatusMessages();
    await this.voice.stop();
    this.client.destroy();
  }

  async send(channelId: string, content: string): Promise<void> {
    const normalized = content.trim();
    if (!normalized) {
      log.debug('Skipping empty Discord send', { channelId });
      return;
    }

    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;

    const chunks = splitMessage(normalized);
    for (const chunk of chunks) {
      await (channel as TextChannel).send(chunk);
    }
  }

  private async onDiscordMessage(msg: Message): Promise<void> {
    // Ignore self
    if (msg.author.id === this.runtimeConfig.discordBotId) return;
    if (msg.author.bot) return;
    if (!this.handler) return;

    // Respond to DMs always, guild messages only when mentioned
    const isDM = !msg.guild;
    const isMentioned = msg.mentions.has(this.runtimeConfig.discordBotId);
    if (!isDM && !isMentioned) return;

    const channelId = msg.channelId;

    // Strip bot mention from content
    let content = msg.content
      .replace(new RegExp(`<@!?${this.runtimeConfig.discordBotId}>`, 'g'), '')
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
      const lockStartMs = this.lockStartedAt.get(channelId) ?? Date.now();
      const queueDepth = (this.lockContention.get(channelId) ?? 0) + 1;
      this.lockContention.set(channelId, queueDepth);
      this.emitQueueTelemetry(channelId, 'contended', {
        queueDepth,
        waitMs: Math.max(0, Date.now() - lockStartMs),
      });
      if (this.agent) {
        log.debug('Steering message into active stream', { channelId });
        this.agent.steer(substrateMsg);
      }
      return;
    }

    this.processing.add(channelId);
    const lockStartMs = Date.now();
    this.lockStartedAt.set(channelId, lockStartMs);
    this.lockContention.set(channelId, 0);
    this.emitQueueTelemetry(channelId, 'acquired', {
      queueDepth: 0,
      waitMs: 0,
    });

    // Start typing indicator
    const typingInterval = this.startTyping(msg);
    this.clearStatus(channelId, 'compaction').catch(() => undefined);
    this.clearStatus(channelId, 'retry').catch(() => undefined);

    try {
      await this.eventBus.emit('message.received', { message: substrateMsg });

      const response = await this.handler(substrateMsg);

      if (response.content.trim()) {
        await this.outbound.sendText({ channelId }, response.content);
      } else {
        log.debug('Suppressing empty handler response for Discord channel', { channelId });
      }
      await this.eventBus.emit('message.sent', { response });

    } catch (error) {
      log.error('Error processing message', { error: String(error) });
      try {
        await msg.reply('Something went wrong. Please try again.');
      } catch { /* ignore reply errors */ }
    } finally {
      clearInterval(typingInterval);
      this.processing.delete(channelId);
      const lockHeldMs = Math.max(0, Date.now() - lockStartMs);
      this.emitQueueTelemetry(channelId, 'released', {
        queueDepth: this.lockContention.get(channelId) ?? 0,
        waitMs: lockHeldMs,
      });
      this.lockStartedAt.delete(channelId);
      this.lockContention.delete(channelId);
      await this.clearStatus(channelId, 'compaction');
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

  private emitQueueTelemetry(
    channelId: string,
    phase: QueueTelemetryPhase,
    details: { queueDepth: number; waitMs: number },
  ): void {
    const telemetry = {
      channelId,
      phase,
      queueDepth: details.queueDepth,
      waitMs: details.waitMs,
      processingChannels: this.processing.size,
      timestamp: Date.now(),
    };
    log.debug('Queue lock telemetry', telemetry);
    const telemetryBus = this.eventBus as unknown as {
      emit: (event: string, payload: Record<string, unknown>) => Promise<void>;
    };
    telemetryBus.emit('channel.queue.telemetry', telemetry).catch(() => undefined);
  }

  private registerStatusListeners(): void {
    if (this.statusUnsubscribers.length > 0) return;

    this.statusUnsubscribers.push(this.eventBus.on('agent.compaction.start', async ({
      channelId,
      tokensBefore,
      tokenBudget,
    }) => {
      if (!this.processing.has(channelId)) return;
      log.debug('Compaction started', { channelId, tokensBefore, tokenBudget });
      await this.sendTypingToChannel(channelId);
      await this.setStatus(
        channelId,
        'compaction',
        'Organizing context to stay within token budget...',
      );
    }));

    this.statusUnsubscribers.push(this.eventBus.on('agent.compaction.end', async ({
      channelId,
      tokensBefore,
      tokensAfter,
    }) => {
      if (!this.processing.has(channelId)) return;
      log.debug('Compaction finished', { channelId, tokensBefore, tokensAfter });
      await this.clearStatus(channelId, 'compaction');
    }));

    this.statusUnsubscribers.push(this.eventBus.on('agent.retry.start', async ({
      channelId,
      attempt,
      maxAttempts,
      delayMs,
      error,
    }) => {
      if (!this.processing.has(channelId)) return;
      const delaySec = (delayMs / 1000).toFixed(1);
      log.warn('LLM retry scheduled', { channelId, attempt, maxAttempts, delayMs, error });
      await this.sendTypingToChannel(channelId);
      await this.setStatus(
        channelId,
        'retry',
        `Connection hiccup, retrying (${attempt}/${maxAttempts}) in ${delaySec}s...`,
      );
    }));

    this.statusUnsubscribers.push(this.eventBus.on('agent.retry.end', async ({
      channelId,
      success,
      attempt,
    }) => {
      if (!this.processing.has(channelId)) return;
      log.debug('LLM retry finished', { channelId, success, attempt });
      if (success) {
        await this.clearStatus(channelId, 'retry');
      } else {
        await this.setStatus(
          channelId,
          'retry',
          'Having trouble reaching my thoughts. Please try again.',
        );
      }
    }));
  }

  private async sendTypingToChannel(channelId: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      if (!channel?.isTextBased()) return;
      if ('sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch {
      // Ignore typing errors (permissions/network/transient fetch failures)
    }
  }

  private statusKey(channelId: string, kind: StatusKind): string {
    return `${channelId}:${kind}`;
  }

  private async setStatus(channelId: string, kind: StatusKind, content: string): Promise<void> {
    const key = this.statusKey(channelId, kind);
    const existing = this.statusMessages.get(key);
    if (existing) {
      try {
        await existing.edit(content);
        return;
      } catch {
        this.statusMessages.delete(key);
      }
    }

    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;
    try {
      const sent = await (channel as TextChannel).send(content);
      this.statusMessages.set(key, sent as Message);
    } catch {
      // Ignore status send failures to avoid breaking primary response path
    }
  }

  private async clearStatus(channelId: string, kind: StatusKind): Promise<void> {
    const key = this.statusKey(channelId, kind);
    const existing = this.statusMessages.get(key);
    if (!existing) return;
    this.statusMessages.delete(key);
    try {
      await existing.delete();
    } catch {
      // Ignore cleanup failures (already deleted / permission changes)
    }
  }

  private async clearAllStatusMessages(): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const message of this.statusMessages.values()) {
      pending.push(message.delete().catch(() => undefined));
    }
    this.statusMessages.clear();
    await Promise.allSettled(pending);
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
