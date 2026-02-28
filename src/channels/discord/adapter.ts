import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type TextChannel,
  type User,
  type PartialUser,
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

const TYPING_INTERVAL_MS = 5_000;
const MAX_DISCORD_LENGTH = 2000;
const STARTUP_BACKFILL_LIMIT = 100;
const BACKFILL_DEDUP_WINDOW = 500;
const DISCORD_CHANNEL_ID_PATTERN = /^\d{15,22}$/;
const DEFAULT_TRIGGER_LISTEN_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
const LISTEN_WINDOW_LOG_INTERVAL_MS = 10_000;
const IGNORE_PREFIX = '!i';
const DELETE_EMOJI = '❌';
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
  private botDisplayNames: string[] = [];
  private processing = new Set<string>();
  private lockStartedAt = new Map<string, number>();
  private lockContention = new Map<string, number>();
  private voice: DiscordVoiceRuntime;
  private statusMessages = new Map<string, Message>();
  private statusUnsubscribers: Array<() => void> = [];
  /** Per-user listening windows: key = `channelId:userId`, value = expiry timestamp */
  private listeningWindows = new Map<string, number>();
  private listenWindowTimers = new Map<string, ReturnType<typeof setInterval>>();

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
        GatewayIntentBits.GuildMessageReactions,
      ],
      partials: [Partials.Message, Partials.Reaction],
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

    this.client.on(Events.MessageReactionAdd, (reaction, user) => {
      this.onReactionAdd(reaction, user).catch(err => {
        log.error('Reaction handling error', { error: String(err) });
      });
    });

    this.client.once(Events.ClientReady, (c) => {
      log.info(`Logged in as ${c.user.tag}`);
      // Capture bot display names for trigger word matching
      const names = new Set<string>();
      if (c.user.username) names.add(c.user.username.toLowerCase());
      if (c.user.displayName && c.user.displayName !== c.user.username) names.add(c.user.displayName.toLowerCase());
      // Also grab the global name (the one users see)
      if (c.user.globalName) names.add(c.user.globalName.toLowerCase());
      this.botDisplayNames = [...names].filter(n => n.length > 1);
      if (this.botDisplayNames.length > 0) {
        log.info('Bot name triggers registered', { names: this.botDisplayNames });
      }
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
    for (const key of this.listenWindowTimers.keys()) this.clearListenWindowTimer(key);
    this.listeningWindows.clear();
    await this.clearAllStatusMessages();
    await this.voice.stop();
    this.client.destroy();
  }

  isConnected(): boolean {
    return this.client.isReady();
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

    const isDM = !msg.guild;
    const channelId = msg.channelId;
    const userId = msg.author.id;

    // Check !i ignore prefix — skip even during active listening
    if (!isDM && msg.content.trimStart().startsWith(IGNORE_PREFIX)) return;

    // Determine why we should respond
    const isMentioned = msg.mentions.has(this.runtimeConfig.discordBotId);
    const isTriggered = !isDM && !isMentioned && this.matchesTriggerWord(msg.content);
    const listenKey = `${channelId}:${userId}`;
    const isListening = this.isInListeningWindow(listenKey);

    if (!isDM && !isMentioned && !isTriggered && !isListening) return;

    // Open or extend listening window for this user in this channel
    if (!isDM && (isTriggered || isListening || isMentioned)) {
      this.openListeningWindow(listenKey);
    }

    if (isTriggered) log.info('Trigger word matched', { channelId, messageId: msg.id });
    if (isListening && !isTriggered && !isMentioned) log.debug('Active listening window', { channelId, userId });

    // Strip bot mention from content
    let content = msg.content
      .replace(new RegExp(`<@!?${this.runtimeConfig.discordBotId}>`, 'g'), '')
      .trim();
    if (!content) content = '(empty message)';

    // Only quote-reply on the initial trigger, not during listening window follow-ups
    const shouldQuote = isTriggered;

    await this.processMessage(msg, channelId, {
      id: msg.id,
      channelId,
      channelType: 'discord',
      isDirectMessage: isDM,
      authorId: userId,
      authorName: msg.author.displayName ?? msg.author.username,
      content,
      timestamp: msg.createdAt,
    }, shouldQuote);
  }

  private async onReactionAdd(
    reaction: MessageReaction | PartialMessageReaction,
    user: User | PartialUser,
  ): Promise<void> {
    // Ignore reactions from self or bots
    if (user.id === this.runtimeConfig.discordBotId) return;
    if (user.bot) return;

    const emojiName = reaction.emoji.name ?? '';

    // ❌ on bot's own message → delete it
    if (emojiName === DELETE_EMOJI) {
      const fullReaction = reaction.partial ? await reaction.fetch() : reaction;
      const msg = fullReaction.message.partial ? await fullReaction.message.fetch() : fullReaction.message;
      if (msg.author.id === this.runtimeConfig.discordBotId) {
        log.info('Delete reaction on bot message', { messageId: msg.id, channelId: msg.channelId, requestedBy: user.id });
        await msg.delete().catch(err => log.warn('Failed to delete bot message', { error: String(err) }));
      }
      return;
    }

    if (!this.handler) return;

    // Check if this reaction is a configured trigger
    const triggerReactions = this.runtimeConfig.discordTriggerReactions ?? [];
    if (triggerReactions.length === 0) return;

    const emojiId = reaction.emoji.id ? `<:${emojiName}:${reaction.emoji.id}>` : emojiName;
    const isMatch = triggerReactions.some(trigger =>
      trigger === emojiName || trigger === emojiId
    );
    if (!isMatch) return;

    // Fetch partial reaction/message if needed
    const fullReaction = reaction.partial ? await reaction.fetch() : reaction;
    const msg = fullReaction.message.partial ? await fullReaction.message.fetch() : fullReaction.message;

    // Don't respond to bot's own messages
    if (msg.author.id === this.runtimeConfig.discordBotId) return;
    if (msg.author.bot) return;

    const channelId = msg.channelId;
    let content = msg.content?.trim() || '(empty message)';

    log.info('Reaction trigger matched', { emoji: emojiName, channelId, messageId: msg.id, reactedBy: user.id });

    // Open listening window for the message author (the person being pointed at)
    this.openListeningWindow(`${channelId}:${msg.author.id}`);
    // Also open for the reactor if different
    if (user.id !== msg.author.id) {
      this.openListeningWindow(`${channelId}:${user.id}`);
    }

    await this.processMessage(msg as Message, channelId, {
      id: msg.id,
      channelId,
      channelType: 'discord',
      isDirectMessage: false,
      authorId: msg.author.id,
      authorName: msg.author.displayName ?? msg.author.username,
      content,
      timestamp: msg.createdAt,
    }, true, fullReaction);
  }

  /**
   * Core message processing: lock channel, call handler, send response.
   * When `replyToOriginal` is true, the bot replies (quotes) the triggering message.
   */
  private async processMessage(
    msg: Message,
    channelId: string,
    substrateMsg: SubstrateMessage,
    replyToOriginal: boolean,
    triggerReaction?: MessageReaction | PartialMessageReaction,
  ): Promise<void> {
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

    // Remove the trigger reaction so the user knows the bot acknowledged it
    if (triggerReaction) {
      triggerReaction.remove().catch(() => undefined);
    }

    try {
      await this.eventBus.emit('message.received', { message: substrateMsg });

      const response = await this.handler(substrateMsg);
      const hasText = response.content.trim().length > 0;
      if (hasText) {
        if (replyToOriginal) {
          // Reply (quote) the original message for trigger-based responses
          const chunks = splitMessage(response.content.trim());
          // First chunk replies (quotes), rest are follow-ups in channel
          await msg.reply(chunks[0]);
          for (let i = 1; i < chunks.length; i++) {
            await (msg.channel as TextChannel).send(chunks[i]);
          }
        } else {
          await this.outbound.sendText({ channelId }, response.content);
        }
        await this.eventBus.emit('message.sent', { response });
      } else {
        log.debug('Suppressing empty handler response for Discord channel', { channelId });
      }

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

  private matchesTriggerWord(content: string): boolean {
    const lowerContent = content.toLowerCase();
    // Check configured trigger words
    const triggerWords = this.runtimeConfig.discordTriggerWords;
    if (triggerWords && triggerWords.some(word => lowerContent.includes(word.toLowerCase()))) {
      return true;
    }
    // Check bot display names (username, globalName)
    if (this.botDisplayNames.some(name => lowerContent.includes(name))) {
      return true;
    }
    return false;
  }

  private isInListeningWindow(key: string): boolean {
    const expiry = this.listeningWindows.get(key);
    if (!expiry) return false;
    if (Date.now() > expiry) {
      this.listeningWindows.delete(key);
      this.clearListenWindowTimer(key);
      return false;
    }
    return true;
  }

  private get triggerListenWindowMs(): number {
    return this.runtimeConfig.discordTriggerListenWindowMs ?? DEFAULT_TRIGGER_LISTEN_WINDOW_MS;
  }

  private openListeningWindow(key: string): void {
    const windowMs = this.triggerListenWindowMs;
    this.listeningWindows.set(key, Date.now() + windowMs);

    // (Re)start the countdown logger
    this.clearListenWindowTimer(key);
    const timer = setInterval(() => {
      const expiry = this.listeningWindows.get(key);
      if (!expiry) { this.clearListenWindowTimer(key); return; }
      const remainingMs = expiry - Date.now();
      if (remainingMs <= 0) {
        this.listeningWindows.delete(key);
        this.clearListenWindowTimer(key);
        log.info('Listening window expired', { key });
        return;
      }
      log.info('Listening window active', { key, remainingSeconds: Math.ceil(remainingMs / 1000) });
    }, LISTEN_WINDOW_LOG_INTERVAL_MS);
    this.listenWindowTimers.set(key, timer);
  }

  private clearListenWindowTimer(key: string): void {
    const timer = this.listenWindowTimers.get(key);
    if (timer) {
      clearInterval(timer);
      this.listenWindowTimers.delete(key);
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
